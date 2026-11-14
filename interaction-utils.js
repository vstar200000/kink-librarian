import { InteractionResponseFlags, InteractionResponseType } from 'discord-interactions';
import { setTimeout as delay } from 'node:timers/promises';
import { ListError } from './list-utils.js';

class DiscordResponseError extends Error {
  constructor(status, command) {
    super(`Could not send ${command} response: HTTP ${status}`);
    this.name = 'DiscordResponseError';
    this.status = status;
  }
}

export async function completeListCommand(interaction, command, lookup) {
  let content;
  try {
    content = await lookup(interaction, process.env.LIST_CHANNEL_ID, AbortSignal.timeout(60000));
  } catch (error) {
    if (error instanceof ListError) {
      content = error.message;
    } else if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      content = 'The list lookup timed out. Please try again later.';
    } else {
      console.error(`${command} lookup failed:`, error.name);
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
    throw new DiscordResponseError(response.status, command);
  }
}

export async function handleListCommand(interaction, res, command, complete) {
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });
  try {
    await complete(interaction);
  } catch (error) {
    console.error(`Could not send ${command} response:`, error.name);
  }
}
