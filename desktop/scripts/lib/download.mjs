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
 * WHY NOT fetch
 * -------------
 * Node's built-in fetch (undici) has a 10 second CONNECT timeout that the
 * standard API cannot change. On a network where the TLS handshake to
 * github.com sometimes takes longer than that, the download fails with
 * "Connect Timeout Error", and the option that would fix it needs a
 * dependency. `node:https` has no such limit and needs no dependency, so it
 * does the work here.
 *
 * Usage:
 *   import { download } from './lib/download.mjs';
 *   await download('https://example.com/x.zip', '/tmp/x.zip', { label: 'x' });
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const DEFAULT_RETRIES = 5;
const MAX_REDIRECTS = 8;

/**
 * Download `url` to `dest`, retrying a few times on transient failures.
 *
 * The file is written to `dest` directly; a failed attempt leaves a partial
 * file behind, so callers that care should download to a temp name and
 * rename afterwards (the callers in this repo already do).
 *
 * `minBytesPerSecond` aborts a transfer that is technically working but far
 * too slow to be worth waiting for — a throttled CDN can serve a 90 MB file
 * at 10 KB/s, which is three hours of a build that nobody is waiting for.
 * The caller can then move on to the next source.
 */
export async function download(url, dest, {
  label = 'download',
  retries = DEFAULT_RETRIES,
  minBytesPerSecond = 0,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await downloadOnce(url, dest, label, minBytesPerSecond);
      return dest;
    } catch (e) {
      lastError = e;
      // Never leave a half-written file where a caller might pick it up.
      try { fs.rmSync(dest, { force: true }); } catch { /* nothing to remove */ }
      // Being too slow is not a transient failure: retrying the same URL
      // would just be slow again. Let the caller move on to another source.
      if (e.tooSlow || attempt === retries) break;
      const waitMs = attempt * 3000;
      console.warn(`[download] ${label}: attempt ${attempt}/${retries} failed (${e.message}); retrying in ${waitMs} ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error(`${label} failed after ${retries} attempt(s): ${lastError?.message || 'unknown error'}`);
}

function downloadOnce(url, dest, label, minBytesPerSecond) {
  return new Promise((resolve, reject) => {
    let redirects = 0;

    const attempt = (target) => {
      const mod = target.startsWith('http:') ? http : https;
      const req = mod.get(target, {
        headers: { 'User-Agent': 'DW-shorts-build' },
        // A generous connect timeout: a slow route to the CDN is common, and
        // giving up on it would fail a download that would have worked.
        timeout: 60000,
      }, (res) => {
        const status = res.statusCode || 0;

        // Follow redirects. A GitHub release URL answers 302 and points at
        // objects.githubusercontent.com, sometimes with a second hop.
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (++redirects > MAX_REDIRECTS) {
            reject(new Error(`too many redirects (${redirects})`));
            return;
          }
          attempt(new URL(res.headers.location, target).toString());
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status} ${res.statusMessage} for ${target}`));
          return;
        }

        const total = Number(res.headers['content-length'] || 0);
        const out = fs.createWriteStream(dest);
        const started = Date.now();
        let got = 0;
        let lastLog = 0;
        let settled = false;

        const fail = (err) => {
          if (settled) return;
          settled = true;
          out.destroy();
          reject(err);
        };

        res.on('data', (chunk) => {
          got += chunk.length;
          const now = Date.now();
          if (now - lastLog > 1000) {
            lastLog = now;
            const elapsed = (now - started) / 1000;
            const rate = elapsed > 0 ? got / 1024 / elapsed : 0;
            const pct = total ? ` (${((got / total) * 100).toFixed(0)}%)` : '';
            const speed = rate >= 1024
              ? `${(rate / 1024).toFixed(1)} MB/s`
              : `${rate.toFixed(0)} KB/s`;
            console.log(`  ${label}: ${(got / 1048576).toFixed(1)} MB${pct}  ${speed}`);
            // Give up on a transfer that is working but hopelessly slow, so
            // the caller can try the next source instead of waiting for hours.
            //
            // Only judge after a couple of seconds: the first chunk can
            // arrive in the same millisecond as the request, and a rate
            // measured over zero time reads as zero — which would reject the
            // fastest downloads of all.
            if (minBytesPerSecond && elapsed >= 2 && rate < minBytesPerSecond) {
              const err = new Error(
                `too slow: ${rate.toFixed(0)} KB/s is below the ${minBytesPerSecond} KB/s floor`,
              );
              err.tooSlow = true;
              fail(err);
            }
          }
        });

        res.on('error', fail);
        out.on('error', fail);
        out.on('finish', () => {
          if (settled) return;
          settled = true;
          if (total && got !== total) {
            reject(new Error(`short read: got ${got} of ${total} bytes`));
            return;
          }
          resolve(dest);
        });
        res.pipe(out);
      });

      req.on('timeout', () => {
        req.destroy(new Error(`connection to ${target} timed out`));
      });
      req.on('error', reject);
    };

    attempt(url);
  });
}
