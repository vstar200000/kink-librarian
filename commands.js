import 'dotenv/config';
import { InstallGlobalCommands } from './utils.js';

// Simple test command
const TEST_COMMAND = {
  name: 'test',
  description: 'Basic command',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const CHECK_COMMAND = {
	name: 'check',
	description: 'Requests another user\'s survey answer.',
	type: 1,
	integration_types: [0],
	contexts: [0],
	options: [
		{
			type: 6,
			name: 'user',
			description: 'The server member whose list to check',
			required: true,
		},
		{
			type: 3,
			name: 'item',
			description: 'The item to look up',
			required: true,
		},
		{
			type: 3, 
			name: 'character',
			description: 'The character\'s name',
			required: false,
		},
		{
			type: 5,
			name: 'visible',
			description: 'Whether the answer should be visible to others',
			required: false,
		}
	],
};

const COMPARE_COMMAND = {
	name: 'compare',
	description: 'Compares survey answers between users.',
	type: 1,
	integration_types: [0],
	contexts: [0],
	options: [
		{
			type: 6,
			name: 'other_user',
			description: 'The other server member to compare against',
			required: true,
		},
		{
			type: 3,
			name: 'item',
			description: 'The item to compare',
			required: true,
		},
		{
			type: 3, 
			name: 'other_character',
			description: 'The other character\'s name',
			required: false,
		},
		{
			type: 3, 
			name: 'your_character',
			description: 'Your character\'s name',
			required: false,
		},
		{
			type: 5,
			name: 'visible',
			description: 'Whether the answer should be visible to others',
			required: false,
		}
	],
};

const EXHIBIT_COMMAND = {
	name: 'exhibit',
	description: 'Publicly exhibits your own survey answer.',
	type: 1,
	integration_types: [0],
	contexts: [0],
	options: [
		{
			type: 3,
			name: 'item',
			description: 'The item to exhibit',
			required: true,
		},
		{
			type: 3,
			name: 'character',
			description: 'The character\'s name',
			required: false,
		},
	]
};

const REGISTER_COMMAND = {
	name: 'register',
	description: 'Registers your PNG list message.',
	type: 1,
	integration_types: [0],
	contexts: [0],
	options: [
		{
			type: 3,
			name: 'message_link',
			description: 'A message link to your PNG attachment in this server.',
			required: true,
		},
		{
			type: 3,
			name: 'character',
			description: 'The character\'s name',
			required: true,
		}
	]
};

const LINK_COMMAND = {
	name: 'link',
	description: 'Retrieves a registered character image link.',
	type: 1,
	integration_types: [0],
	contexts: [0],
	options: [
		{
			type: 6,
			name: 'user',
			description: 'The server member whose link to retrieve',
			required: true,
		},
		{
			type: 3,
			name: 'character',
			description: 'The character\'s name',
			required: true,
		},
		{
			type: 5,
			name: 'visible',
			description: 'Whether the answer should be visible to others',
			required: false,
		}
	]
}

const ALL_COMMANDS = [TEST_COMMAND, CHECK_COMMAND, COMPARE_COMMAND, EXHIBIT_COMMAND, REGISTER_COMMAND, LINK_COMMAND];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
