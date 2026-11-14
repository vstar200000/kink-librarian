import { completeListCommand, handleListCommand } from './interaction-utils.js';
import {
  findItemEntries,
  formatRating,
  ListError,
  loadUserLists,
  selectUserList,
  validateList,
  verifyListAccess,
} from './list-utils.js';

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

  await verifyListAccess(guildId, channelId, signal);
  const yourListsPromise = loadUserLists(guildId, channelId, user, signal);
  const otherListsPromise = user === otherUser
    ? yourListsPromise
    : loadUserLists(guildId, channelId, otherUser, signal);

  async function answers(listsPromise, character, label) {
    try {
      const lists = await listsPromise;
      if (!lists.unnamed && !lists.named.size) {
        throw new ListError('No JSON attachment was found in this member’s forum posts.');
      }
      const list = selectUserList(lists, character);
      validateList(list);
      const matches = findItemEntries(list, item);
      if (!matches.length) return `${label}: The requested item was not found in this member’s list.`;
      const name = list.listName?.trim();
      const listLabel = name ? `${label} (${JSON.stringify(name)})` : label;
      return matches.map(({ category, item: entry }) =>
        `${listLabel} (${category}): ${formatRating(entry.rating)}`).join('\n');
    } catch (error) {
      if (!(error instanceof ListError)) throw error;
      const message = `${label}: ${error.message}`;
      throw new ListError(message.length <= 2000 ? message : `${label}: The list error is too long to display.`);
    }
  }

  const [yours, theirs] = await Promise.all([
    answers(yourListsPromise, yourCharacter, 'Your list'),
    answers(otherListsPromise, otherCharacter, 'Other member’s list'),
  ]);
  const result = `${item.trim()}\n${yours}\n${theirs}`;
  if (result.length > 2000) throw new ListError('The matching ratings are too long to display in one response.');
  return result;
}

export function completeCompare(interaction) {
  return completeListCommand(interaction, 'Compare', lookup);
}

export function handleCompare(interaction, res) {
  return handleListCommand(interaction, res, 'compare', completeCompare);
}