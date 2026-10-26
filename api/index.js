import { randomUUID } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { aliceResponse, fitAliceText, isSearchIntent, safeHistory, configuration, authorized,
  keysFor, searchWeb, askOllama, errorForUser } from '../lib/core.js';
import { createStore } from '../lib/store.js';

const POLL = /^(ответ|готово|готов|результат|проверить|повтори)[.!?\s]*$/i;
const ID = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

export function createHandler({ env = process.env, fetcher = fetch, defer = waitUntil, storeFactory = createStore, now = Date.now } = {}) {
  return async function handler(req, res) {
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
    if (!text) return reply('Привет! Задай вопрос. Я подготовлю ответ, затем скажи «ответ», чтобы его услышать.');
    const keys = keysFor(config, session);
    const store = storeFactory(config, fetcher);
    try {
      const previous = await store.get(keys.job);
      if (POLL.test(text) || (previous && previous.messageId >= session.message_id)) {
        if (!previous) return reply('Готового ответа пока нет или он уже устарел. Задай вопрос заново.');
        if (previous.status === 'pending') return reply(now() - previous.startedAt > 50000
          ? 'Обработка прервалась. Подожди три минуты и задай вопрос заново.'
          : 'Ответ ещё готовится. Через несколько секунд скажи «ответ».');
        return reply(previous.answer);
      }
      if (previous?.status === 'pending') return reply('Предыдущий вопрос ещё обрабатывается. Скажи «ответ», чтобы проверить результат.');
      const history = safeHistory(previous?.history);
      const job = { id: randomUUID(), messageId: session.message_id, status: 'pending', startedAt: now(), history };
      const reservation = await store.reserve(keys, job);
      if (reservation === -1 || reservation === -2) return reply('Вопрос уже принят. Через несколько секунд скажи «ответ».');
      if (reservation > 0) return reply(`Новый вопрос можно задать через ${Math.ceil(reservation / 1000)} секунд. Пока скажи «ответ», чтобы услышать предыдущий результат.`);
      const work = (async () => {
        let completed;
        try {
          const search = isSearchIntent(text) ? await searchWeb(fetcher, config, text) : { status: 'not_requested' };
          const answer = await askOllama(fetcher, config, text, history, search);
          completed = { ...job, status: 'done', answer, history: safeHistory([...history, { role: 'user', text }, { role: 'assistant', text: answer }]) };
        } catch (error) {
          completed = { ...job, status: 'failed', answer: errorForUser(error) };
          console.warn('Background generation failed');
        }
        try { await store.complete(keys.job, completed); }
        catch { console.warn('Background result could not be saved'); }
      })();
      defer(work);
      return reply('Вопрос принят. Через несколько секунд скажи «ответ», чтобы услышать результат.');
    } catch {
      // Fail closed: storage failure never bypasses rate limiting or starts inference.
      return reply('Сервис временно недоступен. Попробуй позже.');
    }
  };
}

export default createHandler();
export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
