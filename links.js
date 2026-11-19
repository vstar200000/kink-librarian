import { completeListCommand, handleListCommand } from './interaction-utils.js';
import { createCharacterLinkStore } from './item-cache.js';
import { ListError, verifyMessageLink } from './list-utils.js';

function commandOptions(interaction) {
  return interaction.data?.options;
}

async function register(interaction, _channelId, signal) {
  const guildId = interaction.guild_id;
  const userId = interaction.member?.user?.id;
  const options = commandOptions(interaction);
  const messageLink = options?.find(option => option.name === 'message_link')?.value;
  const character = options?.find(option => option.name === 'character')?.value;
  if (typeof guildId !== 'string' || !/^\d+$/.test(guildId) ||
      typeof userId !== 'string' || !/^\d+$/.test(userId)) {
    throw new ListError('This command must be used in a server.');
  }
  if (typeof character !== 'string' || !character.trim()) {
    throw new ListError('Enter a character name.');
  }
  const verifiedUrl = await verifyMessageLink(messageLink, guildId, userId, signal);
  const links = createCharacterLinkStore(guildId, signal);
  await links.put(userId, character, verifiedUrl);
  return `Registered the message link for ${JSON.stringify(character.trim())}.`;
}

async function lookup(interaction, _channelId, signal) {
  const guildId = interaction.guild_id;
  const options = commandOptions(interaction);
  const userId = options?.find(option => option.name === 'user')?.value;
  const character = options?.find(option => option.name === 'character')?.value;
  if (typeof guildId !== 'string' || !/^\d+$/.test(guildId) ||
      typeof userId !== 'string' || !/^\d+$/.test(userId) ||
      !interaction.data?.resolved?.members?.[userId]) {
    throw new ListError('Choose a member of this server.');
  }
  if (typeof character !== 'string' || !character.trim()) {
    throw new ListError('Enter a character name.');
  }
  const links = createCharacterLinkStore(guildId, signal);
  const messageLink = await links.get(userId, character);
  if (!messageLink) return 'No registered link was found for that member and character.';
  return messageLink;
}

export function completeRegister(interaction) {
  return completeListCommand(interaction, 'Register', register);
}

export function handleRegister(interaction, res) {
  return handleListCommand(interaction, res, 'register', completeRegister);
}

export function completeLink(interaction) {
  return completeListCommand(interaction, 'Link', lookup);
}

export function handleLink(interaction, res) {
  const visible = commandOptions(interaction)?.find(option => option.name === 'visible')?.value;
  return handleListCommand(interaction, res, 'link', completeLink, { ephemeral: !visible });
}
