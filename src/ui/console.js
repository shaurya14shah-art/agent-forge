/* ───────────────────────────────────────────────────────────────
   The command console — a 3D panel docked at the bottom of the
   projection volume, tilted back like a workbench surface.
   ─────────────────────────────────────────────────────────────── */

import { createAgent, probeStatus } from '../ai/agent.js';
import { parseIntent, summariseResult } from '../ai/localIntent.js';

const GREETING_ONLINE = (model) =>
  `Design agent online — ${model}. The thrust chamber is live: ask for changes, analysis, or a section view and I'll drive the display.`;

const GREETING_LOCAL =
  'No API key loaded, so the local intent engine has the controls. Everything still works — type `help` for the command set. Drop ANTHROPIC_API_KEY into .env and restart to hand over to Claude.';

export function createConsole({ hud, store, app, toolbox }) {
  const panel = hud.panel('console', {
    anchor: 'bottom',
    title: 'Design Agent',
    tag: 'STANDBY',
    size: 'wide',
  });

  panel.body.innerHTML = `
    <div class="console-log" data-role="log"></div>
    <div class="console-input">
      <span class="caret">›</span>
      <span class="console-focus" data-role="focus" hidden></span>
      <input type="text" autocomplete="off" spellcheck="false"
             placeholder="Section it and tell me why the throat is the constraint" />
    </div>
  `;

  const logEl = panel.body.querySelector('[data-role="log"]');
  const input = panel.body.querySelector('input');
  const focusChip = panel.body.querySelector('[data-role="focus"]');
  const badge = document.getElementById('rail-ai');

  const PLACEHOLDER = 'Section it and tell me why the throat is the constraint';

  /**
   * Show what "this" currently means. Without the chip, the fact that you can
   * point at a component and then talk about it is invisible — and a pronoun
   * you can't see the referent of is worse than no pronoun at all.
   */
  function setFocus(label) {
    focusChip.hidden = !label;
    focusChip.textContent = label ?? '';
    input.placeholder = label ? `Ask about ${label}, or say "make this…"` : PLACEHOLDER;
  }

  store.on('ui', ({ key, value }) => {
    if (key !== 'selected') return;
    setFocus(value ? app.partLabel(value) : null);
  });

  let busyLine = null;
  let agent = null;
  let ready = false;

  function line(kind, html, who = '') {
    const el = document.createElement('div');
    el.className = `line ${kind}`;
    el.innerHTML = `<span class="who">${who}</span><span class="msg">${html}</span>`;
    logEl.appendChild(el);
    logEl.scrollTop = logEl.scrollHeight;
    return el;
  }

  const log = {
    user: (t) => line('user', escapeHtml(t), 'you'),
    agent: (t) => line('agent', escapeHtml(t).replace(/\n/g, '<br>'), 'agent'),
    tool: (name, summary) => line('tool', `<span class="op">${name}</span> ${escapeHtml(summary)}`),
    sys: (t) => line('sys', escapeHtml(t).replace(/\n/g, '<br>')),
    err: (t) => line('err', escapeHtml(t), 'error'),
  };

  function setBusy(on) {
    input.disabled = on;
    if (on) {
      busyLine = line('agent', '<span class="thinking"><i></i><i></i><i></i></span>', 'agent');
    } else {
      busyLine?.remove();
      busyLine = null;
      input.focus();
    }
  }

  function setBadge(state, text) {
    if (!badge) return;
    badge.className = `badge ${state}`;
    badge.textContent = text;
  }

  /**
   * Spend is invisible otherwise: you find out you are rate limited by being
   * refused. The badge carries the remaining hourly budget so the ceiling is
   * something you can see coming.
   */
  let limits = null;
  function showUsage(usage) {
    if (!usage || !badge) return;
    const { used, cap } = usage.hour;
    const left = Math.max(0, cap - used);
    badge.textContent = `${limits?.model ?? 'AI'} · ${left}/${cap} this hour`;
    badge.className = `badge ${left === 0 ? 'error' : left <= Math.max(2, cap * 0.2) ? 'offline' : 'online'}`;
    badge.title =
      `${used} of ${cap} calls this hour, ${usage.day.used} of ${usage.day.cap} today. ` +
      `${usage.tokens.input.toLocaleString()} in / ${usage.tokens.output.toLocaleString()} out tokens. ` +
      'Limits live in .env (FORGE_AI_*).';
  }

  /* ── Local execution path ────────────────────────────────── */
  async function runLocal(text) {
    const { reply, calls } = parseIntent(text, { store, app });
    for (const call of calls) {
      const result = await toolbox.execute(call.name, call.input);
      log.tool(call.name, summariseResult(call.name, call.input, result));
    }
    if (reply) log.sys(reply);
  }

  /* ── Submit ──────────────────────────────────────────────── */
  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    log.user(text);

    if (ready && agent) agent.send(text);
    else runLocal(text);
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') input.blur();
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());

  /* ── Boot: figure out which brain we have ─────────────────── */
  (async () => {
    const status = await probeStatus();
    ready = Boolean(status.ready);

    if (ready) {
      agent = createAgent({
        toolbox,
        onText: (t) => log.agent(t),
        onTool: (name, inputArgs, result) => log.tool(name, summariseResult(name, inputArgs, result)),
        onError: (m) => log.err(m),
        onBusy: setBusy,
        onUsage: showUsage,
      });
      limits = { model: status.model, ...status.limits };
      hud.setTag('console', status.model?.toUpperCase() ?? 'ONLINE');
      setBadge('online', status.model);
      showUsage(status.usage);
      log.sys(
        `${GREETING_ONLINE(status.model)} Budget: ${status.limits.hourlyCap}/hour, ` +
        `${status.limits.dailyCap}/day, ${status.limits.maxTurns} tool rounds per request, ` +
        `${status.limits.maxTokens} tokens per reply. Tune in .env.`
      );
    } else {
      hud.setTag('console', 'LOCAL');
      setBadge('offline', 'Local engine');
      log.sys(GREETING_LOCAL);
    }
  })();

  return {
    log,
    focus: () => input.focus(),
    isFocused: () => document.activeElement === input,
    get ready() { return ready; },
    resetConversation: () => agent?.reset(),
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
