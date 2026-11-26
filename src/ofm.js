// Bridge for the vendored `dsh-our-free-model` standalone service.
//
// The upstream project (github.com/Ebony-Vinyl/dsh-our-free-model) is a plugin
// for the dsh desktop app, but it also ships a self-contained local service in
// `packages/standalone`: a web console plus an OpenAI-compatible API with no
// npm dependencies. Its own README is explicit about the security posture it
// chose, and this file must not quietly undo it:
//
//   - the listener binds 127.0.0.1 only (`startStandalone` rejects anything
//     else, and `resolveLoopbackBind` re-checks the resolved address);
//   - `/api/management/*` and the console HTML are fenced by
//     `structuralRejection()` (loopback Host header + same-origin
//     Origin/Referer) AND a session cookie that only a one-time `#login=` link
//     can mint.
//
// So nothing here proxies the console or the management API to the public
// internet. What it does do:
//
//   * spawn the standalone service on loopback as a child process, with its
//     data directory inside this repo (`OFM_HOME`), so the console the user
//     opens on their own machine keeps its session the way upstream designed;
//   * report whether the child is up (`ofmStatus()`), for `/health` and the
//     root route listing;
//   * fetch the child's `forwardKey` from its settings file so `/setup` can
//     hand the phone a ready-to-paste key — the same file the child already
//     stores it in, read locally, never over HTTP.
//
// The public surface stays what upstream intended: `/v1/*` with a bearer key.
// `/setup` mints a copy-paste card; the console is reached over loopback from
// the user's own machine.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The free lane's primary transport runs under Bun (the repo's own error says so:
 * "OpenCode 免费车道推理需要本机 Bun"). npm's global bin directory is not always
 * on PATH for a service manager, so look there too before giving up — and pass
 * the absolute path through OUR_FREE_MODEL_BUN, which the child documents.
 */
function findBun() {
  if (process.env.OUR_FREE_MODEL_BUN) return process.env.OUR_FREE_MODEL_BUN;
  const candidates = [
    '/usr/local/bin/bun',
    '/usr/bin/bun',
    path.join(os.homedir(), '.bun', 'bin', 'bun'),
    path.join(path.dirname(process.execPath), 'bun'),
  ];
  return candidates.find((p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
  });
}

const CLI = path.join(HERE, '..', 'vendor', 'dsh-our-free-model', 'packages', 'standalone', 'cli.mjs');

export const OFM = {
  home: path.resolve(process.env.OFM_HOME ?? path.join(HERE, '..', '.ofm')),
  port: Number(process.env.OFM_PORT ?? 18900),
  enabled: (process.env.OFM_ENABLED ?? '1') !== '0',
};

let child = null;
let lastError = null;
let starting = null;
/** Rendered by the dashboard route; the file is compiled in dashboard/server.js. */
const DASHBOARD = path.join(HERE, '..', 'dashboard', 'index.html');

export function ofmConfigured() {
  return OFM.enabled && fs.existsSync(CLI);
}

/** `forwardKey` from the child's settings.json, or null when it is not written yet. */
export function ofmKey() {
  try {
    const raw = fs.readFileSync(path.join(OFM.home, 'settings.json'), 'utf8');
    const key = JSON.parse(raw)?.forwardKey;
    return typeof key === 'string' && key !== '' ? key : null;
  } catch {
    return null;
  }
}

export function ofmStatus() {
  return {
    enabled: OFM.enabled,
    running: child !== null && child.exitCode === null,
    port: OFM.port,
    dataDir: OFM.home,
    hasKey: ofmKey() !== null,
    bun: findBun() ?? null,
    error: lastError,
  };
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(700);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Start the standalone service once. Idempotent: a second call returns the same
 * promise. If something already listens on the port (a service the user started
 * by hand), it adopts it instead of fighting for the port.
 */
export function startOfm() {
  if (!ofmConfigured()) return Promise.resolve(ofmStatus());
  if (starting !== null) return starting;
  starting = (async () => {
    fs.mkdirSync(OFM.home, { recursive: true, mode: 0o700 });
    if (await portOpen(OFM.port)) return ofmStatus();
    child = spawn(process.execPath, [CLI, '--port', String(OFM.port), '--data-dir', OFM.home], {
      cwd: path.dirname(CLI),
      env: {
        ...process.env,
        OFM_HOME: OFM.home,
        NO_COLOR: '1',
        ...(process.env.OUR_FREE_MODEL_BUN ? {} : { OUR_FREE_MODEL_BUN: findBun() ?? '' }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The child prints its one-time console link on stdout; keep it in our log
    // so the user can find it — that link is the only way into the console.
    child.stdout.on('data', (chunk) => process.stdout.write(`[ofm] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[ofm] ${chunk}`));
    child.on('exit', (code, signal) => {
      if (code !== 0) lastError = `standalone service exited (code ${code ?? signal})`;
        child = null;
      });
    child.on('error', (error) => { lastError = String(error?.message ?? error); child = null; });
    // Never outlive the parent: an orphaned standalone service would keep the
    // port and the data-directory lock, and the next start would refuse to run.
    process.once('exit', () => { if (child !== null) child.kill('SIGTERM'); });

    for (let i = 0; i < 60; i++) {
      if (await portOpen(OFM.port)) return ofmStatus();
      await new Promise((r) => setTimeout(r, 250));
    }
    lastError = `standalone service did not answer on 127.0.0.1:${OFM.port}`;
    return ofmStatus();
  })();
  return starting;
}

export function stopOfm() {
  if (child === null) return;
  child.kill('SIGTERM');
  child = null;
}

const BASE = () => `http://127.0.0.1:${OFM.port}`;
export const ofmBase = BASE;

/** Short-TTL cache: the console renders on every page load and the roster is large. */
const cache = new Map();
async function getJson(pathname, headers = {}, ttlMs = 5000) {
  const hit = cache.get(pathname);
  if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value;
  const res = await fetch(`${BASE()}${pathname}`, { headers, signal: AbortSignal.timeout(15_000) });
  const value = { status: res.status, body: await res.json().catch(() => null) };
  cache.set(pathname, { at: Date.now(), value });
  return value;
}

/**
 * Model ids the child currently routes, from the *public* API (needs the key).
 * Returns [] when the child is not up or has not written its key yet.
 */
export async function ofmModels() {
  const key = ofmKey();
  if (key === null) return [];
  try {
    const { status, body } = await getJson('/v1/models', { Authorization: `Bearer ${key}` }, 30_000);
    if (status !== 200 || !Array.isArray(body?.data)) return [];
    return body.data
      .filter((m) => typeof m?.id === 'string')
      .map((m) => ({
        id: m.id,
        context: Number(m.context_window) || null,
        efforts: Array.isArray(m.x_ofm_efforts) ? m.x_ofm_efforts : null,
      }));
  } catch {
    return [];
  }
}

/**
 * The dashboard page, or null when it has not been built into this checkout.
 * It is served from the same origin as the API so a phone can use it on a
 * single public port — see the `/` route in app.js.
 */
export function dashboardHtml() {
  try { return fs.readFileSync(DASHBOARD); } catch { return null; }
}

/** Is the child's own `/health` answering? Cheap, and never needs a key. */
export async function ofmHealthy() {
  try {
    const res = await fetch(`${BASE()}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}
