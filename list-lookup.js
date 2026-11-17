import {
  formatRating,
  ListError,
} from './list-utils.js';
import { createItemLookup } from './item-lookup.js';

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

  const lookup = createItemLookup(guildId, channelId, signal);
  const { matches: entries } = await lookup(user, character, item);
  const characterPrefix = character ? `${character.trim()}, ` : '';
  const matches = entries
    .map(({ item: entry }) => `${characterPrefix}${item.trim()}: ${formatRating(entry.rating)}`);
  if (!matches.length) return 'The requested item was not found in this member’s list.';
  const result = matches.join('\n');
  if (result.length > 2000) throw new ListError('The matching ratings are too long to display in one response.');
  return result;
}
