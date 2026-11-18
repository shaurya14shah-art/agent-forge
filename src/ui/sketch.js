/* ───────────────────────────────────────────────────────────────
   Sketch to reference model.

   Draw a shape; the agent looks at the drawing, names it, searches for
   the closest downloadable model and loads it.

   The identification step is genuinely a vision problem, so it goes to
   Claude as an image. Without an API key there is nothing here that can
   guess what a drawing is, so the panel falls back to asking you to
   type it — which is honest, and still gets you to the same search.
   ─────────────────────────────────────────────────────────────── */

const STROKE = '#7fd4ff';

export function createSketchPad({ hud, app, log, isAgentReady, identify }) {
  const panel = hud.panel('sketch', {
    anchor: 'right',
    offsetX: 318,
    title: 'Sketch',
    tag: '',
  });
  hud.show('sketch', false);

  const S = panel.body;
  S.insertAdjacentHTML(
    'beforeend',
    `<div class="note sketch-hint">Draw an object. It gets identified, matched against the model catalogue and loaded as reference geometry — never analysed, never massed.</div>`
  );

  const wrap = document.createElement('div');
  wrap.className = 'sketch-wrap';
  const canvas = document.createElement('canvas');
  canvas.width = 560;
  canvas.height = 420;
  wrap.appendChild(canvas);
  S.appendChild(wrap);

  const tools = document.createElement('div');
  tools.className = 'grid-2 sketch-tools';
  tools.innerHTML = `
    <button class="btn" data-act="undo">Undo</button>
    <button class="btn" data-act="clear">Clear</button>
    <button class="btn primary" data-act="find" style="grid-column:1/-1">Find a model</button>
  `;
  S.appendChild(tools);

  const nameWrap = document.createElement('div');
  nameWrap.className = 'field sketch-name';
  nameWrap.innerHTML = `<label for="sk-name">Or just name it</label><input id="sk-name" type="text" placeholder="office chair" spellcheck="false" />`;
  S.appendChild(nameWrap);
  const nameInput = nameWrap.querySelector('input');

  const statusEl = document.createElement('div');
  statusEl.className = 'note sketch-status';
  S.appendChild(statusEl);

  const resultsEl = document.createElement('div');
  resultsEl.className = 'sketch-results';
  S.appendChild(resultsEl);

  /* ── Drawing ──────────────────────────────────────────────── */
  const ctx = canvas.getContext('2d');
  let strokes = [];
  let current = null;

  function redraw() {
    ctx.fillStyle = '#0b1218';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = STROKE;
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      if (s.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(s[0].x, s[0].y);
      for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y);
      ctx.stroke();
    }
  }
  redraw();

  const pointFrom = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    current = [pointFrom(e)];
    strokes.push(current);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    current.push(pointFrom(e));
    redraw();
  });
  const endStroke = () => { current = null; };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  tools.querySelector('[data-act="undo"]').addEventListener('click', () => { strokes.pop(); redraw(); });
  tools.querySelector('[data-act="clear"]').addEventListener('click', () => {
    strokes = [];
    redraw();
    resultsEl.replaceChildren();
    statusEl.textContent = '';
  });
  tools.querySelector('[data-act="find"]').addEventListener('click', () => run());
  nameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') run();
  });

  /* ── Identify → search → load ─────────────────────────────── */

  function setStatus(text, kind = '') {
    statusEl.textContent = text;
    statusEl.className = `note sketch-status${kind ? ` ${kind}` : ''}`;
  }

  async function run() {
    const typed = nameInput.value.trim();
    let query = typed;

    if (!query) {
      if (!strokes.length) {
        setStatus('Draw something, or type what you want.', 'warn');
        return;
      }
      if (!isAgentReady()) {
        setStatus(
          'Recognising a drawing needs the design agent. Add ANTHROPIC_API_KEY to .env and restart — or type what you drew in the box below.',
          'warn'
        );
        return;
      }
      setStatus('Looking at the drawing…');
      try {
        const guess = await identify(canvas.toDataURL('image/png'));
        query = guess.query;
        setStatus(`Reads as: ${guess.description}. Searching for “${query}”…`);
      } catch (err) {
        setStatus(`Could not identify the sketch — ${err.message}`, 'bad');
        return;
      }
    } else {
      setStatus(`Searching for “${query}”…`);
    }

    try {
      const out = await app.searchModels(query, 8);
      if (!out.results.length) {
        setStatus(
          `Nothing in the catalogue matches “${query}”. It is a general-purpose props library, so plainer nouns do better.`,
          'warn'
        );
        resultsEl.replaceChildren();
        return;
      }
      setStatus(`${out.results.length} candidate${out.results.length === 1 ? '' : 's'} — pick one to load.`);
      renderResults(out.results);
    } catch (err) {
      setStatus(`Search failed — ${err.message}`, 'bad');
    }
  }

  function renderResults(results) {
    resultsEl.replaceChildren(
      ...results.map((r) => {
        const card = document.createElement('button');
        card.className = 'sketch-card';
        card.title = `${r.name} — ${r.license}, ${r.author}`;

        // Objaverse has no thumbnails, so the card falls back to a labelled
        // placeholder rather than a broken image.
        let preview;
        if (r.thumbnail) {
          preview = document.createElement('img');
          preview.src = `/api/models/proxy?url=${encodeURIComponent(r.thumbnail)}`;
          preview.alt = '';
          preview.loading = 'lazy';
          preview.addEventListener('error', () => preview.replaceWith(placeholder(r)));
        } else {
          preview = placeholder(r);
        }

        const label = document.createElement('span');
        label.textContent = r.name;

        const lic = document.createElement('em');
        lic.textContent = r.variants > 1 ? `${r.license} · ${r.variants} variants` : r.license;

        card.append(preview, label, lic);
        card.addEventListener('click', async () => {
          card.disabled = true;
          setStatus(`Loading ${r.name}…`);
          try {
            const resolved = await app.resolveModel(r.provider, r.id);
            await app.loadReference(resolved.proxied, {
              name: r.name, license: r.license, author: r.author,
              include: resolved.include, provider: r.provider, sourceId: r.id,
            });
            setStatus(`${r.name} placed. Reference geometry — not analysed, not massed.`, 'ok');
          } catch (err) {
            setStatus(`Could not load ${r.name} — ${err.message}`, 'bad');
          } finally {
            card.disabled = false;
          }
        });
        return card;
      })
    );
  }

  /** Stand-in preview for catalogues that ship no thumbnail. */
  function placeholder(r) {
    const el = document.createElement('div');
    el.className = 'sketch-thumb-none';
    el.textContent = (r.name || '?').slice(0, 2).toUpperCase();
    el.title = 'No preview image — this catalogue does not publish thumbnails';
    return el;
  }

  return {
    panel,
    open: () => hud.show('sketch', true),
    close: () => hud.show('sketch', false),
    toggle: () => {
      const showing = panel.el.style.display !== 'none';
      hud.show('sketch', !showing);
      return !showing;
    },
    isOpen: () => panel.el.style.display !== 'none',
    run,
  };
}
