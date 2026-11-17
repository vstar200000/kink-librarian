import { completeListCommand, handleListCommand } from './interaction-utils.js';
import { lookupList } from './list-lookup.js';

async function lookup(interaction, channelId, signal) {
  const user = interaction.member?.user?.id;
  return lookupList(interaction, channelId, signal, user);
}

export function completeExhibit(interaction) {
  return completeListCommand(interaction, 'Exhibit', lookup);
}

export function handleExhibit(interaction, res) {
  return handleListCommand(interaction, res, 'exhibit', completeExhibit, { ephemeral: false });
}