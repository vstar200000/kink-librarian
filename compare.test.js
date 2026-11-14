import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleCompare } from './compare.js';

const interaction = {
  application_id: '10',
  token: 'interaction-token',
  guild_id: '20',
  member: { user: { id: '30' } },
  data: {
    name: 'compare',
    options: [{ name: 'other_user', value: '31' }, { name: 'item', value: ' lego ' }],
    resolved: { members: { 31: {} } },
  },
};

const list = (name, rating) => ({
  listName: name,
  categories: [{ category: 'Games', items: [{ name: 'Lego', rating }] }],
});

async function runCompare({
  request = interaction,
  yourLists = [list('Anne', 'Love')],
  otherLists = [list('Bob', { actor: 'Like', subject: 'Maybe' })],
  checkConcurrent = false,
} = {}) {
  const oldFetch = globalThis.fetch;
  const oldChannel = process.env.LIST_CHANNEL_ID;
  const oldToken = process.env.DISCORD_TOKEN;
  let deferred;
  let result;
  let activeRequests = 0;
  let releaseActive;
  const bothActive = new Promise(resolve => { releaseActive = resolve; });
  const calls = [];
  process.env.LIST_CHANNEL_ID = '40';
  process.env.DISCORD_TOKEN = 'test-token';
  globalThis.fetch = async (input, options) => {
    assert.ok(deferred, 'the interaction must be deferred before network requests');
    const url = input.toString();
    calls.push(url);
    if (url.includes('/webhooks/')) {
      result = JSON.parse(options.body);
      return new Response(null, { status: 200 });
    }
    if (url.startsWith('https://cdn.discordapp.com/')) {
      const match = /\/(30|31)\/(\d+)\.json$/.exec(url);
      assert.ok(match, `Unexpected attachment: ${url}`);
      const lists = match[1] === '30' ? yourLists : otherLists;
      return new Response(JSON.stringify(lists[Number(match[2])]));
    }
    const endpoint = url.replace('https://discord.com/api/v10/', '');
    if (checkConcurrent && endpoint === 'guilds/20/threads/active') {
      activeRequests++;
      if (activeRequests === 2) releaseActive();
      await Promise.race([
        bothActive,
        new Promise((_, reject) => setTimeout(() => reject(new Error('List lookups were not concurrent')), 1000)),
      ]);
    }
    const messages = (owner, lists) => lists.map((_, index) => ({
      id: String(100 + index),
      author: { id: owner },
      attachments: [{
        filename: 'list.json',
        size: 100,
        url: `https://cdn.discordapp.com/${owner}/${index}.json`,
      }],
    }));
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
      'channels/70/messages?limit=100': messages('30', yourLists),
      'channels/71/messages?limit=100': messages('31', otherLists),
    };
    assert.ok(Object.hasOwn(responses, endpoint), `Unexpected request: ${endpoint}`);
    return new Response(JSON.stringify(responses[endpoint]));
  };
  try {
    await handleCompare(request, { send: response => { deferred = response; } });
    return { deferred, result, calls };
  } finally {
    globalThis.fetch = oldFetch;
    if (oldChannel === undefined) delete process.env.LIST_CHANNEL_ID;
    else process.env.LIST_CHANNEL_ID = oldChannel;
    if (oldToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = oldToken;
  }
}

function withOptions(...options) {
  return { ...interaction, data: { ...interaction.data, options: [...interaction.data.options, ...options] } };
}

test('defers privately and loads both lists concurrently for comparison', async () => {
  const { deferred, result } = await runCompare({ checkConcurrent: true });
  assert.deepEqual(deferred, { type: 5, data: { flags: 64 } });
  assert.deepEqual(result, {
    content: 'lego\nYour list ("Anne") (Games): Love\nOther member’s list ("Bob") (Games): Actor: "Like", Subject: "Maybe"',
    allowed_mentions: { parse: [] },
  });
});

test('selects each character independently and identifies ambiguous choices', async () => {
  const options = {
    yourLists: [list('Anne', 'Love'), list('Alice', 'Like')],
    otherLists: [list('Bob', 'Maybe'), list('Bill', 'No')],
  };
  const ambiguous = await runCompare(options);
  assert.match(ambiguous.result.content, /^Your list: Please provide a character name/);
  const request = withOptions(
    { name: 'your_character', value: ' aNnE ' },
    { name: 'other_character', value: ' bOb ' },
  );
  const selected = await runCompare({ ...options, request });
  assert.equal(selected.result.content, 'lego\nYour list ("Anne") (Games): Love\nOther member’s list ("Bob") (Games): Maybe');
  const wrong = await runCompare({ ...options, request: withOptions(
    { name: 'your_character', value: 'Anne' },
    { name: 'other_character', value: 'Unknown' },
  ) });
  assert.match(wrong.result.content, /^Other member’s list: No list was found/);
});

test('compares two characters of the same member without loading uploads twice', async () => {
  const request = withOptions(
    { name: 'your_character', value: 'Anne' },
    { name: 'other_character', value: 'Alice' },
  );
  request.data.options = request.data.options.map(option =>
    option.name === 'other_user' ? { ...option, value: '30' } : option);
  request.data.resolved = { members: { 30: {} } };
  const { result, calls } = await runCompare({
    request,
    yourLists: [list('Anne', 'Love'), list('Alice', 'Like')],
  });
  assert.equal(result.content, 'lego\nYour list ("Anne") (Games): Love\nOther member’s list ("Alice") (Games): Like');
  assert.equal(calls.filter(url => url.includes('/threads/active')).length, 1);
});

test('reports missing uploads, malformed lists, and missing items for the right side', async () => {
  const missing = await runCompare({ otherLists: [] });
  assert.match(missing.result.content, /^Other member’s list: No JSON attachment/);
  const malformed = await runCompare({ yourLists: [{ listName: 'Anne', categories: 'invalid' }] });
  assert.match(malformed.result.content, /^Your list:.*malformed/);
  const noItem = await runCompare({ otherLists: [{ listName: 'Bob', categories: [] }] });
  assert.match(noItem.result.content, /Other member’s list: The requested item was not found/);
  assert.match(noItem.result.content, /Your list \("Anne"\) \(Games\): Love/);
});

test('supports unnamed lists and preserves all matching categories', async () => {
  const yourLists = [{
    categories: [
      { category: 'First', items: [{ name: 'Lego', rating: 'Love' }] },
      { category: 'Second', items: [{ name: 'LEGO', rating: 'Like' }] },
    ],
  }];
  const { result } = await runCompare({ yourLists });
  assert.match(result.content, /Your list \(First\): Love\nYour list \(Second\): Like/);
  const named = await runCompare({
    yourLists,
    request: withOptions({ name: 'your_character', value: 'Anne' }),
  });
  assert.match(named.result.content, /^Your list:.*only list has no character name/);
});

test('rejects invalid members and oversized results', async () => {
  const invalid = { ...interaction, member: {} };
  assert.match((await runCompare({ request: invalid })).result.content, /Choose a member/);
  const tooLong = await runCompare({ yourLists: [list('Anne', 'x'.repeat(2000))] });
  assert.match(tooLong.result.content, /too long/);
});
