import { CacheError, createItemCache } from './item-cache.js';
import {
  findItemEntries,
  ListError,
  loadUserLists,
  selectUserList,
  validateList,
  verifyListAccess,
} from './list-utils.js';

export class ListAccessError extends ListError {}

export function createItemLookup(guildId, channelId, signal) {
  const cache = createItemCache(guildId, channelId, signal);
  const listsByUser = new Map();
  let access;

  async function checkAccess() {
    try {
      await verifyListAccess(guildId, channelId, signal);
    } catch (error) {
      if (error instanceof ListError) throw new ListAccessError(error.message);
      throw error;
    }
  }

  async function fromDiscord(user, character, item) {
    access ??= checkAccess();
    await access;
    if (!listsByUser.has(user)) {
      listsByUser.set(user, loadUserLists(guildId, channelId, user, signal));
    }
    const lists = await listsByUser.get(user);
    if (!lists.unnamed && !lists.named.size) {
      throw new ListError('No JSON attachment was found in this member’s forum posts.');
    }
    const list = selectUserList(lists, character);
    validateList(list);
    return { name: list.listName?.trim() || undefined, matches: findItemEntries(list, item) };
  }

  async function cacheOperation(label, operation) {
    try {
      return await operation();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (!(error instanceof CacheError)) throw error;
      console.error(`DynamoDB cache ${label} failed.`);
      return undefined;
    }
  }

  return async (user, character, item) => {
    let selected = character;
    let cacheAvailable = true;
    if (selected === undefined) {
      const characters = await cacheOperation('character read', () => cache.characters(user));
      if (characters === undefined) {
        cacheAvailable = false;
      } else if (characters.length) {
        const named = new Map();
        let unnamed;
        for (const name of characters) {
          if (name === undefined) unnamed = {};
          else named.set(name.trim().toLowerCase(), { name, list: { listName: name } });
        }
        selected = selectUserList({ named, unnamed }, undefined).listName;
      } else {
        cacheAvailable = false;
      }
    }

    if (cacheAvailable) {
      const cached = await cacheOperation('item read', () => cache.get(user, selected, item));
      if (cached) return cached;
    }

    const result = await fromDiscord(user, selected, item);
    if (result.matches.length) {
      await cacheOperation('write', () => cache.put(user, result.name, item, result.matches));
    }
    return result;
  };
}
