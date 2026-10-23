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
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..');

/**
 * Build a zip in memory.
 *
 * The test cannot shell out to `zip`: Windows has no such command, and the
 * point of these tests is that they run everywhere. The archive is written
 * by hand — the format is small, and the STORED method keeps it trivial.
 */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // method: stored
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0, 12);          // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra length

    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);     // central directory header
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra length
    cd.writeUInt16LE(0, 32);             // comment length
    cd.writeUInt16LE(0, 34);             // disk number start
    cd.writeUInt16LE(0, 36);             // internal attributes
    cd.writeUInt32LE(0, 38);             // external attributes
    cd.writeUInt32LE(offset, 42);        // offset of the local header
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);      // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);              // comment length

  return Buffer.concat([...chunks, cdBuf, end]);
}

/** CRC-32 for the (rare) case where zlib.crc32 is not available. */
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

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
  // The layout gyan.dev and the GitHub-hosted Windows builds use:
  //   ffmpeg-<ver>/bin/ffmpeg.exe
  //   ffmpeg-<ver>/bin/ffprobe.exe
  // The file names follow the platform, because that is what findExe looks
  // for.
  const isWin = process.platform === 'win32';
  const ffName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  const fpName = isWin ? 'ffprobe.exe' : 'ffprobe';
  const archive = makeZip({
    [`ffmpeg-7.1-essentials_build/bin/${ffName}`]: '#!/bin/sh\necho "ffmpeg version 7.1-fake"\n',
    [`ffmpeg-7.1-essentials_build/bin/${fpName}`]: '#!/bin/sh\necho "ffprobe version 7.1-fake"\n',
  });

  // --- serve it -----------------------------------------------------------
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
  const ff = path.join(binDir, ffName);
  const fp = path.join(binDir, fpName);

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

  // And the installed binaries have to be the ones from the archive.
  try {
    const content = fs.readFileSync(ff, 'utf8');
    assert.ok(content.includes('7.1-fake'), 'the installed ffmpeg is not the one from the archive');
    // On POSIX the script also runs the binary to print its version; that
    // needs a shell script, which Windows cannot execute. Checking the
    // content covers both platforms.
    const probe = fs.readFileSync(fp, 'utf8');
    assert.ok(probe.includes('7.1-fake'), 'the installed ffprobe is not the one from the archive');
    report('the installed binaries are the ones from the archive', null);
  } catch (e) {
    report('the installed binaries are the ones from the archive', e);
  }
} finally {
  for (const fn of cleanup.reverse()) { try { fn(); } catch { /* ignore */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${failed ? `${failed} failed` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
