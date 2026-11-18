import Anthropic from '@anthropic-ai/sdk';

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/* ── Configuration ──────────────────────────────────────────────
   Resolved lazily, on first request, NOT at module scope.

   ES module imports are evaluated before the importing module's body
   runs, so `import { createAiRouter } ...` followed by `loadDotEnv()`
   evaluates this file first — and anything read from process.env up here
   would capture the environment as it was *before* .env was loaded. The
   whole file would then silently run on defaults while .env looked fine.
   (ANTHROPIC_API_KEY escaped this only because getClient reads it lazily.)

   ── Spend limits ──
   Enforced server-side, because the browser is exactly where a limit can
   be edited away. A refused call reports which limit it hit and when it
   lifts, so the console can say something better than "request failed". */
let CFG = null;
function cfg() {
  if (CFG) return CFG;
  CFG = {
    MODEL: process.env.FORGE_MODEL || 'claude-opus-5',
    EFFORT: process.env.FORGE_EFFORT || 'high',
    MAX_TOKENS: num('FORGE_AI_MAX_TOKENS', 3000),
    MIN_INTERVAL_MS: num('FORGE_AI_MIN_INTERVAL_MS', 1200),
    HOURLY_CAP: num('FORGE_AI_HOURLY_CAP', 30),
    DAILY_CAP: num('FORGE_AI_DAILY_CAP', 150),
    MAX_TURNS: num('FORGE_AI_MAX_TURNS', 4),
  };
  return CFG;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Call timestamps, newest last. Trimmed to a day on every check. */
const calls = [];
let lastCallAt = 0;

/** Cumulative token usage, for reporting rather than for gating. */
const spend = { input: 0, output: 0, requests: 0 };

function pruneCalls(now) {
  const cutoff = now - DAY;
  while (calls.length && calls[0] < cutoff) calls.shift();
}

function usage(now = Date.now()) {
  const { HOURLY_CAP, DAILY_CAP } = cfg();
  pruneCalls(now);
  const hourAgo = now - HOUR;
  const inHour = calls.reduce((n, t) => n + (t >= hourAgo ? 1 : 0), 0);
  return {
    hour: { used: inHour, cap: HOURLY_CAP, remaining: Math.max(0, HOURLY_CAP - inHour) },
    day: { used: calls.length, cap: DAILY_CAP, remaining: Math.max(0, DAILY_CAP - calls.length) },
    tokens: { ...spend },
  };
}

/**
 * @returns {null | {reason: string, retryAfterMs: number, message: string}}
 */
function checkLimits(now) {
  const { MIN_INTERVAL_MS, HOURLY_CAP, DAILY_CAP } = cfg();
  const since = now - lastCallAt;
  if (lastCallAt && since < MIN_INTERVAL_MS) {
    const wait = MIN_INTERVAL_MS - since;
    return {
      reason: 'throttled',
      retryAfterMs: wait,
      message: `Throttled — one request per ${(MIN_INTERVAL_MS / 1000).toFixed(1)}s. Try again in ${Math.ceil(wait / 100) / 10}s.`,
    };
  }

  const u = usage(now);
  if (u.hour.remaining <= 0) {
    const oldestInHour = calls.find((t) => t >= now - HOUR) ?? now;
    const wait = oldestInHour + HOUR - now;
    return {
      reason: 'hourly_cap',
      retryAfterMs: wait,
      message: `Hourly limit reached (${HOURLY_CAP} calls). Resets in ${Math.ceil(wait / 60000)} min. Raise FORGE_AI_HOURLY_CAP in .env to change it.`,
    };
  }
  if (u.day.remaining <= 0) {
    const wait = calls[0] + DAY - now;
    return {
      reason: 'daily_cap',
      retryAfterMs: wait,
      message: `Daily limit reached (${DAILY_CAP} calls). Resets in ${Math.ceil(wait / HOUR)} h. Raise FORGE_AI_DAILY_CAP in .env to change it.`,
    };
  }
  return null;
}

// Server-side refusal fallback: on a policy decline the API re-runs the request
// on Anthropic's recommended fallback model inside the same call.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let client = null;
let clientBase = null;

/**
 * A key whose prefix isn't `sk-ant-` belongs to some other service. Several of
 * those front Anthropic with a compatible endpoint, in which case the only
 * thing missing is where to send the request — so FORGE_AI_BASE_URL redirects
 * the SDK without any other change.
 */
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const baseURL = process.env.FORGE_AI_BASE_URL || null;
  if (!client || client.apiKey !== apiKey || clientBase !== baseURL) {
    client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    clientBase = baseURL;
  }
  return client;
}

/** Flagged in /status so a rejected key points at its likely cause. */
function keyShape(apiKey) {
  if (!apiKey) return null;
  const anthropic = apiKey.startsWith('sk-ant-');
  return {
    prefix: apiKey.slice(0, apiKey.indexOf('-', 3) + 1) || apiKey.slice(0, 7),
    looksAnthropic: anthropic,
    baseUrl: process.env.FORGE_AI_BASE_URL || 'https://api.anthropic.com (default)',
    note: anthropic
      ? undefined
      : 'This key is not in Anthropic\'s format (sk-ant-…). If it belongs to a service that proxies Anthropic, set FORGE_AI_BASE_URL in .env to that service\'s endpoint. Otherwise api.anthropic.com will reject it with a 401.',
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Streams from Anthropic (so a long thinking turn never trips an HTTP timeout)
 * and returns the accumulated final message.
 */
async function callClaude(anthropic, { system, messages, tools }) {
  const { MODEL, MAX_TOKENS, EFFORT } = cfg();
  const base = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT },
    system,
    messages,
    ...(tools?.length ? { tools } : {}),
  };

  try {
    const stream = anthropic.beta.messages.stream({
      ...base,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
    });
    return await stream.finalMessage();
  } catch (err) {
    // If this deployment doesn't have the server-side fallback beta, retry plain.
    const status = err?.status;
    const msg = String(err?.message || '');
    const isFallbackReject =
      status === 400 && /fallback|beta/i.test(msg);
    if (!isFallbackReject) throw err;

    const stream = anthropic.messages.stream(base);
    return await stream.finalMessage();
  }
}

/**
 * Connect-style middleware. Mount at `/api/ai`.
 *   GET  /status  -> { ready, model }
 *   POST /chat    -> { message } (a full Anthropic assistant message)
 */
export function createAiRouter() {
  return async function aiRouter(req, res, next) {
    const url = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

    if (url === '/status' || url === '/') {
      const c = cfg();
      const ready = Boolean(process.env.ANTHROPIC_API_KEY);
      return json(res, 200, {
        ready,
        model: ready ? c.MODEL : null,
        effort: c.EFFORT,
        key: keyShape(process.env.ANTHROPIC_API_KEY),
        limits: {
          maxTokens: c.MAX_TOKENS,
          minIntervalMs: c.MIN_INTERVAL_MS,
          hourlyCap: c.HOURLY_CAP,
          dailyCap: c.DAILY_CAP,
          maxTurns: c.MAX_TURNS,
        },
        usage: usage(),
      });
    }

    if (url !== '/chat') {
      if (typeof next === 'function') return next();
      return json(res, 404, { error: 'not_found' });
    }

    if (req.method !== 'POST') {
      return json(res, 405, { error: 'method_not_allowed' });
    }

    const anthropic = getClient();
    if (!anthropic) {
      return json(res, 503, {
        error: 'no_api_key',
        message:
          'ANTHROPIC_API_KEY is not set. Add it to .env and restart — the console will stay on the local intent engine until then.',
      });
    }

    // Gate before reading the body, so a refused call costs nothing upstream.
    const now = Date.now();
    const blocked = checkLimits(now);
    if (blocked) {
      res.setHeader('Retry-After', String(Math.ceil(blocked.retryAfterMs / 1000)));
      return json(res, 429, {
        error: blocked.reason,
        message: blocked.message,
        retryAfterMs: blocked.retryAfterMs,
        usage: usage(now),
      });
    }

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { error: 'bad_request', message: err.message });
    }

    const { system, messages, tools } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return json(res, 400, {
        error: 'bad_request',
        message: '`messages` must be a non-empty array.',
      });
    }

    try {
      // Count the call at the point of dispatch, so a slow reply can't let a
      // second request slip past the throttle while the first is in flight.
      lastCallAt = Date.now();
      calls.push(lastCallAt);
      spend.requests++;

      const message = await callClaude(anthropic, { system, messages, tools });

      spend.input += message?.usage?.input_tokens ?? 0;
      spend.output += message?.usage?.output_tokens ?? 0;

      return json(res, 200, { message, usage: usage() });
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      console.error('[agent-forge] Anthropic call failed:', err?.message || err);
      return json(res, status, {
        error: err?.error?.error?.type || err?.name || 'api_error',
        message: err?.message || 'Upstream call failed.',
      });
    }
  };
}
