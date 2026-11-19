import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createCharacterLinkStore } from './item-cache.js';
import { handleLink, handleRegister } from './links.js';
import { ListError, verifyMessageLink } from './list-utils.js';
import { handler as workerHandler } from './worker.js';

async function withFixture(fn) {
  const original = {
    send: DynamoDBDocumentClient.prototype.send,
    fetch: globalThis.fetch,
    table: process.env.DYNAMODB_TABLE_NAME,
    region: process.env.AWS_REGION,
    token: process.env.DISCORD_TOKEN,
  };
  process.env.DYNAMODB_TABLE_NAME = 'test-links';
  process.env.AWS_REGION = 'us-east-1';
  process.env.DISCORD_TOKEN = 'test-token';
  const records = new Map();
  const state = {
    records, discordRequests: [], webhookResponses: [],
    channelId: '70', channelGuildId: '20', channelParentId: null,
    messageId: '100', message: null, parentMessage: null,
  };
  const recordKey = ({ pk, sk }) => `${pk}|${sk}`;
  DynamoDBDocumentClient.prototype.send = async command => {
    if (command instanceof GetCommand) return { Item: records.get(recordKey(command.input.Key)) };
    if (command instanceof PutCommand) {
      records.set(recordKey(command.input.Item), structuredClone(command.input.Item));
      return {};
    }
    throw new Error('Unexpected DynamoDB command');
  };
  globalThis.fetch = async (input, options) => {
    const url = input.toString();
    if (url.includes('/webhooks/')) {
      state.webhookResponses.push(JSON.parse(options.body));
      return new Response(null, { status: 200 });
    }
    const endpoint = url.replace('https://discord.com/api/v10/', '');
    state.discordRequests.push(endpoint);
    const responses = {
      [`channels/${state.channelId}`]: {
        guild_id: state.channelGuildId,
        ...(state.channelParentId ? { parent_id: state.channelParentId } : {}),
      },
      [`channels/${state.channelId}/messages/${state.messageId}`]: state.message || {
        id: state.messageId,
        channel_id: state.channelId,
        author: { id: '30' },
        attachments: [],
      },
    };
    if (state.channelParentId && state.parentMessage) {
      responses[`channels/${state.channelParentId}/messages/${state.parentMessage.id}`] = state.parentMessage;
    }
    if (!Object.hasOwn(responses, endpoint)) throw new Error(`Unexpected request: ${endpoint}`);
    return new Response(JSON.stringify(responses[endpoint]));
  };
  try {
    await fn(state);
  } finally {
    DynamoDBDocumentClient.prototype.send = original.send;
    globalThis.fetch = original.fetch;
    for (const [key, value] of Object.entries({
      DYNAMODB_TABLE_NAME: original.table,
      AWS_REGION: original.region,
      DISCORD_TOKEN: original.token,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const messageUrl = 'https://discord.com/channels/20/70/100';
const interaction = (name, options, user = '30') => ({
  application_id: '10',
  token: 'test-token',
  guild_id: '20',
  member: { user: { id: user } },
  data: { name, options, resolved: { members: { 30: {}, 31: {} } } },
});

test('validates message URLs, guild, and author without requiring attachments', async () => withFixture(async state => {
  assert.equal(await verifyMessageLink(messageUrl, '20', '30'), messageUrl);
  assert.deepEqual(state.discordRequests, ['channels/70', 'channels/70/messages/100']);

  const before = state.discordRequests.length;
  await assert.rejects(
    verifyMessageLink('https://discord.com.evil.test/channels/20/70/100', '20', '30'),
    ListError,
  );
  await assert.rejects(verifyMessageLink(messageUrl.replace('/20/', '/21/'), '20', '30'), /this server/);
  assert.equal(state.discordRequests.length, before);

  state.channelGuildId = '21';
  await assert.rejects(verifyMessageLink(messageUrl, '20', '30'), /this server/);
  state.channelGuildId = '20';
  await assert.rejects(verifyMessageLink(messageUrl, '20', '31'), /only register a message that you posted/);
}));

test('verifies thread starter links against the referenced parent message author', async () => withFixture(async state => {
  state.channelId = '100';
  state.channelParentId = '40';
  state.message = {
    id: '100',
    channel_id: '100',
    type: 21,
    author: { id: '999' },
    message_reference: { channel_id: '40', message_id: '100' },
  };
  state.parentMessage = {
    id: '100',
    channel_id: '40',
    author: { id: '30' },
  };
  const threadHeadUrl = 'https://discord.com/channels/20/100/100';

  assert.equal(await verifyMessageLink(threadHeadUrl, '20', '30'), threadHeadUrl);
  assert.deepEqual(state.discordRequests, [
    'channels/100',
    'channels/100/messages/100',
    'channels/40/messages/100',
  ]);

  await handleRegister(interaction('register', [
    { name: 'message_link', value: threadHeadUrl },
    { name: 'character', value: 'Head' },
  ]), { send() {} });
  assert.equal([...state.records.values()][0].messageUrl, threadHeadUrl);

  state.parentMessage.author.id = '31';
  await assert.rejects(verifyMessageLink(threadHeadUrl, '20', '30'), /only register a message that you posted/);
}));

test('registers and replaces a member character link; link reads DynamoDB only', async () => withFixture(async state => {
  const response = { send() {} };
  const register = interaction('register', [
    { name: 'message_link', value: messageUrl },
    { name: 'character', value: '  Anne  ' },
  ]);
  const registrationJob = {
    application_id: '10',
    token: 'test-interaction-token',
    guild_id: '20',
    member: register.member,
    data: register.data,
  };
  assert.deepEqual(await workerHandler({
    Records: [{ messageId: 'register', body: JSON.stringify(registrationJob) }],
  }), { batchItemFailures: [] });
  assert.match(state.webhookResponses.at(-1).content, /Registered the message link/);
  const stored = [...state.records.values()][0];
  assert.equal(stored.character, 'Anne');
  assert.equal(stored.messageUrl, messageUrl);

  state.messageId = '101';
  const replacementUrl = 'https://discord.com/channels/20/70/101';
  await handleRegister({ ...register, data: { ...register.data, options: [
    { name: 'message_link', value: replacementUrl },
    { name: 'character', value: 'anne' },
  ] } }, response);
  assert.equal(state.records.size, 1);
  assert.equal([...state.records.values()][0].messageUrl, replacementUrl);

  const discordRequestCount = state.discordRequests.length;
  const store = createCharacterLinkStore('20', AbortSignal.timeout(1000));
  await store.put('31', 'Bob', 'https://discord.com/channels/20/70/200');
  const job = {
    application_id: '10',
    token: 'test-interaction-token',
    guild_id: '20',
    member: { user: { id: '30' } },
    data: {
      name: 'link',
      options: [{ name: 'user', value: '31' }, { name: 'character', value: 'bob' }],
      resolved: { members: { 31: {} } },
    },
  };
  assert.deepEqual(await workerHandler({
    Records: [{ messageId: 'link', body: JSON.stringify(job) }],
  }), { batchItemFailures: [] });
  assert.equal(state.webhookResponses.at(-1).content, 'https://discord.com/channels/20/70/200');
  assert.equal(state.discordRequests.length, discordRequestCount);
  await handleLink(interaction('link', [
    { name: 'user', value: '31' },
    { name: 'character', value: 'bob' },
  ]), response);
  assert.equal(state.webhookResponses.at(-1).content, 'https://discord.com/channels/20/70/200');
}));

test('link command schema requires a character and keeps target-member and visibility options', async () => {
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
    await import('./commands.js?links-registration-test');
    const registered = commands.find(command => command.name === 'register');
    assert.deepEqual(registered.options.map(({ name, required }) => [name, required]), [
      ['message_link', true], ['character', true],
    ]);
    const link = commands.find(command => command.name === 'link');
    assert.deepEqual(link.options.map(({ name, required }) => [name, required]), [
      ['user', true], ['character', true], ['visible', false],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAppId === undefined) delete process.env.APP_ID;
    else process.env.APP_ID = originalAppId;
    if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = originalToken;
  }
});
