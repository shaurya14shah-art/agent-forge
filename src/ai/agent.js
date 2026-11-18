/* ───────────────────────────────────────────────────────────────
   Claude design agent.

   The tool-use loop runs in the browser so tools execute directly
   against the live scene; the proxy at /api/ai only relays to
   Anthropic, keeping the key out of the client entirely.
   ─────────────────────────────────────────────────────────────── */

import { SYSTEM_PROMPT } from './tools.js';

/* The tool-use loop is the real multiplier on spend: one prompt can become
   many billed calls as the agent chains tools. The server caps rate and
   volume; this caps depth. Overridden by whatever the proxy reports, so
   .env stays the single source of truth. */
let MAX_TURNS = 4;
const HISTORY_LIMIT = 24;

export async function probeStatus() {
  try {
    const res = await fetch('/api/ai/status', { cache: 'no-store' });
    if (!res.ok) return { ready: false, reason: `status ${res.status}` };
    const status = await res.json();
    if (status.limits?.maxTurns) MAX_TURNS = status.limits.maxTurns;
    return status;
  } catch (err) {
    return { ready: false, reason: err.message };
  }
}

const SKETCH_SYSTEM = `You identify rough sketches so they can be matched against a 3D model catalogue.

The catalogue is a general-purpose props library — furniture, containers, tools, vehicles, plants, everyday objects. It does not contain aerospace hardware or engineering parts.

Reply with JSON only, no prose and no code fence:
{"description":"<what the drawing appears to be, a few words>","query":"<1-3 words to search the catalogue with>"}

The query must be a common, concrete object noun, singular, no adjectives unless they are load-bearing ("office chair" is fine, "beautiful modern chair" is not). If the drawing is too ambiguous to call, pick the most likely everyday object it resembles rather than refusing — the operator can see the results and reject them.`;

/**
 * Identify a sketch. Uses the same proxy as the agent, so the key still
 * never reaches the browser.
 *
 * @param {string} dataUrl a PNG data URL from the sketch canvas
 */
export async function identifySketch(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  if (!base64) throw new Error('The sketch canvas produced no image.');

  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system: SKETCH_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
          { type: 'text', text: 'What is this a drawing of?' },
        ],
      }],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);

  const text = (data.message?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // Be forgiving about a stray code fence or surrounding prose.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('The identification came back unparseable.');
  const parsed = JSON.parse(match[0]);
  if (!parsed.query) throw new Error('No search term came back.');
  return { description: parsed.description || parsed.query, query: String(parsed.query).trim() };
}

export function createAgent({ toolbox, onText, onTool, onError, onBusy, onUsage }) {
  /** @type {Array<{role: string, content: any}>} */
  const messages = [];

  function trim() {
    // Keep the transcript bounded but never cut a tool_use away from its
    // tool_result — that pairing is required by the API.
    while (messages.length > HISTORY_LIMIT) {
      messages.shift();
      while (messages.length && messages[0].role !== 'user') messages.shift();
      // Drop a leading tool-result-only user turn (its tool_use is gone).
      const first = messages[0];
      if (
        first &&
        Array.isArray(first.content) &&
        first.content.every((b) => b.type === 'tool_result')
      ) {
        messages.shift();
        while (messages.length && messages[0].role !== 'user') messages.shift();
      }
    }
  }

  async function post(payload) {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || `Request failed (${res.status})`);
      err.code = data.error;
      throw err;
    }
    if (data.usage) onUsage?.(data.usage);
    return data.message;
  }

  async function send(userText) {
    messages.push({ role: 'user', content: userText });
    trim();
    onBusy?.(true);

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const message = await post({
          system: SYSTEM_PROMPT,
          messages,
          tools: toolbox.definitions,
        });

        // Echo the assistant turn back verbatim — thinking blocks and all.
        messages.push({ role: 'assistant', content: message.content });

        if (message.stop_reason === 'refusal') {
          onError?.(
            `Declined${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}. Rephrase, or run the command locally.`
          );
          return;
        }

        const text = message.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (text) onText?.(text);

        const toolUses = message.content.filter((b) => b.type === 'tool_use');
        if (!toolUses.length) return;

        const results = [];
        for (const call of toolUses) {
          const result = await toolbox.execute(call.name, call.input);
          onTool?.(call.name, call.input, result);
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(result),
            ...(result?.ok === false ? { is_error: true } : {}),
          });
        }

        // All results for one assistant turn go back in a single user message.
        messages.push({ role: 'user', content: results });
        trim();
      }

      onError?.(`Stopped after ${MAX_TURNS} tool rounds without settling. Try a narrower request.`);
    } catch (err) {
      onError?.(err.message || String(err));
    } finally {
      onBusy?.(false);
    }
  }

  function reset() {
    messages.length = 0;
  }

  return { send, reset, get transcript() { return messages; } };
}
