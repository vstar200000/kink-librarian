import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { handleCheck } from './check.js';
import { handleCompare } from './compare.js';
import { handleExhibit } from './exhibit.js';
import { createItemCache } from './item-cache.js';
import { createItemLookup } from './item-lookup.js';

const makeList = (name, rating = 'Love', item = 'Lego') => ({
  ...(name === undefined ? {} : { listName: name }),
  categories: [{ category: 'Games', items: [{ name: item, rating }] }],
});

async function fixture(fn) {
  const original = {
    send: DynamoDBDocumentClient.prototype.send,
    fetch: globalThis.fetch,
    error: console.error,
    table: process.env.DYNAMODB_TABLE_NAME,
    region: process.env.AWS_REGION,
    channel: process.env.LIST_CHANNEL_ID,
    token: process.env.DISCORD_TOKEN,
  };
  process.env.DYNAMODB_TABLE_NAME = 'test-cache';
  process.env.AWS_REGION = 'us-east-1';
  process.env.LIST_CHANNEL_ID = '40';
  process.env.DISCORD_TOKEN = 'test-token';
  const records = new Map();
  const state = {
    records,
    lists: { 30: [makeList('Anne')], 31: [makeList('Bob', 'Crave')] },
    discordCalls: [],
    logs: [],
    failRead: false,
    failWrite: false,
    denyDiscord: false,
    noMessageIntent: false,
  };
  const recordKey = ({ pk, sk }) => `${pk}|${sk}`;
  DynamoDBDocumentClient.prototype.send = async (command, options) => {
    assert.ok(options.abortSignal);
    if (command instanceof GetCommand) {
      if (state.failRead) throw new Error('sensitive read error');
      return { Item: records.get(recordKey(command.input.Key)) };
    }
    if (command instanceof QueryCommand) {
      if (state.failRead) throw new Error('sensitive read error');
      const { ':pk': pk, ':prefix': prefix } = command.input.ExpressionAttributeValues;
      const all = [...records.values()].filter(record => record.pk === pk && record.sk.startsWith(prefix))
        .sort((a, b) => a.sk.localeCompare(b.sk));
      const start = command.input.ExclusiveStartKey
        ? all.findIndex(record => record.sk === command.input.ExclusiveStartKey.sk) + 1 : 0;
      const page = all.slice(start, start + 1);
      return {
        Items: page,
        ...(start + 1 < all.length ? { LastEvaluatedKey: { pk, sk: page[0].sk } } : {}),
      };
    }
    if (command instanceof TransactWriteCommand) {
      if (state.failWrite) throw new Error('sensitive write error');
      for (const { Put } of command.input.TransactItems) {
        records.set(recordKey(Put.Item), structuredClone(Put.Item));
      }
      return {};
    }
    throw new Error('Unexpected DynamoDB command');
  };
  console.error = (...args) => state.logs.push(args.join(' '));
  globalThis.fetch = async (input, options) => {
    const url = input.toString();
    if (url.includes('/webhooks/')) {
      state.response = JSON.parse(options.body);
      return new Response(null, { status: 200 });
    }
    state.discordCalls.push(url);
    if (state.denyDiscord) throw new Error('Unexpected Discord lookup');
    if (url.startsWith('https://cdn.discordapp.com/')) {
      const [, owner, index] = /\/(\d+)\/(\d+)\.json$/.exec(url);
      return new Response(JSON.stringify(state.lists[owner][Number(index)]));
    }
    const endpoint = url.replace('https://discord.com/api/v10/', '');
    const uploads = owner => state.lists[owner].map((_, index) => ({
      id: String(100 + index), author: { id: owner },
      attachments: [{
        filename: 'list.json', size: 100,
        url: `https://cdn.discordapp.com/${owner}/${index}.json`,
      }],
    }));
    const responses = {
      'applications/@me': { flags: state.noMessageIntent ? 0 : 1 << 19 },
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
      'channels/70/messages?limit=100': uploads('30'),
      'channels/71/messages?limit=100': uploads('31'),
    };
    assert.ok(Object.hasOwn(responses, endpoint), `Unexpected Discord endpoint: ${endpoint}`);
    return new Response(JSON.stringify(responses[endpoint]));
  };
  try {
    await fn(state);
  } finally {
    DynamoDBDocumentClient.prototype.send = original.send;
    globalThis.fetch = original.fetch;
    console.error = original.error;
    for (const [key, value] of Object.entries({
      DYNAMODB_TABLE_NAME: original.table, AWS_REGION: original.region,
      LIST_CHANNEL_ID: original.channel, DISCORD_TOKEN: original.token,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function request(command, options, user = '30') {
  return {
    application_id: '10', token: 'test-token', guild_id: '20',
    member: { user: { id: user } },
    data: { name: command, options, resolved: { members: { 30: {}, 31: {} } } },
  };
}

async function run(state, command, options, user) {
  const handlers = { check: handleCheck, exhibit: handleExhibit, compare: handleCompare };
  await handlers[command](request(command, options, user), { send() {} });
  return state.response.content;
}

const check = (user, item = 'Lego', character) => [
  { name: 'user', value: user }, { name: 'item', value: item },
  ...(character === undefined ? [] : [{ name: 'character', value: character }]),
];

test('shares cached structured results across all commands without Discord access', async () => fixture(async state => {
  state.lists[30] = [makeList('Anne', { actor: 'Love', subject: 'Never' })];
  state.lists[31] = [makeList('Bob', { actor: 'Crave', subject: 'Willing' })];
  const first = await run(state, 'check', check('30', ' lego ', ' aNnE '));
  await run(state, 'check', check('31', 'Lego', 'Bob'));
  state.lists[30] = [makeList('Anne', 'Changed')];
  state.denyDiscord = true;
  assert.equal(await run(state, 'check', check('30', ' lego ', ' aNnE ')), first);
  assert.equal(await run(state, 'exhibit', [{ name: 'item', value: 'LEGO' }]), 'LEGO: Actor: "Love", Subject: "Never"');
  const comparison = await run(state, 'compare', [
    { name: 'other_user', value: '31' }, { name: 'item', value: 'Lego' },
    { name: 'your_character', value: 'anne' }, { name: 'other_character', value: 'bob' },
  ]);
  assert.match(comparison, /Your list \("Anne"\): Actor: "Love", Subject: "Never"/);
  assert.match(comparison, /Your subject \/ their actor: At least one rating is a limit/);
}));

test('preserves multiple matching categories and comparison verdicts on cache hits', async () => fixture(async state => {
  state.lists[30][0].categories.push({ category: 'Other', items: [{ name: 'LEGO', rating: 'Never' }] });
  state.lists[31][0].categories.push({ category: 'Other', items: [{ name: 'Lego', rating: 'Love' }] });
  const options = [{ name: 'other_user', value: '31' }, { name: 'item', value: 'Lego' }];
  const first = await run(state, 'compare', options);
  assert.match(first, /Verdict \(Games\): Both ratings are positive/);
  assert.match(first, /Verdict \(Other\): At least one rating is a limit/);
  state.denyDiscord = true;
  assert.equal(await run(state, 'compare', options), first);
}));

test('preserves the unprefixed access error for comparison cache misses', async () => fixture(async state => {
  state.noMessageIntent = true;
  const result = await run(state, 'compare', [
    { name: 'other_user', value: '31' }, { name: 'item', value: 'Lego' },
  ]);
  assert.equal(result, 'The bot needs the Message Content intent enabled to read list attachments.');
}));

test('selects one cached character, discovers another on a miss, and requires a choice', async () => fixture(async state => {
  state.lists[30] = [makeList('Anne'), makeList('Alice', 'Never')];
  await run(state, 'check', check('30', 'Lego', 'Anne'));
  state.denyDiscord = true;
  assert.equal(await run(state, 'check', check('30')), 'Lego: Love');
  state.denyDiscord = false;
  assert.equal(await run(state, 'check', check('30', 'Lego', 'Alice')), 'Alice, Lego: Never');
  state.denyDiscord = true;
  const prompt = await run(state, 'check', check('30'));
  assert.match(prompt, /Please provide a character name/);
  assert.match(prompt, /"Anne"/);
  assert.match(prompt, /"Alice"/);
}));

test('uses the single cached character for a new item and does not cache misses', async () => fixture(async state => {
  state.lists[30] = [makeList('Anne'), makeList('Alice')];
  await run(state, 'check', check('30', 'Lego', 'Anne'));
  const count = state.records.size;
  assert.match(await run(state, 'check', check('30', 'Missing')), /item was not found/);
  assert.equal(state.records.size, count);
  state.lists[30][0].categories[0].items.push({ name: 'Missing', rating: 'Willing' });
  assert.equal(await run(state, 'check', check('30', 'Missing')), 'Missing: Willing');
  state.denyDiscord = true;
  assert.equal(await run(state, 'check', check('30', 'missing')), 'missing: Willing');
}));

test('preserves unnamed legacy lists on cache hits and rejects explicit names', async () => fixture(async state => {
  state.lists[30] = [makeList(undefined)];
  assert.equal(await run(state, 'check', check('30')), 'Lego: Love');
  state.denyDiscord = true;
  assert.equal(await run(state, 'check', check('30')), 'Lego: Love');
  state.denyDiscord = false;
  assert.match(await run(state, 'check', check('30', 'Lego', 'Anne')), /only list has no character name/);
}));

test('isolates cached records by guild, forum, user and normalized character and item', async () => fixture(async () => {
  const signal = AbortSignal.timeout(10000);
  const cache = createItemCache('20', '40', signal);
  await cache.put('30', ' Anne ', ' Lego ', [{ category: 'Games', item: { name: 'LEGO', rating: 'Love' } }]);
  assert.equal((await cache.get('30', 'anne', 'lego')).matches[0].item.rating, 'Love');
  assert.equal(await cache.get('31', 'anne', 'lego'), undefined);
  assert.equal(await cache.get('30', 'alice', 'lego'), undefined);
  assert.equal(await cache.get('30', 'anne', 'other'), undefined);
  assert.equal(await createItemCache('21', '40', signal).get('30', 'anne', 'lego'), undefined);
  assert.equal(await createItemCache('20', '41', signal).get('30', 'anne', 'lego'), undefined);
}));

test('falls back on cache failures without logging private data, including rejected writes', async () => fixture(async state => {
  state.failRead = true;
  state.failWrite = true;
  assert.equal(await run(state, 'check', check('30', 'Lego', 'Anne')), 'Anne, Lego: Love');
  assert.equal(state.records.size, 0);
  assert.equal(state.logs.length, 2);
  assert.ok(state.logs.every(log => !/sensitive|Anne|Lego|Love|token/.test(log)));
}));

test('requires configuration and treats corrupt cached data as a cache failure', async () => fixture(async state => {
  delete process.env.DYNAMODB_TABLE_NAME;
  assert.match(await run(state, 'check', check('30')), /DynamoDB is not configured/);
  assert.equal(state.discordCalls.length, 0);
  process.env.DYNAMODB_TABLE_NAME = 'test-cache';
  delete process.env.AWS_REGION;
  assert.match(await run(state, 'check', check('30')), /DynamoDB is not configured/);
  process.env.AWS_REGION = 'us-east-1';
  await run(state, 'check', check('30', 'Lego', 'Anne'));
  const record = [...state.records.values()].find(value => value.sk.startsWith('I#'));
  record.matches[0].item.rating = null;
  assert.equal(await run(state, 'check', check('30', 'Lego', 'Anne')), 'Anne, Lego: Love');
  assert.ok(state.logs.length);
}));

test('propagates an aborted cache operation instead of returning a fallback result', async () => fixture(async state => {
  state.failRead = true;
  const controller = new AbortController();
  controller.abort(new Error('lookup cancelled'));
  const lookup = createItemLookup('20', '40', controller.signal);
  await assert.rejects(lookup('30', 'Anne', 'Lego'), /lookup cancelled/);
  assert.equal(state.discordCalls.length, 0);
}));
