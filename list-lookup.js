import {
  findItemEntries,
  formatRating,
  ListError,
  loadUserLists,
  selectUserList,
  validateList,
  verifyListAccess,
} from './list-utils.js';

export async function lookupList(interaction, channelId, signal, user) {
  const item = interaction.data?.options?.find(option => option.name === 'item')?.value;
  const character = interaction.data?.options?.find(option => option.name === 'character')?.value;
  const guildId = interaction.guild_id;
  if (typeof guildId !== 'string' || typeof user !== 'string' ||
      !/^\d+$/.test(guildId) || !/^\d+$/.test(user)) {
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
  const characterPrefix = character ? `${character.trim()}, ` : '';
  const matches = findItemEntries(list, item)
    .map(({ item: entry }) => `${characterPrefix}${item.trim()}: ${formatRating(entry.rating)}`);
  if (!matches.length) return 'The requested item was not found in this member’s list.';
  const result = matches.join('\n');
  if (result.length > 2000) throw new ListError('The matching ratings are too long to display in one response.');
  return result;
}
