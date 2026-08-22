/**
 * An in-memory stand-in for Durable Object storage, with the subset the
 * limiter uses. Values are cloned on write, as the real serializing storage
 * effectively does, so a caller holding a read result cannot mutate what is
 * stored without writing it back.
 */
export function fakeStorage() {
  const values = new Map();
  return {
    async get(key) {
      return values.has(key) ? structuredClone(values.get(key)) : undefined;
    },
    async put(key, value) {
      values.set(key, structuredClone(value));
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
    async list({ prefix = '', reverse = false, limit = Infinity } = {}) {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix)).sort();
      if (reverse) keys.reverse();
      return new Map(keys.slice(0, limit).map(key => [key, structuredClone(values.get(key))]));
    },
  };
}
