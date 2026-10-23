/**
 * Cross-platform file download.
 *
 * WHY NOT curl
 * ------------
 * The build scripts used to shell out to `curl`. Windows 10 1803 ships
 * curl 7.55, which does not know `--retry-all-errors` (added in 7.71) and
 * fails with "option --retry-all-errors: is unknown" — a version problem
 * that surfaces as an opaque build failure on the user's own machine while
 * the CI runner (curl 8.x) is perfectly happy.
 *
 * Node's own fetch has no such version constraints and behaves identically
 * on every platform, so the build no longer depends on the host's tooling.
 *
 * Usage:
 *   import { download } from './lib/download.mjs';
 *   await download('https://example.com/x.zip', '/tmp/x.zip', { label: 'x' });
 */
import fs from 'node:fs';

const DEFAULT_RETRIES = 5;

/**
 * Download `url` to `dest`, retrying a few times on transient failures.
 *
 * The file is written to `dest` directly; a failed attempt leaves a partial
 * file behind, so callers that care should download to a temp name and
 * rename afterwards (the callers in this repo already do).
 */
export async function download(url, dest, { label = 'download', retries = DEFAULT_RETRIES } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await downloadOnce(url, dest, label);
      return dest;
    } catch (e) {
      lastError = e;
      // Never leave a half-written file where a caller might pick it up.
      try { fs.rmSync(dest, { force: true }); } catch { /* nothing to remove */ }
      if (attempt === retries) break;
      const waitMs = attempt * 3000;
      console.warn(`[download] ${label}: attempt ${attempt}/${retries} failed (${e.message}); retrying in ${waitMs} ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error(`${label} failed after ${retries} attempts: ${lastError?.message || 'unknown error'}`);
}

async function downloadOnce(url, dest, label) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const total = Number(res.headers.get('content-length') || 0);
  const out = fs.createWriteStream(dest);
  let got = 0;
  let lastLog = 0;
  try {
    for await (const chunk of res.body) {
      out.write(chunk);
      got += chunk.length;
      const now = Date.now();
      if (now - lastLog > 1000) {
        lastLog = now;
        const pct = total ? ` (${((got / total) * 100).toFixed(0)}%)` : '';
        console.log(`  ${label}: ${(got / 1048576).toFixed(1)} MB${pct}`);
      }
    }
    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    out.destroy();
    throw e;
  }
  if (total && got !== total) {
    throw new Error(`short read: got ${got} of ${total} bytes`);
  }
}
