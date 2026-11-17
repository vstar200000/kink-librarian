import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleCheck } from './check.js';
import { useEmptyCache } from './test-cache-support.js';

useEmptyCache();

const interaction = {
  application_id: '10',
  token: 'interaction-token',
  guild_id: '20',
  data: {
    options: [
      { name: 'user', value: '30' },
      { name: 'item', value: ' lego ' },
    ],
    resolved: { members: { 30: {} }, users: { 30: { username: 'Member' } } },
  },
};

const attachment = {
  filename: 'list.json',
  size: 100,
  url: 'https://cdn.discordapp.com/attachments/40/50/list.json',
};

const validList = {
  formatVersion: 3,
  categories: [
    { category: 'First', items: [{ name: 'Lego', rating: 'Love' }] },
    { category: 'Second', items: [{ name: 'LEGO', rating: 'Like' }] },
  ],
};

async function runCheck({ messages = [], list = validList, listsByUrl = {}, overrides = {}, request = interaction } = {}) {
  const originalFetch = globalThis.fetch;
  const originalChannel = process.env.LIST_CHANNEL_ID;
  const originalToken = process.env.DISCORD_TOKEN;
  const calls = [];
  let deferred;
  let result;
  process.env.LIST_CHANNEL_ID = '40';
  process.env.DISCORD_TOKEN = 'test-token';
  globalThis.fetch = async (input, options) => {
    assert.ok(deferred, 'the interaction must be deferred before network requests');
    const url = input.toString();
    calls.push({ url, options });
    if (url.includes('/webhooks/')) {
      result = JSON.parse(options.body);
      return new Response(null, { status: 200 });
    }
    if (url.startsWith('https://cdn.discordapp.com/')) {
      const file = Object.hasOwn(listsByUrl, url) ? listsByUrl[url] : list;
      if (file instanceof Response) return file;
      return new Response(typeof file === 'string' ? file : JSON.stringify(file));
    }
    const endpoint = url.replace('https://discord.com/api/v10/', '');
    const defaultResponses = {
      'applications/@me': { flags: 1 << 19 },
      'channels/40': { guild_id: '20', type: 15, permission_overwrites: [] },
      'guilds/20': { id: '20', owner_id: '99' },
      'guilds/20/roles': [{ id: '20', permissions: String((1 << 10) | (1 << 16)) }],
      'users/@me': { id: '50' },
      'guilds/20/members/50': { roles: [] },
      'guilds/20/threads/active': { threads: [{ id: '70', parent_id: '40', owner_id: '30' }] },
      'channels/40/threads/archived/public?limit=100': { threads: [], has_more: false },
      'channels/70/messages?limit=100': messages,
    };
    const value = Object.hasOwn(overrides, endpoint) ? overrides[endpoint] : defaultResponses[endpoint];
    assert.notEqual(value, undefined, `Unexpected request: ${endpoint}`);
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await handleCheck(request, { send: response => { deferred = response; } });
    return { deferred, result, calls };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChannel === undefined) delete process.env.LIST_CHANNEL_ID;
    else process.env.LIST_CHANNEL_ID = originalChannel;
    if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = originalToken;
  }
}

function upload(file = attachment, id = '100') {
  return { id, author: { id: '30' }, attachments: [file] };
}

function withCharacter(character) {
  return {
    ...interaction,
    data: {
      ...interaction.data,
      options: [...interaction.data.options, { name: 'character', value: character }],
    },
  };
}

test('defers privately and returns all case-insensitive matches without mentions', async () => {
  const { deferred, result } = await runCheck({ messages: [upload()] });
  assert.equal(deferred.type, 5);
  assert.equal(deferred.data.flags, 64);
  assert.deepEqual(result, {
    content: 'lego: Love\nlego: Like',
    allowed_mentions: { parse: [] },
  });
});

test('requests a character for multiple lists and selects the newest upload per name', async () => {
  const anneOld = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/51/old.json' };
  const anneNew = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/52/new.json' };
  const bob = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/53/bob.json' };
  const namedList = (name, rating) => ({
    listName: name,
    categories: [{ category: 'Food', items: [{ name: 'Lego', rating }] }],
  });
  const options = {
    messages: [upload(bob, '103'), upload(anneNew, '102'), upload(anneOld, '101')],
    listsByUrl: {
      [anneOld.url]: namedList('ANNE', 'Old'),
      [anneNew.url]: namedList('Anne', 'Love'),
      [bob.url]: namedList('Bob', 'Like'),
    },
  };

  const prompt = await runCheck(options);
  assert.match(prompt.result.content, /provide a character name/i);
  assert.match(prompt.result.content, /"Anne"/);
  assert.match(prompt.result.content, /"Bob"/);
  assert.deepEqual(prompt.result.allowed_mentions, { parse: [] });

  const selected = await runCheck({ ...options, request: withCharacter('  aNnE  ') });
  assert.equal(selected.result.content, 'aNnE, lego: Love');
  const other = await runCheck({ ...options, request: withCharacter('BOB') });
  assert.equal(other.result.content, 'BOB, lego: Like');

  const unknown = await runCheck({ ...options, request: withCharacter('Unknown') });
  assert.match(unknown.result.content, /No list was found/);
  assert.match(unknown.result.content, /"Anne"/);
  assert.match(unknown.result.content, /"Bob"/);
});

test('selects a single named list automatically and rejects an incorrect character', async () => {
  const list = { ...validList, listName: 'Anne' };
  const options = { messages: [upload()], list };
  assert.equal((await runCheck(options)).result.content, 'lego: Love\nlego: Like');
  assert.equal((await runCheck({ ...options, request: withCharacter('anne') })).result.content, 'anne, lego: Love\nanne, lego: Like');
  assert.match((await runCheck({ ...options, request: withCharacter('Bob') })).result.content, /No list was found/);
  assert.match((await runCheck({ ...options, request: withCharacter('  ') })).result.content, /Enter a character name/);
});

test('supports an unnamed legacy list only when it is the sole list', async () => {
  const unnamed = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/51/unnamed.json' };
  const named = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/52/named.json' };
  assert.equal((await runCheck({ messages: [upload(unnamed)] })).result.content, 'lego: Love\nlego: Like');
  assert.match((await runCheck({ messages: [upload(unnamed)], request: withCharacter('Anne') })).result.content, /only list has no character name/);
  const options = {
    messages: [upload(named, '102'), upload(unnamed, '101')],
    listsByUrl: { [named.url]: { ...validList, listName: 'Anne' }, [unnamed.url]: validList },
  };
  assert.match((await runCheck(options)).result.content, /unnamed list alongside named lists/);
  assert.match((await runCheck({ ...options, request: withCharacter('Anne') })).result.content, /unnamed list alongside named lists/);
});

test('reports unidentified malformed uploads rather than silently skipping a possible list', async () => {
  const bad = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/51/bad.json' };
  const good = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/52/good.json' };
  const options = {
    messages: [upload(good, '102'), upload(bad, '101')],
    listsByUrl: { [good.url]: { ...validList, listName: 'Anne' }, [bad.url]: '{' },
    request: withCharacter('Anne'),
  };
  assert.match((await runCheck(options)).result.content, /malformed/);
  options.listsByUrl[bad.url] = { ...validList, listName: 123 };
  assert.match((await runCheck(options)).result.content, /listName must be text/);
});

test('validates the newest revision of the selected character without falling back', async () => {
  const older = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/51/old.json' };
  const newer = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/52/new.json' };
  const other = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/53/other.json' };
  const options = {
    messages: [upload(other, '103'), upload(newer, '102'), upload(older, '101')],
    listsByUrl: {
      [older.url]: { ...validList, listName: 'Anne' },
      [newer.url]: { listName: 'Anne', categories: 'invalid' },
      [other.url]: { ...validList, listName: 'Bob' },
    },
  };
  assert.match((await runCheck({ ...options, request: withCharacter('Anne') })).result.content, /malformed/);
  assert.equal((await runCheck({ ...options, request: withCharacter('Bob') })).result.content, 'Bob, lego: Love\nBob, lego: Like');
});

test('returns both labeled values for split ratings alongside ordinary ratings', async () => {
  const list = {
    categories: [
      { category: 'Plain', items: [{ name: 'Lego', rating: 'Love' }] },
      { category: 'Roles', items: [{ name: 'Lego', rating: { actor: 'Love', subject: 'Ask Me' } }] },
      { category: 'Position', items: [{ name: 'Lego', rating: { center: 'Like', circle: 'Maybe' } }] },
      { category: 'People', items: [{ name: 'Lego', rating: { self: 'Yes', partner: 'No' } }] },
    ],
  };
  const { result } = await runCheck({ messages: [upload()], list });
  assert.equal(result.content, [
    'lego: Love',
    'lego: Actor: "Love", Subject: "Ask Me"',
    'lego: Center: "Like", Circle: "Maybe"',
    'lego: Self: "Yes", Partner: "No"',
  ].join('\n'));
});

test('rejects malformed split ratings', async () => {
  for (const rating of [
    null,
    ['Love', 'Like'],
    { actor: 'Love' },
    { actor: 'Love', subject: '' },
    { actor: 'Love', subject: 1 },
    { actor: 'Love', subject: 'Like', other: 'Maybe' },
  ]) {
    const list = { categories: [{ category: 'Roles', items: [{ name: 'Lego', rating }] }] };
    assert.match((await runCheck({ messages: [upload()], list })).result.content, /malformed/);
  }
});

test('distinguishes no upload, malformed list, and missing item', async () => {
  assert.match((await runCheck()).result.content, /No JSON attachment was found/);
  const malformed = await runCheck({ messages: [upload(attachment, '102'), upload(attachment, '101')], list: '{' });
  assert.match(malformed.result.content, /malformed/);
  assert.equal(malformed.calls.filter(call => call.url.startsWith('https://cdn.discordapp.com/')).length, 1);
  const list = { formatVersion: 3, categories: [{ category: 'Food', items: [{ name: 'Pizza', rating: 'Love' }] }] };
  assert.match((await runCheck({ messages: [upload()], list })).result.content, /item was not found/);
});

test('pages past other messages and selects the newest matching upload', async () => {
  const messages = Array.from({ length: 100 }, (_, i) => ({
    id: String(200 - i), author: { id: '99' }, attachments: [],
  }));
  const { result, calls } = await runCheck({
    messages,
    overrides: { 'channels/70/messages?limit=100&before=101': [upload()] },
  });
  assert.equal(result.content, 'lego: Love\nlego: Like');
  assert.ok(calls.some(call => call.url.includes('before=101')));

  const older = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/51/old.json' };
  const newest = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/52/new.json' };
  const selected = await runCheck({ messages: [upload(newest, '102'), upload(older, '101')] });
  assert.ok(selected.calls.some(call => call.url === newest.url));
  assert.ok(selected.calls.some(call => call.url === older.url));
});

test('finds the latest owner-authored upload across active and archived posts', async () => {
  const activeFile = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/51/active.json' };
  const archivedFile = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/52/archived.json' };
  const overrides = {
    'guilds/20/threads/active': {
      threads: [
        { id: '70', parent_id: '40', owner_id: '30' },
        { id: '71', parent_id: '40', owner_id: '99' },
        { id: '72', parent_id: '99', owner_id: '30' },
      ],
    },
    'channels/40/threads/archived/public?limit=100': {
      threads: [{ id: '73', parent_id: '40', owner_id: '30' }],
      has_more: false,
    },
    'channels/70/messages?limit=100': [
      { ...upload(attachment, '200'), author: { id: '99' } },
      upload(activeFile, '101'),
    ],
    'channels/73/messages?limit=100': [upload(archivedFile, '102')],
  };
  const { result, calls } = await runCheck({ overrides });
  assert.equal(result.content, 'lego: Love\nlego: Like');
  assert.ok(calls.some(call => call.url === archivedFile.url));
  assert.ok(calls.some(call => call.url === activeFile.url));
  assert.ok(!calls.some(call => /channels\/(71|72)\/messages/.test(call.url)));
});

test('paginates archived posts and considers replies as well as starter messages', async () => {
  const olderFile = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/51/older.json' };
  const newerFile = { ...attachment, url: 'https://cdn.discordapp.com/attachments/40/52/newer.json' };
  const cursor = '2026-01-01T00:00:00.000Z';
  const overrides = {
    'guilds/20/threads/active': { threads: [] },
    'channels/40/threads/archived/public?limit=100': {
      threads: [{ id: '70', parent_id: '40', owner_id: '30', thread_metadata: { archive_timestamp: cursor } }],
      has_more: true,
    },
    'channels/40/threads/archived/public?limit=100&before=2026-01-01T00%3A00%3A00.001Z': {
      threads: [
        { id: '70', parent_id: '40', owner_id: '30' },
        { id: '71', parent_id: '40', owner_id: '30' },
      ],
      has_more: false,
    },
    'channels/70/messages?limit=100': [upload(olderFile, '101')],
    'channels/71/messages?limit=100': [upload(newerFile, '102')],
  };
  const { result, calls } = await runCheck({ overrides });
  assert.equal(result.content, 'lego: Love\nlego: Like');
  assert.ok(calls.some(call => call.url.includes('before=2026-01-01T00%3A00%3A00.001Z')));
  assert.ok(calls.some(call => call.url === newerFile.url));
  assert.equal(calls.filter(call => call.url.endsWith('/channels/70/messages?limit=100')).length, 1);
});

test('ignores another member’s uploads and reports ambiguous uploads in an older post', async () => {
  const overrides = {
    'guilds/20/threads/active': {
      threads: [
        { id: '70', parent_id: '40', owner_id: '30' },
        { id: '71', parent_id: '40', owner_id: '30' },
      ],
    },
    'channels/70/messages?limit=100': [
      { ...upload(attachment, '103'), author: { id: '99' } },
      upload(attachment, '102'),
    ],
    'channels/71/messages?limit=100': [
      { ...upload(attachment, '101'), attachments: [attachment, attachment] },
    ],
  };
  assert.match((await runCheck({ overrides })).result.content, /multiple JSON attachments/);
});

test('reports an incomplete archived-post search rather than a missing file', async () => {
  const overrides = {
    'channels/40/threads/archived/public?limit=100': { threads: [], has_more: true },
  };
  assert.match((await runCheck({ overrides })).result.content, /could not page through archived forum posts/);
});

test('reports when an archived timestamp boundary cannot be paginated safely', async () => {
  const post = {
    id: '70', parent_id: '40', owner_id: '30',
    thread_metadata: { archive_timestamp: '2026-01-01T00:00:00.000123Z' },
  };
  const page = { threads: [post], has_more: true };
  const overrides = {
    'channels/40/threads/archived/public?limit=100': page,
    'channels/40/threads/archived/public?limit=100&before=2026-01-01T00%3A00%3A00.001Z': page,
  };
  assert.match((await runCheck({ overrides })).result.content, /could not page through archived forum posts/);
});

test('reports ambiguous uploads and malformed structures without falling back', async () => {
  const ambiguous = { ...upload(), attachments: [attachment, attachment] };
  assert.match((await runCheck({ messages: [ambiguous, upload()] })).result.content, /multiple JSON attachments/);
  const overrides = {
    'guilds/20/threads/active': { threads: [
      { id: '70', parent_id: '40', owner_id: '30' },
      { id: '71', parent_id: '40', owner_id: '30' },
    ] },
    'channels/70/messages?limit=100': [upload(attachment, '101')],
    'channels/71/messages?limit=100': [{ ...ambiguous, id: '102' }],
  };
  assert.match((await runCheck({ overrides })).result.content, /multiple JSON attachments/);
  assert.match((await runCheck({ messages: [upload()], list: { formatVersion: 3, categories: [{ category: 'A', items: [{}] }] } })).result.content, /malformed/);
});

test('reports inaccessible history or missing message content intent instead of no upload', async () => {
  const noHistory = { 'guilds/20/roles': [{ id: '20', permissions: String(1 << 10) }] };
  assert.match((await runCheck({ overrides: noHistory })).result.content, /Read Message History/);
  const deniedByOverwrite = {
    'channels/40': {
      guild_id: '20', type: 15,
      permission_overwrites: [{ id: '20', type: 0, allow: '0', deny: String(1 << 16) }],
    },
  };
  assert.match((await runCheck({ overrides: deniedByOverwrite })).result.content, /Read Message History/);
  assert.match((await runCheck({ overrides: { 'applications/@me': { flags: 0 } } })).result.content, /Message Content intent/);
});

test('applies role and member permission overrides in Discord order', async () => {
  const overrides = {
    'guilds/20/members/50': { roles: ['60'] },
    'guilds/20/roles': [
      { id: '20', permissions: '0' },
      { id: '60', permissions: String(1 << 10) },
    ],
    'channels/40': {
      guild_id: '20', type: 15,
      permission_overwrites: [
        { id: '20', type: 0, allow: '0', deny: String(1 << 10) },
        { id: '60', type: 0, allow: String(1 << 10), deny: String(1 << 16) },
        { id: '50', type: 1, allow: String(1 << 16), deny: '0' },
      ],
    },
  };
  assert.equal((await runCheck({ messages: [upload()], overrides })).result.content, 'lego: Love\nlego: Like');
});

test('rejects users outside the server and channels from other servers', async () => {
  const outsideUser = { ...interaction, data: { ...interaction.data, resolved: { members: {} } } };
  assert.match((await runCheck({ request: outsideUser })).result.content, /member of this server/);
  const wrongChannel = { 'channels/40': { guild_id: '99', type: 15, permission_overwrites: [] } };
  assert.match((await runCheck({ overrides: wrongChannel })).result.content, /not a forum channel in this server/);
  const textChannel = { 'channels/40': { guild_id: '20', type: 0, permission_overwrites: [] } };
  assert.match((await runCheck({ overrides: textChannel })).result.content, /not a forum channel in this server/);
});

test('rejects oversized files and non-Discord download URLs', async () => {
  assert.match((await runCheck({ messages: [upload({ ...attachment, size: 2 * 1024 * 1024 + 1 })] })).result.content, /too large/);
  assert.match((await runCheck({ messages: [upload()], list: 'x'.repeat(2 * 1024 * 1024 + 1) })).result.content, /too large/);
  assert.match((await runCheck({ messages: [upload({ ...attachment, url: 'https://example.com/list.json' })] })).result.content, /invalid download URL/);
});

test('reports Discord rate limits and inaccessible attachments separately from missing files', async () => {
  const result = await runCheck({ messages: [upload()], list: new Response(null, { status: 429 }) });
  assert.match(result.result.content, /rate limited/);
  const unavailable = await runCheck({ messages: [upload()], list: new Response(null, { status: 403 }) });
  assert.match(unavailable.result.content, /could not be downloaded/);
  const limitedHistory = {
    'channels/70/messages?limit=100': new Response('rate limited', { status: 429 }),
  };
  assert.match((await runCheck({ overrides: limitedHistory })).result.content, /rate limited/);
});

test('reports results that exceed Discord message limits', async () => {
  const list = {
    formatVersion: 3,
    categories: [{ category: 'A', items: [{ name: 'Lego', rating: 'x'.repeat(2000) }] }],
  };
  assert.match((await runCheck({ messages: [upload()], list })).result.content, /too long/);
});

test('registers the optional character option with a valid Discord name', async () => {
  const originalFetch = globalThis.fetch;
  const originalAppId = process.env.APP_ID;
  const originalToken = process.env.DISCORD_TOKEN;
  let commands;
  process.env.APP_ID = 'test-app';
  process.env.DISCORD_TOKEN = 'test-token';
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://discord.com/api/v10/applications/test-app/commands');
    commands = JSON.parse(options.body);
    return new Response(null, { status: 204 });
  };
  try {
    await import('./commands.js?registration-test');
    const check = commands.find(command => command.name === 'check');
    assert.deepEqual(check.options.map(({ name, type, required }) => [name, type, required]), [
      ['user', 6, true], ['item', 3, true], ['character', 3, false],
    ]);
    const exhibit = commands.find(command => command.name === 'exhibit');
    assert.deepEqual(exhibit.options.map(({ name, type, required }) => [name, type, required]), [
      ['item', 3, true], ['character', 3, false],
    ]);
    assert.match(exhibit.description, /your own/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAppId === undefined) delete process.env.APP_ID;
    else process.env.APP_ID = originalAppId;
    if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = originalToken;
  }
});
