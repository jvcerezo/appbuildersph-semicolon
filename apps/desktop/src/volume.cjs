// @ts-check
/**
 * Push to talk: lower the speakers while the user asks a question out loud, so the mic hears them
 * and not the hearing. The transcript is unaffected, because Windows records loopback audio before
 * the master volume (see volume.ps1). Windows only; elsewhere every call is a no-op.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

/** Ducked level, as a fraction of the user's own volume. */
const DUCK_TO = 0.2;
/** If the UI never says "release" (crash, lost focus), give the volume back anyway. */
const MAX_DUCK_MS = 40_000;

/** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
let helper = null;
/** @type {((line: string) => void)[]} */
const waiting = [];
let buffer = '';
/** The user's volume before ducking; null when not ducked. */
/** @type {number | null} */
let saved = null;
/** @type {NodeJS.Timeout | null} */
let safety = null;

function start() {
  if (helper || process.platform !== 'win32') return;
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'volume.ps1')],
    { windowsHide: true },
  );
  helper = child;
  // The first line is "ready", answered to the first request queued below.
  waiting.push(() => undefined);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (/** @type {string} */ data) => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      waiting.shift()?.(line);
    }
  });
  child.on('exit', () => {
    helper = null;
    for (const resolve of waiting.splice(0)) resolve('error helper exited');
  });
  child.stderr.on('data', (data) => console.warn('[linaw] volume helper:', String(data).trim()));
}

/** @param {string} command @returns {Promise<string>} */
function ask(command) {
  start();
  const child = helper;
  if (!child) return Promise.resolve('error unavailable');
  return new Promise((resolve) => {
    waiting.push(resolve);
    child.stdin.write(`${command}\n`);
  });
}

/** Lowers the speakers. Returns false if the volume can't be changed on this computer. */
async function duck() {
  if (saved !== null) return true;
  const current = Number(await ask('get'));
  if (!Number.isFinite(current)) return false;
  saved = current;
  await ask(`set ${(current * DUCK_TO).toFixed(3)}`);
  safety = setTimeout(() => void restore(), MAX_DUCK_MS);
  return true;
}

/** Gives back the exact volume from before `duck()`. */
async function restore() {
  if (safety) clearTimeout(safety);
  safety = null;
  if (saved === null) return;
  const level = saved;
  saved = null;
  await ask(`set ${level.toFixed(3)}`);
}

function isDucked() {
  return saved !== null;
}

/** Starts the helper ahead of the first press, so it's instant. */
function warmUp() {
  if (process.platform === 'win32') void ask('get');
}

function stop() {
  helper?.stdin.end();
}

module.exports = { duck, restore, isDucked, warmUp, stop };
