import { JOB_TTL_SECONDS } from './core.js';

// Best-effort only: state belongs to this Node.js process, not the whole Vercel deployment.
export function createMemoryStore({ now = Date.now, maxEntries = 1000 } = {}) {
  const jobs = new Map();
  function cleanup(time) {
    for (const [key, entry] of jobs) if (entry.expiresAt <= time) jobs.delete(key);
  }
  return {
    reserve(keys, job) {
      const time = now();
      cleanup(time);
      const previous = jobs.get(keys.job)?.job;
      if (previous?.messageId >= job.messageId) return { code: -1, job: previous };
      // Bound memory without rate-limiting ordinary conversation.
      if (!jobs.has(keys.job) && jobs.size >= maxEntries) throw new Error('LOCAL_STORE_FULL');
      const saved = { ...job, history: previous?.history || [] };
      // No await between checking a duplicate and recording this message.
      jobs.set(keys.job, { job: saved, expiresAt: time + JOB_TTL_SECONDS * 1000 });
      return { code: 0, job: saved };
    },
    complete(key, job) {
      const time = now();
      cleanup(time);
      if (jobs.get(key)?.job.id === job.id) {
        jobs.set(key, { job, expiresAt: time + JOB_TTL_SECONDS * 1000 });
      }
    }
  };
}

const localStore = createMemoryStore();
export function createStore() { return localStore; }
