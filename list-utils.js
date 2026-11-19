import { capitalize, DiscordApiError, DiscordRequest } from './utils.js';

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const ADMINISTRATOR = 1n << 3n;
const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);
const ratingTypes = new Map([
  ['crave', 'positive'], ['love', 'positive'],
  ['willing', 'neutral'], ['ask me', 'neutral'],
  ['never', 'negative'], ['hard limit', 'negative'],
]);

export class ListError extends Error {}

async function getDiscordJson(endpoint, signal) {
  try {
    const response = await DiscordRequest(endpoint, { method: 'GET', signal });
    return await response.json();
  } catch (error) {
    if (error instanceof DiscordApiError) {
      if (error.status === 429) throw new ListError('Discord rate limited the lookup. Please try again later.');
      if (error.status === 403) throw new ListError('The bot cannot access the Discord resources needed to read the list.');
      if (error.status === 404) throw new ListError('A Discord resource needed to read the list was not found.');
      throw new ListError(`Discord returned an error while reading the list (HTTP ${error.status}).`);
    }
    throw error;
  }
}

function parseDiscordMessageLink(messageLink, guildId) {
  if (typeof messageLink !== 'string' || !messageLink.trim() || messageLink !== messageLink.trim()) {
    throw new ListError('Enter a valid Discord message link.');
  }
  let url;
  try {
    url = new URL(messageLink);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ListError('Enter a valid Discord message link.');
  }
  const match = /^\/channels\/(\d+)\/(\d+)\/(\d+)$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port ||
      url.username || url.password || url.search || url.hash || !match) {
    throw new ListError('Enter a valid Discord message link.');
  }
  const [, messageGuildId, channelId, messageId] = match;
  if (messageGuildId !== guildId) {
    throw new ListError('The message link must point to a channel in this server.');
  }
  return { channelId, messageId };
}

export async function verifyMessageLink(messageLink, guildId, userId, signal) {
  if (typeof guildId !== 'string' || !/^\d+$/.test(guildId) ||
      typeof userId !== 'string' || !/^\d+$/.test(userId)) {
    throw new ListError('This command must be used in a server.');
  }
  const { channelId, messageId } = parseDiscordMessageLink(messageLink, guildId);
  const channel = await getDiscordJson(`channels/${channelId}`, signal);
  if (channel.guild_id !== guildId) {
    throw new ListError('The message link must point to a channel in this server.');
  }
  const message = await getDiscordJson(`channels/${channelId}/messages/${messageId}`, signal);
  if (message.id !== messageId || message.channel_id !== channelId) {
    throw new ListError('The linked Discord message could not be verified.');
  }
  if (message.author?.id !== userId) {
    throw new ListError('You can only register a message that you posted.');
  }
  return messageLink;
}

function canReadHistory(guild, channel, roles, member, botId) {
  if (guild.owner_id === botId) return true;
  if (!Array.isArray(roles) || !Array.isArray(member.roles) ||
      !Array.isArray(channel.permission_overwrites)) {
    throw new ListError('The bot could not verify its permissions in the list channel.');
  }

  const roleIds = new Set([guild.id, ...member.roles]);
  const matchingRoles = roles.filter(role => roleIds.has(role.id));
  if (matchingRoles.length !== roleIds.size) {
    throw new ListError('The bot could not verify its permissions in the list channel.');
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

export async function verifyListAccess(guildId, channelId, signal) {
  if (typeof channelId !== 'string' || !/^\d+$/.test(channelId)) {
    throw new ListError('The list channel is not configured correctly. Contact the bot administrator.');
  }

  const [application, channel, guild, roles, bot] = await Promise.all([
    getDiscordJson('applications/@me', signal),
    getDiscordJson(`channels/${channelId}`, signal),
    getDiscordJson(`guilds/${guildId}`, signal),
    getDiscordJson(`guilds/${guildId}/roles`, signal),
    getDiscordJson('users/@me', signal),
  ]);
  if (channel.guild_id !== guildId || channel.type !== 15) {
    throw new ListError('The configured list channel is not a forum channel in this server.');
  }
  if (!(application.flags & MESSAGE_CONTENT_FLAGS)) {
    throw new ListError('The bot needs the Message Content intent enabled to read list attachments.');
  }
  if (!bot.id || !/^\d+$/.test(bot.id)) throw new ListError('The bot could not verify its identity.');
  const member = await getDiscordJson(`guilds/${guildId}/members/${bot.id}`, signal);
  if (!canReadHistory(guild, channel, roles, member, bot.id)) {
    throw new ListError('The bot needs View Channel and Read Message History permissions in the list channel.');
  }
}

async function findThreadUploads(threadId, userId, signal) {
  let before;
  const uploads = [];
  while (true) {
    const query = new URLSearchParams({ limit: '100' });
    if (before) query.set('before', before);
    const messages = await getDiscordJson(`channels/${threadId}/messages?${query}`, signal);
    if (!Array.isArray(messages)) throw new ListError('The bot could not read the forum post history.');

    for (const message of messages) {
      if (message.author?.id !== userId || message.webhook_id) continue;
      if (!Array.isArray(message.attachments)) {
        throw new ListError('The bot could not read attachments in the forum post.');
      }
      const files = message.attachments.filter(file => typeof file.filename === 'string' && /\.json$/i.test(file.filename));
      if (files.length) {
        if (typeof message.id !== 'string' || !/^\d+$/.test(message.id)) {
          throw new ListError('The bot could not determine the latest forum upload.');
        }
        if (files.length > 1) {
          throw new ListError('An upload contains multiple JSON attachments. Please upload one JSON file per message.');
        }
        uploads.push({ id: message.id, attachment: files[0] });
      }
    }
    if (messages.length < 100) return uploads;
    const next = messages[messages.length - 1]?.id;
    if (typeof next !== 'string' || !/^\d+$/.test(next) || next === before) {
      throw new ListError('The bot could not page through the forum post history.');
    }
    before = next;
  }
}

async function findUploads(guildId, channelId, userId, signal) {
  const active = await getDiscordJson(`guilds/${guildId}/threads/active`, signal);
  if (!Array.isArray(active.threads)) throw new ListError('The bot could not list active forum posts.');
  const threads = new Map();
  function addThreads(posts) {
    for (const post of posts) {
      if (post.parent_id !== channelId) continue;
      if (typeof post.id !== 'string' || !/^\d+$/.test(post.id) || typeof post.owner_id !== 'string') {
        throw new ListError('The bot could not identify a forum post or its owner.');
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
      throw new ListError('The bot could not list archived forum posts.');
    }
    addThreads(archived.threads);
    if (!archived.has_more) break;
    const timestamp = archived.threads[archived.threads.length - 1]?.thread_metadata?.archive_timestamp;
    const time = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    if (!Number.isFinite(time)) {
      throw new ListError('The bot could not page through archived forum posts.');
    }
    // Overlap the boundary millisecond so equal archive timestamps are not skipped.
    const next = new Date(time + 1).toISOString();
    if (before && next >= before) {
      throw new ListError('The bot could not page through archived forum posts.');
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
    throw new ListError('The JSON attachment is too large or has an invalid size (maximum 2 MiB).');
  }
  let url;
  try {
    url = new URL(attachment.url);
  } catch {
    throw new ListError('The JSON attachment has an invalid download URL.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.discordapp.com' || url.username || url.password || url.port) {
    throw new ListError('The JSON attachment has an invalid download URL.');
  }

  const response = await fetch(url, { signal, redirect: 'error' });
  if (response.status === 429) throw new ListError('Discord rate limited the attachment download. Please try again later.');
  if (!response.ok || !response.body) {
    throw new ListError('The JSON attachment could not be downloaded.');
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
      throw new ListError('The JSON attachment is too large (maximum 2 MiB).');
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
    throw new ListError('The JSON attachment is malformed or is not valid UTF-8.');
  }
  return list;
}

export async function loadUserLists(guildId, channelId, userId, signal) {
  const uploads = await findUploads(guildId, channelId, userId, signal);
  const named = new Map();
  let unnamed;
  for (const upload of uploads) {
    const list = await readList(upload.attachment, signal);
    if (!list || typeof list !== 'object' || Array.isArray(list) ||
        (list.listName != null && typeof list.listName !== 'string')) {
      throw new ListError('A JSON attachment is malformed: its listName must be text.');
    }
    const name = list.listName?.trim();
    if (!name) {
      if (!unnamed) unnamed = list;
    } else {
      const key = name.toLowerCase();
      if (!named.has(key)) named.set(key, { name, list });
    }
  }
  return { named, unnamed };
}

export function characterChoices(prefix, lists) {
  const names = [...lists.values()].map(({ name }) => JSON.stringify(name)).join(', ');
  const message = `${prefix} Available characters: ${names}.`;
  if (message.length > 2000) {
    throw new ListError('There are too many character names to display. Please contact the list owner.');
  }
  return message;
}

export function selectUserList({ named, unnamed }, character) {
  if (unnamed && named.size) {
    throw new ListError('This member has an unnamed list alongside named lists. The owner must add listName to the unnamed list.');
  }
  if (unnamed) {
    if (character !== undefined) {
      throw new ListError('This member’s only list has no character name. Omit the character option or ask the owner to add listName.');
    }
    return unnamed;
  }
  if (character !== undefined) {
    const selected = named.get(character.trim().toLowerCase());
    if (!selected) {
      throw new ListError(characterChoices('No list was found for that character.', named));
    }
    return selected.list;
  }
  if (named.size > 1) {
    throw new ListError(characterChoices('Please provide a character name.', named));
  }
  return named.values().next().value.list;
}

export function validateList(list) {
  const validText = value => typeof value === 'string' && value.trim().length > 0;
  const validRating = rating => {
    if (validText(rating)) return true;
    if (rating === null || typeof rating !== 'object' || Array.isArray(rating)) return false;
    const entries = Object.entries(rating);
    return entries.length === 2 && entries.every(([label, value]) => validText(label) && validText(value));
  };
  if (!list || typeof list !== 'object' ||
      !Array.isArray(list.categories) ||
      !list.categories.every(category => category && validText(category.category) &&
        Array.isArray(category.items) && category.items.every(item =>
          item && validText(item.name) && validRating(item.rating)))) {
    throw new ListError('The JSON attachment is malformed: expected a list with categories, items, names, and ratings.');
  }
}

export function findItemEntries(list, itemName) {
  const query = itemName.trim().toLowerCase();
  const matches = [];
  for (const category of list.categories) {
    for (const item of category.items) {
      if (item.name.trim().toLowerCase() === query) {
        matches.push({ category: category.category, item });
      }
    }
  }
  return matches;
}

export function formatRating(rating) {
  if (typeof rating === 'string') return rating;
  return Object.entries(rating)
    .map(([label, value]) => `${capitalize(label.trim())}: ${JSON.stringify(value)}`)
    .join(', ');
}

export function compareRatings(yours, theirs) {
  const classify = value =>
    typeof value === 'string' ? ratingTypes.get(value.trim().toLowerCase()) : undefined;

  const a = classify(yours);
  const b = classify(theirs);

  if (!a || !b) return 'Cannot compare unrecognized ratings.';
  if (a === 'negative' || b === 'negative') return 'At least one rating is a limit. Avoid this.';
  if (a === 'positive' && b === 'positive') return 'Both ratings are positive.';
  if (a === 'neutral' && b === 'neutral') return 'Both ratings are neutral.';
  return a === 'positive'
    ? 'You like it; they are neutral.'
    : 'You are neutral; they like it.';
}

export function compareSplitRatings(yours, theirs) {
  const normalize = rating => new Map(
    Object.entries(rating).map(([label, value]) => [label.trim().toLowerCase(), value]),
  );
  const yourRoles = normalize(yours);
  const theirRoles = normalize(theirs);
  const pairs = [
    ['self', 'partner'],
    ['actor', 'subject'],
    ['center', 'circle'],
  ];
  const roles = pairs.find(([first, second]) =>
    yourRoles.size === 2 && theirRoles.size === 2 &&
    yourRoles.has(first) && yourRoles.has(second) &&
    theirRoles.has(first) && theirRoles.has(second));
  if (!roles) return 'Cannot compare split ratings with different or unrecognized roles.';
  const [first, second] = roles;
  return [
    `Your ${first} / their ${second}: ${compareRatings(yourRoles.get(first), theirRoles.get(second))}`,
    `Your ${second} / their ${first}: ${compareRatings(yourRoles.get(second), theirRoles.get(first))}`,
  ].join('\n');
}