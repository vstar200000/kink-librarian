import { InteractionResponseFlags, InteractionResponseType } from 'discord-interactions';
import { setTimeout as delay } from 'node:timers/promises';
import { capitalize, DiscordApiError, DiscordRequest } from './utils.js';

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const ADMINISTRATOR = 1n << 3n;
const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);

class CheckError extends Error {}

class DiscordResponseError extends Error {
  constructor(status) {
    super(`Could not send check response: HTTP ${status}`);
    this.name = 'DiscordResponseError';
    this.status = status;
  }
}

async function getDiscordJson(endpoint, signal) {
  try {
    const response = await DiscordRequest(endpoint, { method: 'GET', signal });
    return await response.json();
  } catch (error) {
    if (error instanceof DiscordApiError) {
      if (error.status === 429) throw new CheckError('Discord rate limited the lookup. Please try again later.');
      if (error.status === 403) throw new CheckError('The bot cannot access the Discord resources needed to read the list.');
      if (error.status === 404) throw new CheckError('A Discord resource needed to read the list was not found.');
      throw new CheckError(`Discord returned an error while reading the list (HTTP ${error.status}).`);
    }
    throw error;
  }
}

function canReadHistory(guild, channel, roles, member, botId) {
  if (guild.owner_id === botId) return true;
  if (!Array.isArray(roles) || !Array.isArray(member.roles) ||
      !Array.isArray(channel.permission_overwrites)) {
    throw new CheckError('The bot could not verify its permissions in the list channel.');
  }

  const roleIds = new Set([guild.id, ...member.roles]);
  const matchingRoles = roles.filter(role => roleIds.has(role.id));
  if (matchingRoles.length !== roleIds.size) {
    throw new CheckError('The bot could not verify its permissions in the list channel.');
  }
  let permissions = matchingRoles.reduce((bits, role) => bits | BigInt(role.permissions), 0n);
  if (permissions & ADMINISTRATOR) return true;

  const overwrites = channel.permission_overwrites;
  const everyone = overwrites.find(overwrite => overwrite.type === 0 && overwrite.id === guild.id);
  if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === 0 && overwrite.id !== guild.id && roleIds.has(overwrite.id)) {
      roleAllow |= BigInt(overwrite.allow);
      roleDeny |= BigInt(overwrite.deny);
    }
  }
  permissions = (permissions & ~roleDeny) | roleAllow;

  const personal = overwrites.find(overwrite => overwrite.type === 1 && overwrite.id === botId);
  if (personal) permissions = (permissions & ~BigInt(personal.deny)) | BigInt(personal.allow);

  return (permissions & (VIEW_CHANNEL | READ_MESSAGE_HISTORY)) === (VIEW_CHANNEL | READ_MESSAGE_HISTORY);
}

async function findThreadUploads(threadId, userId, signal) {
  let before;
  const uploads = [];
  while (true) {
    const query = new URLSearchParams({ limit: '100' });
    if (before) query.set('before', before);
    const messages = await getDiscordJson(`channels/${threadId}/messages?${query}`, signal);
    if (!Array.isArray(messages)) throw new CheckError('The bot could not read the forum post history.');

    for (const message of messages) {
      if (message.author?.id !== userId || message.webhook_id) continue;
      if (!Array.isArray(message.attachments)) {
        throw new CheckError('The bot could not read attachments in the forum post.');
      }
      const files = message.attachments.filter(file => typeof file.filename === 'string' && /\.json$/i.test(file.filename));
      if (files.length) {
        if (typeof message.id !== 'string' || !/^\d+$/.test(message.id)) {
          throw new CheckError('The bot could not determine the latest forum upload.');
        }
        if (files.length > 1) {
          throw new CheckError('An upload contains multiple JSON attachments. Please upload one JSON file per message.');
        }
        uploads.push({ id: message.id, attachment: files[0] });
      }
    }
    if (messages.length < 100) return uploads;
    const next = messages[messages.length - 1]?.id;
    if (typeof next !== 'string' || !/^\d+$/.test(next) || next === before) {
      throw new CheckError('The bot could not page through the forum post history.');
    }
    before = next;
  }
}

async function findUploads(guildId, channelId, userId, signal) {
  const active = await getDiscordJson(`guilds/${guildId}/threads/active`, signal);
  if (!Array.isArray(active.threads)) throw new CheckError('The bot could not list active forum posts.');
  const threads = new Map();
  function addThreads(posts) {
    for (const post of posts) {
      if (post.parent_id !== channelId) continue;
      if (typeof post.id !== 'string' || !/^\d+$/.test(post.id) || typeof post.owner_id !== 'string') {
        throw new CheckError('The bot could not identify a forum post or its owner.');
      }
      if (post.owner_id === userId) threads.set(post.id, post);
    }
  }
  addThreads(active.threads);

  let before;
  while (true) {
    const query = new URLSearchParams({ limit: '100' });
    if (before) query.set('before', before);
    const archived = await getDiscordJson(`channels/${channelId}/threads/archived/public?${query}`, signal);
    if (!Array.isArray(archived.threads) || typeof archived.has_more !== 'boolean') {
      throw new CheckError('The bot could not list archived forum posts.');
    }
    addThreads(archived.threads);
    if (!archived.has_more) break;
    const timestamp = archived.threads[archived.threads.length - 1]?.thread_metadata?.archive_timestamp;
    const time = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    if (!Number.isFinite(time)) {
      throw new CheckError('The bot could not page through archived forum posts.');
    }
    // Overlap the boundary millisecond so equal archive timestamps are not skipped.
    const next = new Date(time + 1).toISOString();
    if (before && next >= before) {
      throw new CheckError('The bot could not page through archived forum posts.');
    }
    before = next;
  }

  const uploads = [];
  for (const thread of threads.values()) {
    for (const upload of await findThreadUploads(thread.id, userId, signal)) {
      uploads.push(upload);
    }
  }
  return uploads.sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0);
}

async function readList(attachment, signal) {
  if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAX_FILE_SIZE) {
    throw new CheckError('The JSON attachment is too large or has an invalid size (maximum 2 MiB).');
  }
  let url;
  try {
    url = new URL(attachment.url);
  } catch {
    throw new CheckError('The JSON attachment has an invalid download URL.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.discordapp.com' || url.username || url.password || url.port) {
    throw new CheckError('The JSON attachment has an invalid download URL.');
  }

  const response = await fetch(url, { signal, redirect: 'error' });
  if (response.status === 429) throw new CheckError('Discord rate limited the attachment download. Please try again later.');
  if (!response.ok || !response.body) {
    throw new CheckError('The JSON attachment could not be downloaded.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FILE_SIZE) {
      await reader.cancel();
      throw new CheckError('The JSON attachment is too large (maximum 2 MiB).');
    }
    chunks.push(value);
  }

  let list;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    list = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    throw new CheckError('The JSON attachment is malformed or is not valid UTF-8.');
  }
  return list;
}

function validateList(list) {
  const validText = value => typeof value === 'string' && value.trim().length > 0;
  const validRating = rating => {
    if (validText(rating)) return true;
    if (rating === null || typeof rating !== 'object' || Array.isArray(rating)) return false;
    const entries = Object.entries(rating);
    return entries.length === 2 && entries.every(([label, value]) => validText(label) && validText(value));
  };
  if (!list || typeof list !== 'object'||
      !Array.isArray(list.categories) ||
      !list.categories.every(category => category && validText(category.category) &&
        Array.isArray(category.items) && category.items.every(item =>
          item && validText(item.name) && validRating(item.rating)))) {
    throw new CheckError('The JSON attachment is malformed: expected a list with categories, items, names, and ratings.');
  }
}

function characterChoices(prefix, lists) {
  const names = [...lists.values()].map(({ name }) => JSON.stringify(name)).join(', ');
  const message = `${prefix} Available characters: ${names}.`;
  if (message.length > 2000) {
    throw new CheckError('There are too many character names to display. Please contact the list owner.');
  }
  return message;
}

async function lookup(interaction, channelId, signal) {
  const user = interaction.data?.options?.find(option => option.name === 'user')?.value;
  const item = interaction.data?.options?.find(option => option.name === 'item')?.value;
  const character = interaction.data?.options?.find(option => option.name === 'character')?.value;
  const guildId = interaction.guild_id;
  if (typeof guildId !== 'string' || typeof user !== 'string' ||
      !/^\d+$/.test(guildId) || !/^\d+$/.test(user) ||
      !interaction.data?.resolved?.members?.[user]) {
    throw new CheckError('Choose a member of this server.');
  }
  if (typeof item !== 'string' || !item.trim()) throw new CheckError('Enter an item name.');
  if (character !== undefined && (typeof character !== 'string' || !character.trim())) {
    throw new CheckError('Enter a character name, or leave the character option blank.');
  }
  if (!channelId || !/^\d+$/.test(channelId)) {
    throw new CheckError('The list channel is not configured correctly. Contact the bot administrator.');
  }

  const [application, channel, guild, roles, bot] = await Promise.all([
    getDiscordJson('applications/@me', signal),
    getDiscordJson(`channels/${channelId}`, signal),
    getDiscordJson(`guilds/${guildId}`, signal),
    getDiscordJson(`guilds/${guildId}/roles`, signal),
    getDiscordJson('users/@me', signal),
  ]);
  if (channel.guild_id !== guildId || channel.type !== 15) {
    throw new CheckError('The configured list channel is not a forum channel in this server.');
  }
  if (!(application.flags & MESSAGE_CONTENT_FLAGS)) {
    throw new CheckError('The bot needs the Message Content intent enabled to read list attachments.');
  }
  if (!bot.id || !/^\d+$/.test(bot.id)) throw new CheckError('The bot could not verify its identity.');
  const member = await getDiscordJson(`guilds/${guildId}/members/${bot.id}`, signal);
  if (!canReadHistory(guild, channel, roles, member, bot.id)) {
    throw new CheckError('The bot needs View Channel and Read Message History permissions in the list channel.');
  }

  const uploads = await findUploads(guildId, channelId, user, signal);
  if (!uploads.length) return 'No JSON attachment was found in this member’s forum posts.';

  const lists = new Map();
  let unnamed;
  for (const upload of uploads) {
    const list = await readList(upload.attachment, signal);
    if (!list || typeof list !== 'object' || Array.isArray(list) ||
        (list.listName != null && typeof list.listName !== 'string')) {
      throw new CheckError('A JSON attachment is malformed: its listName must be text.');
    }
    const name = list.listName?.trim();
    if (!name) {
      if (!unnamed) unnamed = list;
    } else {
      const key = name.toLowerCase();
      if (!lists.has(key)) lists.set(key, { name, list });
    }
  }
  if (unnamed && lists.size) {
    throw new CheckError('This member has an unnamed list alongside named lists. The owner must add listName to the unnamed list.');
  }
  let list;
  if (unnamed) {
    if (character !== undefined) {
      throw new CheckError('This member’s only list has no character name. Omit the character option or ask the owner to add listName.');
    }
    list = unnamed;
  } else if (character !== undefined) {
    const selected = lists.get(character.trim().toLowerCase());
    if (!selected) {
      throw new CheckError(characterChoices('No list was found for that character.', lists));
    }
    list = selected.list;
  } else if (lists.size > 1) {
    throw new CheckError(characterChoices('Please provide a character name.', lists));
  } else {
    list = lists.values().next().value.list;
  }
  validateList(list);
  const query = item.trim().toLowerCase();
  const matches = [];
  for (const category of list.categories) {
    for (const entry of category.items) {
      if (entry.name.trim().toLowerCase() === query) {
        const rating = typeof entry.rating === 'string'
          ? entry.rating
          : Object.entries(entry.rating)
            .map(([label, value]) => `${capitalize(label.trim())}: ${JSON.stringify(value)}`)
            .join(', ');
		const selectedUser = interaction.data.resolved.users[user];
		const displayName = interaction.data.resolved.members[user].nick ?? selectedUser.global_name ?? selectedUser.username;
        matches.push(`${displayName}: ${category.category}, ${item.trim()}: ${rating}`);
      }
    }
  }
  if (!matches.length) return 'The requested item was not found in this member’s list.';
  const result = matches.join('\n');
  if (result.length > 2000) throw new CheckError('The matching ratings are too long to display in one response.');
  return result;
}

export async function completeCheck(interaction) {
  let content;
  try {
    content = await lookup(interaction, process.env.LIST_CHANNEL_ID, AbortSignal.timeout(60000));
  } catch (error) {
    if (error instanceof CheckError) {
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
