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
		}
	],
};

const ALL_COMMANDS = [TEST_COMMAND, CHECK_COMMAND];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
