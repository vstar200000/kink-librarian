import { InteractionResponseFlags, InteractionResponseType } from 'discord-interactions';
import { setTimeout as delay } from 'node:timers/promises';
import {
  findItemEntries,
  formatRating,
  ListError,
  loadUserLists,
  selectUserList,
  validateList,
  verifyListAccess,
} from './list-utils.js';

class DiscordResponseError extends Error {
  constructor(status) {
    super(`Could not send check response: HTTP ${status}`);
    this.name = 'DiscordResponseError';
    this.status = status;
  }
}

async function lookup(interaction, channelId, signal) {
  const user = interaction.data?.options?.find(option => option.name === 'user')?.value;
  const item = interaction.data?.options?.find(option => option.name === 'item')?.value;
  const character = interaction.data?.options?.find(option => option.name === 'character')?.value;
  const guildId = interaction.guild_id;
  if (typeof guildId !== 'string' || typeof user !== 'string' ||
      !/^\d+$/.test(guildId) || !/^\d+$/.test(user) ||
      !interaction.data?.resolved?.members?.[user]) {
    throw new ListError('Choose a member of this server.');
  }
  if (typeof item !== 'string' || !item.trim()) throw new ListError('Enter an item name.');
  if (character !== undefined && (typeof character !== 'string' || !character.trim())) {
    throw new ListError('Enter a character name, or leave the character option blank.');
  }

  await verifyListAccess(guildId, channelId, signal);
  const lists = await loadUserLists(guildId, channelId, user, signal);
  if (!lists.unnamed && !lists.named.size) return 'No JSON attachment was found in this member’s forum posts.';
  const list = selectUserList(lists, character);
  validateList(list);
  const character_prepend = character ? `${character.trim()}, ` : ''; 
  const matches = findItemEntries(list, item)
    .map(({ item: entry }) => `${character_prepend}${item.trim()}: ${formatRating(entry.rating)}`);
  if (!matches.length) return 'The requested item was not found in this member’s list.';
  const result = matches.join('\n');
  if (result.length > 2000) throw new ListError('The matching ratings are too long to display in one response.');
  return result;
}

export async function completeCheck(interaction) {
  let content;
  try {
    content = await lookup(interaction, process.env.LIST_CHANNEL_ID, AbortSignal.timeout(60000));
  } catch (error) {
    if (error instanceof ListError) {
      content = error.message;
    } else if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      content = 'The list lookup timed out. Please try again later.';
    } else {
      console.error('Check lookup failed:', error.name);
      content = 'The bot could not read the list. Please try again or contact the bot administrator.';
    }
  }

  const signal = AbortSignal.timeout(10000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(
      `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
        signal,
      },
    );
    if (response.ok) return;
    if (response.status === 404 && attempt < 4) {
      await delay(250 * (2 ** attempt), undefined, { signal });
      continue;
    }
    if (response.status === 429 && attempt < 4) {
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 3) {
        await delay(retryAfter * 1000, undefined, { signal });
        continue;
      }
    }
    throw new DiscordResponseError(response.status);
  }
}

export async function handleCheck(interaction, res) {
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });
  try {
    await completeCheck(interaction);
  } catch (error) {
    console.error('Could not send check response:', error.name);
  }
}
