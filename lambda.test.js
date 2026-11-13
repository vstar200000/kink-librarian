import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import { handler as httpHandler } from './index.js';
import { handler as workerHandler } from './worker.js';

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
    data: { options: interaction.data.options, resolved: interaction.data.resolved },
  });
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
