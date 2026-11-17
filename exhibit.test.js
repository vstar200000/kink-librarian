import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleExhibit } from './exhibit.js';
import { useEmptyCache } from './test-cache-support.js';

useEmptyCache();

const interaction = {
  application_id: '10',
  token: 'interaction-token',
  guild_id: '20',
  member: { user: { id: '30' } },
  data: {
    name: 'exhibit',
    options: [{ name: 'item', value: ' lego ' }],
  },
};

async function runExhibit(request = interaction) {
  const originalFetch = globalThis.fetch;
  const originalChannel = process.env.LIST_CHANNEL_ID;
  const originalToken = process.env.DISCORD_TOKEN;
  const calls = [];
  let deferred;
  let result;
  process.env.LIST_CHANNEL_ID = '40';
  process.env.DISCORD_TOKEN = 'test-token';
  globalThis.fetch = async (input, options) => {
    const url = input.toString();
    calls.push(url);
    if (url.includes('/webhooks/')) {
      result = JSON.parse(options.body);
      return new Response(null, { status: 200 });
    }
    if (url.startsWith('https://cdn.discordapp.com/')) {
      return new Response(JSON.stringify({
        listName: 'Anne',
        categories: [{ category: 'Games', items: [{ name: 'Lego', rating: 'Love' }] }],
      }));
    }
    const endpoint = url.replace('https://discord.com/api/v10/', '');
    const responses = {
      'applications/@me': { flags: 1 << 19 },
      'channels/40': { guild_id: '20', type: 15, permission_overwrites: [] },
      'guilds/20': { id: '20', owner_id: '99' },
      'guilds/20/roles': [{ id: '20', permissions: String((1 << 10) | (1 << 16)) }],
      'users/@me': { id: '50' },
      'guilds/20/members/50': { roles: [] },
      'guilds/20/threads/active': { threads: [
        { id: '70', parent_id: '40', owner_id: '30' },
        { id: '71', parent_id: '40', owner_id: '31' },
      ] },
      'channels/40/threads/archived/public?limit=100': { threads: [], has_more: false },
      'channels/70/messages?limit=100': [{
        id: '100',
        author: { id: '30' },
        attachments: [{
          filename: 'list.json',
          size: 100,
          url: 'https://cdn.discordapp.com/attachments/40/50/list.json',
        }],
      }],
    };
    assert.ok(Object.hasOwn(responses, endpoint), `Unexpected request: ${endpoint}`);
    return new Response(JSON.stringify(responses[endpoint]));
  };
  try {
    await handleExhibit(request, { send: response => { deferred = response; } });
    return { deferred, result, calls };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChannel === undefined) delete process.env.LIST_CHANNEL_ID;
    else process.env.LIST_CHANNEL_ID = originalChannel;
    if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = originalToken;
  }
}

test('exhibits only the invoking member’s rating in a public response', async () => {
  const { deferred, result, calls } = await runExhibit();
  assert.deepEqual(deferred, { type: 5, data: {} });
  assert.equal(result.content, 'lego: Love');
  assert.deepEqual(result.allowed_mentions, { parse: [] });
  assert.ok(calls.includes('https://discord.com/api/v10/channels/70/messages?limit=100'));
  assert.ok(!calls.some(url => url.includes('/channels/71/messages?')));
});

test('keeps exhibit validation errors public', async () => {
  const request = {
    ...interaction,
    data: { ...interaction.data, options: [{ name: 'item', value: '  ' }] },
  };
  const { deferred, result } = await runExhibit(request);
  assert.deepEqual(deferred, { type: 5, data: {} });
  assert.match(result.content, /Enter an item name/);
});
