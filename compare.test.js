import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleCompare } from './compare.js';
import { compareRatings, compareSplitRatings } from './list-utils.js';
import { useEmptyCache } from './test-cache-support.js';

useEmptyCache();

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
    content: 'lego\nYour list ("Anne"): Love\nOther member’s list ("Bob"): Actor: "Like", Subject: "Maybe"\nVerdict: Cannot compare a single rating with a split rating.',
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
  assert.equal(selected.result.content, 'lego\nYour list ("Anne"): Love\nOther member’s list ("Bob"): Maybe\nVerdict: Cannot compare unrecognized ratings.');
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
  assert.equal(result.content, 'lego\nYour list ("Anne"): Love\nOther member’s list ("Alice"): Like\nVerdict: Cannot compare unrecognized ratings.');
  assert.equal(calls.filter(url => url.includes('/threads/active')).length, 1);
});

test('reports missing uploads, malformed lists, and missing items for the right side', async () => {
  const missing = await runCompare({ otherLists: [] });
  assert.match(missing.result.content, /^Other member’s list: No JSON attachment/);
  const malformed = await runCompare({ yourLists: [{ listName: 'Anne', categories: 'invalid' }] });
  assert.match(malformed.result.content, /^Your list:.*malformed/);
  const noItem = await runCompare({ otherLists: [{ listName: 'Bob', categories: [] }] });
  assert.match(noItem.result.content, /Other member’s list: The requested item was not found/);
  assert.match(noItem.result.content, /Your list \("Anne"\): Love/);
  assert.doesNotMatch(noItem.result.content, /Verdict:/);
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
  assert.match(result.content, /Verdict \(First\): No matching item in the other member’s list\./);
  const named = await runCompare({
    yourLists,
    request: withOptions({ name: 'your_character', value: 'Anne' }),
  });
  assert.match(named.result.content, /^Your list:.*only list has no character name/);
});

test('compares scalar ratings after normalizing case and whitespace', () => {
  assert.equal(compareRatings(' Crave ', 'lOvE'), 'Both ratings are positive.');
  assert.equal(compareRatings('Willing', 'Ask Me'), 'Both ratings are neutral.');
  assert.equal(compareRatings('Love', 'Willing'), 'You like it; they are neutral.');
  assert.equal(compareRatings('Willing', 'Love'), 'You are neutral; they like it.');
  assert.equal(compareRatings('Never', 'Crave'), 'At least one rating is a limit. Avoid this.');
  assert.equal(compareRatings('Love', ' Hard Limit '), 'At least one rating is a limit. Avoid this.');
  assert.equal(compareRatings('unknown', 'Love'), 'Cannot compare unrecognized ratings.');
});

test('compares both directions of complementary split ratings', () => {
  const result = compareSplitRatings(
    { self: 'Never', partner: 'Crave' },
    { partner: 'Never', self: 'Crave' },
  );
  assert.equal(result, [
    'Your self / their partner: At least one rating is a limit. Avoid this.',
    'Your partner / their self: Both ratings are positive.',
  ].join('\n'));
  for (const [first, second] of [['actor', 'subject'], ['center', 'circle']]) {
    assert.match(compareSplitRatings(
      { [first.toUpperCase()]: 'Love', [second]: 'Willing' },
      { [second]: 'Crave', [first]: 'Ask Me' },
    ), new RegExp(`Your ${first} / their ${second}: Both ratings are positive`));
  }
  assert.match(compareSplitRatings({ self: 'Love', partner: 'Love' }, { actor: 'Love', subject: 'Love' }), /unrecognized roles/);
  assert.match(compareSplitRatings({ foo: 'Love', bar: 'Love' }, { foo: 'Love', bar: 'Love' }), /unrecognized roles/);
  assert.match(compareSplitRatings({ self: 'unknown', partner: 'Love' }, { self: 'Love', partner: 'Love' }), /unrecognized ratings/);
});

test('shows a verdict for each direction of split answers', async () => {
  const { result } = await runCompare({
    yourLists: [list('Anne', { self: 'Never', partner: 'Crave' })],
    otherLists: [list('Bob', { self: 'Crave', partner: 'Never' })],
  });
  assert.match(result.content, /Verdict: Your self \/ their partner: At least one rating is a limit\. Avoid this\./);
  assert.match(result.content, /Your partner \/ their self: Both ratings are positive\./);
});

test('pairs repeated items by category and reports ambiguous or unmatched entries', async () => {
  const categories = entries => entries.map(([category, ratings]) => ({
    category, items: ratings.map(rating => ({ name: 'Lego', rating })),
  }));
  const { result } = await runCompare({
    yourLists: [{ listName: 'Anne', categories: categories([
      ['Games', ['Love']], ['Shared', ['Love', 'Crave']], ['Only yours', ['Love']],
    ]) }],
    otherLists: [{ listName: 'Bob', categories: categories([
      [' games ', ['Crave']], ['Shared', ['Love']], ['Only theirs', ['Love']],
    ]) }],
  });
  assert.match(result.content, /Verdict \(Games\): Both ratings are positive\./);
  assert.match(result.content, /Verdict \(Shared\): Multiple matching items in this category; comparison is ambiguous\./);
  assert.match(result.content, /Verdict \(Only yours\): No matching item in the other member’s list\./);
  assert.match(result.content, /Verdict \(Only theirs\): No matching item in your list\./);
});

test('rejects invalid members and oversized results', async () => {
  const invalid = { ...interaction, member: {} };
  assert.match((await runCompare({ request: invalid })).result.content, /Choose a member/);
  const tooLong = await runCompare({ yourLists: [list('Anne', 'x'.repeat(2000))] });
  assert.match(tooLong.result.content, /too long/);
});
