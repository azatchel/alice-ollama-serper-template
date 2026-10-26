import { fetchJson, JOB_TTL_SECONDS, RATE_LIMIT_SECONDS } from './core.js';

// Load history + deduplicate + reserve in a single atomic Redis round trip.
export const RESERVE_SCRIPT = `
local current = redis.call('GET', KEYS[2])
local previous = nil
if current then
  previous = cjson.decode(current)
  if previous.messageId >= tonumber(ARGV[1]) then return {-1, current} end
end
if redis.call('EXISTS', KEYS[1]) == 1 then
  return {math.max(1, redis.call('PTTL', KEYS[1])), ''}
end
local job = cjson.decode(ARGV[2])
job.history = previous and previous.history or {}
local encoded = cjson.encode(job)
redis.call('SET', KEYS[1], '1', 'EX', ARGV[3])
redis.call('SET', KEYS[2], encoded, 'EX', ARGV[4])
return {0, encoded}`;

// A timed-out invocation may never overwrite a newer request.
export const COMPLETE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
if cjson.decode(current).id ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1`;

export function createStore(config, fetcher, { signal } = {}) {
  async function command(args) {
    const { response, data } = await fetchJson(fetcher, config.redisUrl, {
      method: 'POST', signal, headers: { Authorization: `Bearer ${config.redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    }, 250, 65536);
    if (!response.ok || data.error || !Object.hasOwn(data, 'result')) throw new Error('STORE_UNAVAILABLE');
    return data.result;
  }
  return {
    async reserve(keys, job) {
      const result = await command(['EVAL', RESERVE_SCRIPT, 2, keys.rate, keys.job,
        job.messageId, JSON.stringify(job), RATE_LIMIT_SECONDS, JOB_TTL_SECONDS]);
      if (!Array.isArray(result) || !Number.isInteger(result[0]) || result[0] < -1) throw new Error('STORE_UNAVAILABLE');
      const code = result[0];
      const saved = code <= 0 ? JSON.parse(result[1]) : null;
      if (code <= 0 && (!saved || typeof saved.id !== 'string')) throw new Error('STORE_UNAVAILABLE');
      return { code, job: saved };
    },
    async complete(key, job) {
      await command(['EVAL', COMPLETE_SCRIPT, 1, key, job.id, JSON.stringify(job), JOB_TTL_SECONDS]);
    }
  };
}
