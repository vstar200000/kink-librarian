import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import { handler as httpHandler } from './index.js';
import { handler as workerHandler } from './worker.js';
import { useEmptyCache } from './test-cache-support.js';

useEmptyCache();

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const timestamp = '1730000000';

function signedEvent(body, base64 = false) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const signature = sign(null, Buffer.from(timestamp + raw), privateKey).toString('hex');
  return {
    requestContext: { http: { method: 'POST' } },
    headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
    body: base64 ? Buffer.from(raw).toString('base64') : raw,
    isBase64Encoded: base64,
  };
}

async function withSettings(fn) {
  const oldPublicKey = process.env.PUBLIC_KEY;
  const oldQueueUrl = process.env.SQS_QUEUE_URL;
  const oldSend = SQSClient.prototype.send;
  process.env.PUBLIC_KEY = publicKeyHex;
  process.env.SQS_QUEUE_URL = 'https://sqs.example.test/queue';
  try {
    return await fn();
  } finally {
    SQSClient.prototype.send = oldSend;
    if (oldPublicKey === undefined) delete process.env.PUBLIC_KEY;
    else process.env.PUBLIC_KEY = oldPublicKey;
    if (oldQueueUrl === undefined) delete process.env.SQS_QUEUE_URL;
    else process.env.SQS_QUEUE_URL = oldQueueUrl;
  }
}

const interaction = {
  id: '90',
  type: 2,
  application_id: '10',
  token: 'test-interaction-token',
  guild_id: '20',
  data: {
    name: 'check',
    options: [{ name: 'user', type: 6, value: '30' }, { name: 'item', type: 3, value: 'Lego' }],
    resolved: { users: { 30: { username: 'Member' } }, members: { 30: {} } },
  },
};

test('verifies signed PING and rejects unsigned or modified requests', async () => withSettings(async () => {
  let sends = 0;
  SQSClient.prototype.send = async () => { sends++; };
  const ping = await httpHandler(signedEvent({ type: 1 }));
  assert.equal(ping.statusCode, 200);
  assert.deepEqual(JSON.parse(ping.body), { type: 1 });
  const modified = signedEvent(interaction);
  modified.body += ' ';
  assert.equal((await httpHandler(modified)).statusCode, 401);
  const missing = signedEvent(interaction);
  missing.headers = {};
  assert.equal((await httpHandler(missing)).statusCode, 401);
  assert.equal(sends, 0);
}));

test('queues a verified base64 check and returns an ephemeral defer', async () => withSettings(async () => {
  let message;
  SQSClient.prototype.send = async command => {
    message = command.input;
    return {};
  };
  const response = await httpHandler(signedEvent(interaction, true));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { type: 5, data: { flags: 64 } });
  assert.equal(message.QueueUrl, process.env.SQS_QUEUE_URL);
  assert.deepEqual(JSON.parse(message.MessageBody), {
    application_id: interaction.application_id,
    token: interaction.token,
    guild_id: interaction.guild_id,
    member: { user: {} },
    data: { name: 'check', options: interaction.data.options, resolved: interaction.data.resolved },
  });
}));

test('queues exhibit publicly and dispatches a self-only lookup to the worker', async () => withSettings(async () => {
  let message;
  SQSClient.prototype.send = async command => { message = command.input.MessageBody; };
  const request = {
    ...interaction,
    member: { user: { id: '32', username: 'Requester' } },
    data: { name: 'exhibit', options: [{ name: 'item', type: 3, value: 'Lego' }] },
  };
  const response = await httpHandler(signedEvent(request));
  assert.deepEqual(JSON.parse(response.body), { type: 5, data: {} });
  const job = JSON.parse(message);
  assert.equal(job.data.name, 'exhibit');
  assert.deepEqual(job.member, { user: { id: '32' } });
  assert.deepEqual(job.data.options, request.data.options);

  const oldFetch = globalThis.fetch;
  const oldChannel = process.env.LIST_CHANNEL_ID;
  const requests = [];
  let result;
  process.env.LIST_CHANNEL_ID = '40';
  globalThis.fetch = async (input, options) => {
    const url = input.toString();
    requests.push(url);
    if (url.includes('/webhooks/')) {
      result = JSON.parse(options.body);
      return new Response(null, { status: 200 });
    }
    if (url.startsWith('https://cdn.discordapp.com/')) {
      return new Response(JSON.stringify({
        listName: 'Requester',
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
        { id: '70', parent_id: '40', owner_id: '32' },
        { id: '71', parent_id: '40', owner_id: '30' },
      ] },
      'channels/40/threads/archived/public?limit=100': { threads: [], has_more: false },
      'channels/70/messages?limit=100': [{
        id: '100',
        author: { id: '32' },
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
    assert.deepEqual(await workerHandler({ Records: [{ messageId: 'exhibit', body: message }] }), { batchItemFailures: [] });
    assert.equal(result.content, 'Lego: Love');
    assert.ok(requests.includes('https://discord.com/api/v10/channels/70/messages?limit=100'));
    assert.ok(!requests.some(url => url.includes('/channels/71/messages?')));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldChannel === undefined) delete process.env.LIST_CHANNEL_ID;
    else process.env.LIST_CHANNEL_ID = oldChannel;
  }
}));

test('handles test commands and rejects invalid or unsupported events', async () => withSettings(async () => {
  const response = await httpHandler(signedEvent({ type: 2, data: { name: 'test' } }));
  const payload = JSON.parse(response.body);
  assert.equal(payload.type, 4);
  assert.equal(payload.data.flags, 64 | 32768);
  assert.match(payload.data.components[0].content, /^hello world /);
  assert.equal((await httpHandler(signedEvent('{'))).statusCode, 400);
  assert.equal((await httpHandler(signedEvent(null))).statusCode, 400);
  assert.equal((await httpHandler(signedEvent({ type: 2, data: { name: 'other' } }))).statusCode, 400);
  const wrongMethod = signedEvent({ type: 1 });
  wrongMethod.requestContext.http.method = 'GET';
  assert.equal((await httpHandler(wrongMethod)).statusCode, 405);
}));

test('queues compare with the invoking member and dispatches it to the compare worker', async () => withSettings(async () => {
  let message;
  SQSClient.prototype.send = async command => { message = command.input.MessageBody; };
  const request = {
    ...interaction,
    member: { user: { id: '32', username: 'Requester' }, roles: ['60'] },
    data: { name: 'compare', options: [
      { name: 'other_user', value: '30' }, { name: 'item', value: 'Lego' },
    ], resolved: interaction.data.resolved },
  };
  const response = await httpHandler(signedEvent(request));
  assert.equal(JSON.parse(response.body).type, 5);
  const job = JSON.parse(message);
  assert.equal(job.data.name, 'compare');
  assert.deepEqual(job.member, { user: { id: '32' } });

  const oldFetch = globalThis.fetch;
  const oldChannel = process.env.LIST_CHANNEL_ID;
  let result;
  process.env.LIST_CHANNEL_ID = '40';
  globalThis.fetch = async (url, options) => {
    url = url.toString();
    if (url.includes('/webhooks/')) {
      result = JSON.parse(options.body);
      return new Response(null, { status: 200 });
    }
    if (url.startsWith('https://cdn.discordapp.com/')) {
      const name = url.endsWith('/32.json') ? 'Requester' : 'Other';
      return new Response(JSON.stringify({
        listName: name,
        categories: [{ category: 'Games', items: [{ name: 'Lego', rating: name === 'Requester' ? 'Love' : 'Crave' }] }],
      }));
    }
    const endpoint = url.replace('https://discord.com/api/v10/', '');
    const upload = owner => [{
      id: '100', author: { id: owner },
      attachments: [{ filename: 'list.json', size: 100, url: `https://cdn.discordapp.com/${owner}.json` }],
    }];
    const responses = {
      'applications/@me': { flags: 1 << 19 },
      'channels/40': { guild_id: '20', type: 15, permission_overwrites: [] },
      'guilds/20': { id: '20', owner_id: '99' },
      'guilds/20/roles': [{ id: '20', permissions: String((1 << 10) | (1 << 16)) }],
      'users/@me': { id: '50' },
      'guilds/20/members/50': { roles: [] },
      'guilds/20/threads/active': { threads: [
        { id: '70', parent_id: '40', owner_id: '32' },
        { id: '71', parent_id: '40', owner_id: '30' },
      ] },
      'channels/40/threads/archived/public?limit=100': { threads: [], has_more: false },
      'channels/70/messages?limit=100': upload('32'),
      'channels/71/messages?limit=100': upload('30'),
    };
    assert.ok(Object.hasOwn(responses, endpoint), `Unexpected request: ${endpoint}`);
    return new Response(JSON.stringify(responses[endpoint]));
  };
  try {
    assert.deepEqual(await workerHandler({ Records: [{ messageId: 'compare', body: message }] }), { batchItemFailures: [] });
    assert.equal(result.content, 'Lego\nYour list ("Requester"): Love\nOther member’s list ("Other"): Crave\nVerdict: Both ratings are positive.');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldChannel === undefined) delete process.env.LIST_CHANNEL_ID;
    else process.env.LIST_CHANNEL_ID = oldChannel;
  }
}));

test('returns a private error when queueing fails without logging request data', async () => withSettings(async () => {
  const oldError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  SQSClient.prototype.send = async () => { throw new Error('test-interaction-token'); };
  try {
    const response = await httpHandler(signedEvent(interaction));
    const payload = JSON.parse(response.body);
    assert.equal(payload.type, 4);
    assert.equal(payload.data.flags, 64);
    assert.match(payload.data.content, /Could not queue/);
    assert.ok(!logs.join('\n').includes(interaction.token));
  } finally {
    console.error = oldError;
  }
}));

test('returns a public error when exhibit queueing fails', async () => withSettings(async () => {
  SQSClient.prototype.send = async () => { throw new Error('queue failure'); };
  const request = {
    ...interaction,
    data: { name: 'exhibit', options: [{ name: 'item', type: 3, value: 'Lego' }] },
  };
  const response = await httpHandler(signedEvent(request));
  const payload = JSON.parse(response.body);
  assert.equal(payload.type, 4);
  assert.equal(Object.hasOwn(payload.data, 'flags'), false);
  assert.match(payload.data.content, /Could not queue/);
}));

test('worker retries an early response edit and reports only failed SQS records', async () => {
  const oldFetch = globalThis.fetch;
  const oldError = console.error;
  const oldChannel = process.env.LIST_CHANNEL_ID;
  const attempts = [];
  const logs = [];
  process.env.LIST_CHANNEL_ID = '40';
  console.error = (...args) => logs.push(args.join(' '));
  globalThis.fetch = async (input, options) => {
    const url = input.toString();
    attempts.push({ url, options });
    if (url.includes('/early-token/')) {
      return new Response(null, { status: attempts.filter(call => call.url.includes('/early-token/')).length === 1 ? 404 : 200 });
    }
    return new Response(null, { status: 503 });
  };
  const job = token => JSON.stringify({ application_id: '10', token, guild_id: '20', data: {} });
  try {
    const response = await workerHandler({ Records: [
      { messageId: 'early', body: job('early-token') },
      { messageId: 'failed', body: job('failed-token') },
      { messageId: 'invalid', body: '{' },
    ] });
    assert.deepEqual(response, { batchItemFailures: [{ itemIdentifier: 'failed' }, { itemIdentifier: 'invalid' }] });
    assert.equal(attempts.filter(call => call.url.includes('/early-token/')).length, 2);
    const sent = JSON.parse(attempts[1].options.body);
    assert.match(sent.content, /Choose a member/);
    assert.deepEqual(sent.allowed_mentions, { parse: [] });
    assert.ok(!logs.join('\n').includes('failed-token'));
  } finally {
    globalThis.fetch = oldFetch;
    console.error = oldError;
    if (oldChannel === undefined) delete process.env.LIST_CHANNEL_ID;
    else process.env.LIST_CHANNEL_ID = oldChannel;
  }
});
