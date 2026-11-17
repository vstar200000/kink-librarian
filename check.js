import { completeListCommand, handleListCommand } from './interaction-utils.js';
import { ListError } from './list-utils.js';
import { lookupList } from './list-lookup.js';

async function lookup(interaction, channelId, signal) {
  const user = interaction.data?.options?.find(option => option.name === 'user')?.value;
  if (typeof user !== 'string' || !interaction.data?.resolved?.members?.[user]) {
    throw new ListError('Choose a member of this server.');
  }
  return lookupList(interaction, channelId, signal, user);
}

export function completeCheck(interaction) {
  return completeListCommand(interaction, 'Check', lookup);
}

export function handleCheck(interaction, res) {
  return handleListCommand(interaction, res, 'check', completeCheck);
}
