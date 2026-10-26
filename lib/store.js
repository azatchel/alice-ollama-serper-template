import { fetchJson, JOB_TTL_SECONDS, RATE_LIMIT_SECONDS } from './core.js';

// One atomic operation across all serverless instances. Rejected requests do not extend cooldown.
export const RESERVE_SCRIPT = `
local current = redis.call('GET', KEYS[2])
if current then
  local job = cjson.decode(current)
  if job.messageId >= tonumber(ARGV[1]) then return -1 end
  if job.status == 'pending' then return -2 end
end
if redis.call('EXISTS', KEYS[1]) == 1 then
  return math.max(1, redis.call('PTTL', KEYS[1]))
end
redis.call('SET', KEYS[1], '1', 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4])
return 0`;

// A stale worker may never overwrite a newer job.
export const COMPLETE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
if cjson.decode(current).id ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1`;

export function createStore(config, fetcher) {
  async function command(args) {
    const { response, data } = await fetchJson(fetcher, config.redisUrl, {
      method: 'POST', headers: { Authorization: `Bearer ${config.redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    }, 750, 65536);
    if (!response.ok || data.error || !Object.hasOwn(data, 'result')) throw new Error('STORE_UNAVAILABLE');
    return data.result;
  }
  return {
    async get(key) { const value = await command(['GET', key]); return value === null ? null : JSON.parse(value); },
    async reserve(keys, job) {
      const result = await command(['EVAL', RESERVE_SCRIPT, 2, keys.rate, keys.job,
        job.messageId, JSON.stringify(job), RATE_LIMIT_SECONDS, JOB_TTL_SECONDS]);
      if (!Number.isInteger(result) || result < -2) throw new Error('STORE_UNAVAILABLE');
      return result;
    },
    async complete(key, job) {
      await command(['EVAL', COMPLETE_SCRIPT, 1, key, job.id, JSON.stringify(job), JOB_TTL_SECONDS]);
    }
  };
}
