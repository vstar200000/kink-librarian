import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ListError, validateList } from './list-utils.js';

const clients = new Map();
const normalize = value => value.trim().toLowerCase();
const hash = value => createHash('sha256').update(value).digest('hex');
const characterKey = name => name === undefined ? 'unnamed' : `named:${normalize(name)}`;

export class CacheError extends Error {}
export class LinkStorageError extends ListError {}

function clientFor(region) {
  if (!clients.has(region)) {
    clients.set(region, DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 2 })));
  }
  return clients.get(region);
}

export function createItemCache(guildId, channelId, signal) {
  const table = process.env.DYNAMODB_TABLE_NAME?.trim();
  const region = process.env.AWS_REGION?.trim();
  if (!table || !region) {
    throw new ListError('DynamoDB is not configured correctly. Contact the bot administrator.');
  }
  if (typeof channelId !== 'string' || !/^\d+$/.test(channelId)) {
    throw new ListError('The list channel is not configured correctly. Contact the bot administrator.');
  }
  const client = clientFor(region);
  const partition = userId => `${guildId}#${channelId}#${userId}`;
  const markerKey = name => `C#${hash(characterKey(name))}`;
  const itemKey = (name, item) => `I#${hash(characterKey(name))}#${hash(normalize(item))}`;
  async function send(command) {
    try {
      return await client.send(command, { abortSignal: signal });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new CacheError('DynamoDB request failed');
    }
  }

  return {
    async characters(userId) {
      const characters = [];
      let startKey;
      do {
        const page = await send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': partition(userId), ':prefix': 'C#' },
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }));
        for (const record of page.Items ?? []) {
          if (!record || typeof record !== 'object') throw new CacheError('Invalid character cache record');
          const name = record.name === null ? undefined : record.name;
          if (!Object.hasOwn(record, 'name') ||
              (name !== undefined && (typeof name !== 'string' || !name.trim())) ||
              record.sk !== markerKey(name)) {
            throw new CacheError('Invalid character cache record');
          }
          characters.push(name);
        }
        startKey = page.LastEvaluatedKey;
      } while (startKey);
      return characters;
    },

    async get(userId, name, item) {
      const { Item: record } = await send(new GetCommand({
        TableName: table,
        Key: { pk: partition(userId), sk: itemKey(name, item) },
        ConsistentRead: true,
      }));
      if (!record) return undefined;
      if (typeof record !== 'object') throw new CacheError('Invalid item cache record');
      const storedName = record.name === null ? undefined : record.name;
      if (!Object.hasOwn(record, 'name') ||
          (storedName !== undefined && (typeof storedName !== 'string' || !storedName.trim())) ||
          characterKey(storedName) !== characterKey(name) || record.itemKey !== normalize(item) ||
          !Array.isArray(record.matches) || !record.matches.length) {
        throw new CacheError('Invalid item cache record');
      }
      try {
        validateList({ categories: record.matches.map(match => ({
          category: match?.category,
          items: [match?.item],
        })) });
      } catch (error) {
        if (!(error instanceof ListError)) throw error;
        throw new CacheError('Invalid item cache record');
      }
      if (record.matches.some(match => normalize(match.item.name) !== normalize(item))) {
        throw new CacheError('Invalid item cache record');
      }
      return { name: storedName, matches: record.matches };
    },

    async put(userId, name, item, matches) {
      const pk = partition(userId);
      const storedName = name ?? null;
      await send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: table, Item: { pk, sk: markerKey(name), name: storedName } } },
          { Put: { TableName: table, Item: {
            pk,
            sk: itemKey(name, item),
            name: storedName,
            itemKey: normalize(item),
            matches: matches.map(({ category, item: entry }) => ({
              category, item: { name: entry.name, rating: entry.rating },
            })),
          } } },
        ],
      }));
    },
  };
}

export function createCharacterLinkStore(guildId, signal) {
  const table = process.env.DYNAMODB_TABLE_NAME?.trim();
  const region = process.env.AWS_REGION?.trim();
  if (!table || !region) {
    throw new ListError('DynamoDB is not configured correctly. Contact the bot administrator.');
  }
  if (typeof guildId !== 'string' || !/^\d+$/.test(guildId)) {
    throw new ListError('This command must be used in a server.');
  }
  const client = clientFor(region);
  const partition = userId => `LINK#${guildId}#${userId}`;
  const sortKey = name => `L#${hash(characterKey(name))}`;
  async function send(command) {
    try {
      return await client.send(command, { abortSignal: signal });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new LinkStorageError('Could not access the character link in DynamoDB. Contact the bot administrator.');
    }
  }

  return {
    async get(userId, name) {
      if (typeof userId !== 'string' || !/^\d+$/.test(userId)) {
        throw new ListError('Choose a member of this server.');
      }
      const { Item: record } = await send(new GetCommand({
        TableName: table,
        Key: { pk: partition(userId), sk: sortKey(name) },
        ConsistentRead: true,
      }));
      if (!record) return undefined;
      if (typeof record !== 'object' || typeof record.character !== 'string' ||
          normalize(record.character) !== normalize(name) ||
          typeof record.messageUrl !== 'string' || !record.messageUrl) {
        throw new LinkStorageError('The stored character link is invalid. Contact the bot administrator.');
      }
      return record.messageUrl;
    },

    async put(userId, name, messageUrl) {
      if (typeof userId !== 'string' || !/^\d+$/.test(userId)) {
        throw new ListError('This command must be used in a server.');
      }
      if (typeof name !== 'string' || !name.trim() || typeof messageUrl !== 'string' || !messageUrl) {
        throw new ListError('Enter a valid character name and message link.');
      }
      await send(new PutCommand({
        TableName: table,
        Item: {
          pk: partition(userId),
          sk: sortKey(name),
          character: name.trim(),
          messageUrl,
        },
      }));
    },
  };
}
