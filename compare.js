import { completeListCommand, handleListCommand } from './interaction-utils.js';
import {
	compareRatings,
	compareSplitRatings,
	formatRating,
	ListError,
} from './list-utils.js';
import { createItemLookup, ListAccessError } from './item-lookup.js';


async function lookup(interaction, channelId, signal) {
  const options = interaction.data?.options;
  const otherUser = options?.find(option => option.name === 'other_user')?.value;
  const item = options?.find(option => option.name === 'item')?.value;
  const yourCharacter = options?.find(option => option.name === 'your_character')?.value;
  const otherCharacter = options?.find(option => option.name === 'other_character')?.value;
  const guildId = interaction.guild_id;
  const user = interaction.member?.user?.id;

  if (typeof guildId !== 'string' || !/^\d+$/.test(guildId) ||
      typeof user !== 'string' || !/^\d+$/.test(user) ||
      typeof otherUser !== 'string' || !/^\d+$/.test(otherUser) ||
      !interaction.data?.resolved?.members?.[otherUser]) {
    throw new ListError('Choose a member of this server.');
  }
  if (typeof item !== 'string' || !item.trim()) throw new ListError('Enter an item name.');
  for (const character of [yourCharacter, otherCharacter]) {
    if (character !== undefined && (typeof character !== 'string' || !character.trim())) {
      throw new ListError('Enter a character name, or leave the character option blank.');
    }
  }

  const findItem = createItemLookup(guildId, channelId, signal);

  async function answers(member, character, label) {
    try {
      const { name, matches } = await findItem(member, character, item);
      if (!matches.length) return { matches, content: `${label}: The requested item was not found in this member’s list.` };
      const listLabel = name ? `${label} (${JSON.stringify(name)})` : label;
      const content = matches.map(({ category, item: entry }) =>
        `${listLabel}${matches.length > 1 ? ` (${category})` : ''}: ${formatRating(entry.rating)}`).join('\n');
      return { matches, content };
    } catch (error) {
      if (error instanceof ListAccessError) throw error;
      if (!(error instanceof ListError)) throw error;
      const message = `${label}: ${error.message}`;
      throw new ListError(message.length <= 2000 ? message : `${label}: The list error is too long to display.`);
    }
  }

  const [yours, theirs] = await Promise.all([
    answers(user, yourCharacter, 'Your list'),
    answers(otherUser, otherCharacter, 'Other member’s list'),
  ]);
  const verdicts = compareMatches(yours.matches, theirs.matches);
  const result = [item.trim(), yours.content, theirs.content, ...verdicts].join('\n');
  if (result.length > 2000) throw new ListError('The matching ratings are too long to display in one response.');
  return result;
}

function compareMatches(yours, theirs) {
  if (!yours.length || !theirs.length) return [];

  function verdict(yourEntry, theirEntry) {
    const yourRating = yourEntry.item.rating;
    const theirRating = theirEntry.item.rating;
    if (typeof yourRating === 'string' && typeof theirRating === 'string') {
      return compareRatings(yourRating, theirRating);
    }
    if (typeof yourRating === 'object' && typeof theirRating === 'object') {
      return compareSplitRatings(yourRating, theirRating);
    }
    return 'Cannot compare a single rating with a split rating.';
  }

  if (yours.length === 1 && theirs.length === 1) {
    return [`Verdict: ${verdict(yours[0], theirs[0])}`];
  }

  const categories = new Map();
  for (const [entries, side] of [[yours, 'yours'], [theirs, 'theirs']]) {
    for (const entry of entries) {
      const key = entry.category.trim().toLowerCase();
      if (!categories.has(key)) categories.set(key, { name: entry.category, yours: [], theirs: [] });
      categories.get(key)[side].push(entry);
    }
  }
  return [...categories.values()].map(({ name, yours: yourEntries, theirs: theirEntries }) => {
    const prefix = `Verdict (${name}): `;
    if (!yourEntries.length) return `${prefix}No matching item in your list.`;
    if (!theirEntries.length) return `${prefix}No matching item in the other member’s list.`;
    if (yourEntries.length > 1 || theirEntries.length > 1) {
      return `${prefix}Multiple matching items in this category; comparison is ambiguous.`;
    }
    return prefix + verdict(yourEntries[0], theirEntries[0]);
  });
}

export function completeCompare(interaction) {
  return completeListCommand(interaction, 'Compare', lookup);
}

export function handleCompare(interaction, res) {
  return handleListCommand(interaction, res, 'compare', completeCompare);
}