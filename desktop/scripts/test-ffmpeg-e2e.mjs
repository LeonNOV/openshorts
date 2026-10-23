/**
 * End-to-end test for the ffmpeg download-and-extract step.
 *
 * It runs the REAL build-ffmpeg.mjs against a local HTTP server that serves
 * a zip with the same layout gyan.dev and the GitHub-hosted Windows builds
 * use (ffmpeg-<ver>/bin/{ffmpeg,ffprobe}). Nothing leaves the machine, and
 * the whole download → extract → install path is exercised.
 *
 * The bug this caught: the cleanup of the extraction directory ran AFTER the
 * download and deleted the archive, so a 191 MB download was followed by
 * "tar: Error opening archive: Failed to open .../ffmpeg.zip".
 *
 * Usage: node scripts/test-ffmpeg-e2e.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-ffmpeg-e2e-'));
let failed = 0;
const cleanup = [];

function report(name, err) {
  if (err) {
    console.log(`FAIL  ${name}\n      ${err.message}`);
    failed++;
  } else {
    console.log(`PASS  ${name}`);
  }
}

try {
  // --- build a zip with the layout the real archives have ----------------
  const stage = path.join(tmp, 'stage', 'ffmpeg-7.1-essentials_build', 'bin');
  fs.mkdirSync(stage, { recursive: true });
  // The scripts shell out to the binaries to check the version, so they have
  // to be runnable.
  fs.writeFileSync(path.join(stage, 'ffmpeg'), '#!/bin/sh\necho "ffmpeg version 7.1-fake"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stage, 'ffprobe'), '#!/bin/sh\necho "ffprobe version 7.1-fake"\n', { mode: 0o755 });
  const zipPath = path.join(tmp, 'ffmpeg.zip');
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: path.join(tmp, 'stage') });
  const zipBytes = fs.statSync(zipPath).size;

  // --- serve it -----------------------------------------------------------
  const archive = fs.readFileSync(zipPath);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': archive.length });
    res.end(archive);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  cleanup.push(() => server.close());

  // --- a fake project tree that the real script can run in ----------------
  // build-ffmpeg.mjs resolves its paths from its own location, so the script
  // has to sit in <tree>/desktop/scripts/ and write to <tree>/desktop/resources.
  const tree = path.join(tmp, 'tree');
  const scriptsDir = path.join(tree, 'desktop', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(path.join(tree, 'desktop', 'resources'), { recursive: true });
  for (const f of ['build-ffmpeg.mjs']) {
    fs.copyFileSync(path.join(desktopDir, 'scripts', f), path.join(scriptsDir, f));
  }
  fs.mkdirSync(path.join(scriptsDir, 'lib'), { recursive: true });
  for (const f of ['download.mjs', 'extract.mjs']) {
    fs.copyFileSync(path.join(desktopDir, 'scripts', 'lib', f), path.join(scriptsDir, 'lib', f));
  }

  // Point the script at the local server. The URL list is a const in the
  // source, so the test rewrites it — the rest of the script runs untouched.
  const scriptPath = path.join(scriptsDir, 'build-ffmpeg.mjs');
  let src = fs.readFileSync(scriptPath, 'utf8');
  src = src.replace(
    /const winUrls = \[[\s\S]*?\];/,
    `const winUrls = [\n  'http://127.0.0.1:${port}/ffmpeg.zip',\n];`,
  );
  src = src.replace(
    /const macUrls = \[[\s\S]*?\];/,
    `const macUrls = [\n  'http://127.0.0.1:${port}/ffmpeg.zip',\n];`,
  );
  fs.writeFileSync(scriptPath, src);

  // --- run it -------------------------------------------------------------
  // The server lives in this process, so the build has to run in a child
  // AND this process has to keep its event loop turning — a synchronous
  // spawn would block the server out of answering.
  const runScript = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: tree,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`the script exited with ${code}\n${out}\n${err}`));
    });
  });

  let out = '';
  try {
    out = await runScript();
  } catch (e) {
    report('the archive is downloaded, extracted and both binaries installed', e);
  }

  const binDir = path.join(tree, 'desktop', 'resources', 'bin');
  const ff = path.join(binDir, 'ffmpeg');
  const fp = path.join(binDir, 'ffprobe');

  if (fs.existsSync(ff) && fs.existsSync(fp)) {
    report('the archive is downloaded, extracted and both binaries installed', null);
  } else {
    report('the archive is downloaded, extracted and both binaries installed',
      new Error(`ffmpeg=${fs.existsSync(ff)} ffprobe=${fs.existsSync(fp)}\n${out}`));
  }

  // The download directory and the extraction directory must both be gone
  // afterwards — the bundle must not carry them.
  try {
    assert.ok(!fs.existsSync(path.join(binDir, '.download')), '.download was left behind');
    assert.ok(!fs.existsSync(path.join(binDir, '.extract')), '.extract was left behind');
    report('the temporary directories are cleaned up', null);
  } catch (e) {
    report('the temporary directories are cleaned up', e);
  }

  // And the installed binary has to actually run.
  try {
    const v = execFileSync(ff, ['-version'], { encoding: 'utf8' });
    assert.ok(v.includes('7.1-fake'), 'the installed ffmpeg is not the one from the archive');
    report('the installed ffmpeg runs', null);
  } catch (e) {
    report('the installed ffmpeg runs', e);
  }
} finally {
  for (const fn of cleanup.reverse()) { try { fn(); } catch { /* ignore */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${failed ? `${failed} failed` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
