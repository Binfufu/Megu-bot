import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal leveled logger. Every line goes to stderr so stdout stays free for
 * whatever a supervisor wants to pipe, and optionally to a file as well.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let threshold = LEVELS[process.env.QQBOT_LOG_LEVEL] ?? LEVELS.info;
let fileSink = null;

/**
 * Mirror log lines into a file.
 *
 * Autostart runs the bridge minimized or hidden, where stderr is not visible,
 * so the file is often the only way to see why a start failed. The file is
 * rotated once it passes `maxBytes`, keeping one previous generation, so an
 * always-on bot cannot quietly fill the disk.
 *
 * @returns {boolean} whether the sink was opened.
 */
export function openLogFile(file, { maxBytes = 5_000_000 } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
      fs.renameSync(file, `${file}.1`);
    }
    const sink = fs.createWriteStream(file, { flags: 'a' });
    // A dead sink must never take the bridge down with it.
    sink.on('error', () => {
      if (fileSink === sink) fileSink = null;
    });
    fileSink = sink;
    return true;
  } catch {
    return false;
  }
}

/**
 * Render an error together with its `cause` chain.
 *
 * Undici wraps every network failure as a bare `TypeError: fetch failed`, with
 * the real reason (DNS, TLS, refused connection, timeout) only on `cause`.
 * Logging `message` alone discards exactly the part needed to diagnose it.
 */
export function describeError(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    const code = current.code ? ` (${current.code})` : '';
    parts.push(`${current.name}: ${current.message}${code}`);
    current = current.cause;
  }
  return parts.join(' ← ');
}

function stringify(value) {
  if (value === undefined) return '';
  if (value instanceof Error) return describeError(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emit(level, message, extra) {
  if (LEVELS[level] > threshold) return;
  const suffix = stringify(extra);
  const line = `${new Date().toISOString()} [${level}] ${message}${suffix ? ` ${suffix}` : ''}\n`;
  process.stderr.write(line);
  fileSink?.write(line);
}

export const log = {
  error: (message, extra) => emit('error', message, extra),
  warn: (message, extra) => emit('warn', message, extra),
  info: (message, extra) => emit('info', message, extra),
  debug: (message, extra) => emit('debug', message, extra),
  setLevel(level) {
    if (level in LEVELS) threshold = LEVELS[level];
  },
  level: () => Object.keys(LEVELS).find((k) => LEVELS[k] === threshold),
};
