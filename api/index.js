import { randomUUID } from 'node:crypto';
import { aliceResponse, fitAliceText, isSearchIntent, safeHistory, configuration, authorized,
  keysFor, searchWeb, askOllama, errorForUser, TOTAL_RESPONSE_BUDGET_MS } from '../lib/core.js';
import { createStore } from '../lib/store.js';

const ID = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

export function createHandler({ env = process.env, fetcher = fetch, storeFactory = createStore, now = Date.now } = {}) {
  return async function handler(req, res) {
    const startedAt = now();
    const remainingMs = () => Math.max(0, TOTAL_RESPONSE_BUDGET_MS - (now() - startedAt));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'alice-ollama-serper' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    let config;
    try { config = configuration(env); } catch { return res.status(503).json({ error: 'Service not configured' }); }
    try {
      if (!authorized(req, config.secret)) return res.status(403).json({ error: 'Forbidden' });
    } catch { return res.status(403).json({ error: 'Forbidden' }); }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) return res.status(415).json({ error: 'Expected JSON' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Invalid request' });
    if (Buffer.byteLength(JSON.stringify(body)) > 32768) return res.status(413).json({ error: 'Request too large' });
    const session = body.session;
    if (body.version !== '1.0' || session?.skill_id !== config.skill || !ID(session?.session_id) ||
        !ID(session?.application?.application_id) || !Number.isSafeInteger(session?.message_id) || session.message_id < 0 ||
        body.request?.type !== 'SimpleUtterance') return res.status(400).json({ error: 'Invalid Alice request' });
    const raw = body.request.command ?? body.request.original_utterance;
    if (typeof raw !== 'string' || raw.length > 1200) return res.status(400).json({ error: 'Invalid utterance' });
    const text = raw.trim();
    const reply = value => res.status(200).json(aliceResponse(value));
    if (!text) return reply('Привет! Задай вопрос — я постараюсь сразу ответить.');
    const keys = keysFor(config, session);
    const controller = new AbortController();
    const store = storeFactory(config, fetcher, { signal: controller.signal });
    const timeoutReply = 'Не успела подготовить ответ. Попробуй задать вопрос чуть короче через 15 секунд.';
    let deadlineTimer;
    const deadline = new Promise(resolve => {
      deadlineTimer = setTimeout(() => {
        controller.abort();
        resolve(timeoutReply);
      }, remainingMs());
    });
    async function respond() {
      let job;
      try {
        // Load history, deduplicate and reserve the global slot in ONE Redis round trip.
        const reservation = await store.reserve(keys, {
          id: randomUUID(), messageId: session.message_id, status: 'pending', startedAt: now()
        });
        if (reservation.code === -1) return reservation.job?.answer || 'Этот вопрос уже обрабатывается. Попробуй позже.';
        if (reservation.code > 0) return `Новый вопрос можно задать через ${Math.ceil(reservation.code / 1000)} секунд.`;
        job = reservation.job;
      } catch {
        // Fail closed: unavailable storage cannot bypass rate limiting.
        return 'Сервис временно недоступен. Попробуй позже.';
      }
      if (controller.signal.aborted) return timeoutReply;
      const history = safeHistory(job.history);
      let completed;
      try {
        const search = isSearchIntent(text)
          ? await searchWeb(fetcher, config, text, { signal: controller.signal, timeoutMs: Math.min(600, Math.max(0, remainingMs() - 1000)) })
          : { status: 'not_requested' };
        const answer = await askOllama(fetcher, config, text, history, search, {
          signal: controller.signal, timeoutMs: remainingMs() - 300
        });
        completed = { ...job, status: 'done', answer, history: safeHistory([...history, { role: 'user', text }, { role: 'assistant', text: answer }]) };
      } catch (error) {
        completed = { ...job, status: 'failed', answer: errorForUser(error), history };
      }
      // Finish before returning; no background generation or polling command.
      if (!controller.signal.aborted) {
        try { await store.complete(keys.job, completed); }
        catch { console.warn('Result could not be saved'); }
      }
      return completed.answer;
    }
    try { return reply(await Promise.race([respond(), deadline])); }
    finally { clearTimeout(deadlineTimer); controller.abort(); }
  };
}

export default createHandler();
export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
