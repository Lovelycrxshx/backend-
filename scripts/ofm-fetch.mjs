#!/usr/bin/env node
// Fetch the dsh-our-free-model standalone service into ./vendor at install time.
//
// It is not vendored in this repository on purpose: upstream ships its own
// Google OAuth client credentials inside `src/subscriptions.js` and the channel
// pack, and GitHub's push protection refuses to accept a second copy of them
// here. Fetching the published tarball also means the service tracks upstream
// releases instead of a snapshot someone forgot to refresh.
//
// Env:
//   OFM_REF         git ref to fetch (default: latest release tag, else main)
//   OFM_SKIP_FETCH  set to 1 to skip entirely (offline installs)
//   OFM_STRICT      set to 1 to fail the install when the fetch fails
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'vendor', 'dsh-our-free-model');
const CLI = path.join(OUT, 'packages', 'standalone', 'cli.mjs');
const REPO = 'Ebony-Vinyl/dsh-our-free-model';

if (process.env.OFM_SKIP_FETCH === '1') {
  console.log('[ofm] OFM_SKIP_FETCH=1 — not fetching the standalone service');
  process.exit(0);
}

const log = (message) => console.log(`[ofm] ${message}`);

async function latestRef() {
  if (process.env.OFM_REF) return process.env.OFM_REF;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ofm-fetch' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const tag = (await res.json())?.tag_name;
      if (typeof tag === 'string' && tag !== '') return tag;
    }
  } catch { /* fall through to main */ }
  return 'main';
}

/** codeload wants `tags/<ref>` or `heads/<ref>` — a bare segment means a branch. */
function codeloadUrl(ref) {
  const kind = ref.startsWith('v') && /^v\d/.test(ref) ? 'tags' : 'heads';
  return `https://codeload.github.com/${REPO}/tar.gz/refs/${kind}/${ref}`;
}

/**
 * Node's fetch validates against Node's own CA bundle, which does not always
 * include a corporate/sandbox interception CA that `curl` already trusts. So a
 * failed fetch falls back to curl rather than failing the install.
 */
function curl(url, destination) {
  execFileSync('curl', ['-fsSL', '--max-time', '180', '-o', destination, url], { stdio: 'inherit' });
}

async function downloadArchive(url, archive) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: 'follow' });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  } catch (error) {
    log(`fetch failed (${error?.cause?.code ?? error?.message ?? error}) — retrying with curl`);
    curl(url, archive);
  }
}

async function download(ref) {
  const url = codeloadUrl(ref);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-fetch-'));
  const archive = path.join(temp, 'source.tar.gz');
  // Extract into a directory of its own, so the archive is not part of what we
  // copy into ./vendor.
  const extract = path.join(temp, 'extract');
  fs.mkdirSync(extract);
  await downloadArchive(url, archive);
  // Strip the single top-level directory the tarball wraps everything in, and
  // the parts this bridge never loads (desktop shells, docs, CI, and the 98 MB
  // magpie engine shards).
  execFileSync('tar', [
    '-xzf', archive, '-C', extract,
    '--strip-components=1',
    '--exclude=docs',
    '--exclude=.github',
    '--exclude=packages/desktop',
    '--exclude=vendor/magpie',
    '--exclude=src/engine-parts',
    '--exclude=.trae-html-share-packages',
  ], { stdio: 'inherit' });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.cpSync(extract, OUT, { recursive: true, filter: (source) => !source.endsWith(`${path.sep}.git`) });
  fs.rmSync(temp, { recursive: true, force: true });
  return ref;
}

try {
  if (fs.existsSync(CLI)) {
    log('standalone service already present — skipping fetch');
  } else {
    const got = await download(await latestRef());
    if (!fs.existsSync(CLI)) throw new Error('archive did not contain packages/standalone/cli.mjs');
    log(`fetched ${REPO}@${got}`);
  }
} catch (error) {
  const message = `could not fetch ${REPO} (${error?.message ?? error})`;
  // /ofm is one feature among several: an offline install must still get a
  // working keyed gateway, so this is a warning unless OFM_STRICT=1.
  if (process.env.OFM_STRICT === '1') {
    console.error(`[ofm] ${message}`);
    process.exit(1);
  }
  console.warn(`[ofm] ${message} — /ofm/v1 will be unavailable until \`npm run ofm:fetch\` succeeds`);
}
