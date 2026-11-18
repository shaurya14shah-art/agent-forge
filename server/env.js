import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal .env loader (no dependency). Existing process.env values always win,
 * so `ANTHROPIC_API_KEY=... npm run dev` overrides the file.
 */
export function loadDotEnv(cwd = process.cwd()) {
  const file = path.join(cwd, '.env');
  if (!fs.existsSync(file)) return;

  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));

    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing comment. Only when the # is preceded by whitespace,
      // so a value that legitimately contains one survives. Without this,
      // `CAP=30  # calls per hour` parses as the whole string and any
      // Number() of it is NaN — which silently falls back to a default and
      // makes a tuned .env look like it is being ignored.
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
