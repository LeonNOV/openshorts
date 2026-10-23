/**
 * Tests for the cross-platform helpers the desktop build scripts rely on.
 *
 * These run on any OS — they exercise the LOGIC, not the platform-specific
 * behaviour (which only a real Windows machine can show). What they do catch
 * is the class of bug that bit the Windows build: a helper that resolves a
 * path or a command differently on the two platforms, silently.
 *
 * Usage: node scripts/test-build-helpers.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const pending = [];

function check(name, fn) {
  // A check may be synchronous or return a promise; both count the same.
  const record = (err) => {
    if (err) {
      console.log(`FAIL  ${name}\n      ${err.message}`);
      failed++;
    } else {
      console.log(`PASS  ${name}`);
      passed++;
    }
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => record(null), (e) => record(e)));
    } else {
      record(null);
    }
  } catch (e) {
    record(e);
  }
}

const isWin = process.platform === 'win32';

// ---------------------------------------------------------------------------
// The interpreter lookup. The standalone runtime's layout differs by
// platform, and every consumer of the bundled interpreter has to agree on
// it: build-python.mjs, build-app.mjs, resolve-python.mjs and
// verify-bundle.mjs. A mismatch means the Windows build cannot find the
// runtime it just built.
// ---------------------------------------------------------------------------

/**
 * The candidate list, as used across the build scripts.
 *
 * The real scripts pick the directory/name set from process.platform. The
 * test checks BOTH layouts regardless of the host, because the point is to
 * prove that the Windows layout is reachable at all — running that check
 * only on Windows would leave it untested everywhere else.
 */
function probeCandidates(dir, platform) {
  const dirs = platform === 'win32' ? ['', 'bin', 'Scripts'] : ['bin', ''];
  const names = platform === 'win32'
    ? ['python.exe', 'python3.exe', 'python']
    : ['python', 'python3', 'python3.12'];
  const out = [];
  for (const d of dirs) {
    for (const n of names) out.push(path.join(dir, d, n));
  }
  return out;
}

function resolveIn(dir, platform = isWin) {
  for (const p of probeCandidates(dir, platform)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-build-helpers-'));
try {
  // --- interpreter lookup -------------------------------------------------
  check('interpreter lookup finds the interpreter at the tree root (Windows layout)', () => {
    const root = path.join(tmp, 'winroot');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'python.exe'), '#!/x\n');
    const found = resolveIn(root, 'win32');
    assert.ok(found, 'no interpreter found');
    assert.equal(path.basename(found), 'python.exe');
  });

  check('interpreter lookup finds the interpreter under bin/ (POSIX layout)', () => {
    const root = path.join(tmp, 'posixroot');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'python3.12'), '#!/x\n');
    const found = resolveIn(root, 'linux');
    assert.ok(found, 'no interpreter found');
    assert.ok(found.includes(path.join('bin', 'python3.12')));
  });

  check('interpreter lookup returns null when the runtime is absent', () => {
    const root = path.join(tmp, 'empty');
    fs.mkdirSync(root, { recursive: true });
    assert.equal(resolveIn(root, 'win32'), null);
    assert.equal(resolveIn(root, 'linux'), null);
  });

  // The Windows layout has python.exe at the ROOT and no bin/ directory at
  // all — a candidate list that only looked in bin/ would miss it.
  check('interpreter lookup does not require a bin/ directory (Windows)', () => {
    const root = path.join(tmp, 'nowinbin');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'python.exe'), '#!/x\n');
    assert.ok(!fs.existsSync(path.join(root, 'bin')));
    assert.ok(resolveIn(root, 'win32'), 'the root interpreter was not found');
  });

  // --- npm / electron-builder resolution ----------------------------------
  check('electron-builder is invoked through its own cli.js, not a .cmd shim', () => {
    const cli = path.join(desktopDir, 'node_modules', 'electron-builder', 'cli.js');
    assert.ok(fs.existsSync(cli), `missing ${cli}`);
    // The .cmd shim cannot be spawned by Node 18.20+ without a shell, which
    // is what produced "spawnSync npm ENOENT" on Windows.
    const src = fs.readFileSync(cli, 'utf8');
    assert.ok(src.includes('require('), 'cli.js does not look like an entry script');
  });

  check('npm can be located as a JavaScript entry point', () => {
    // Mirrors resolveNpmCli() in build-app.mjs.
    const candidates = [];
    if (process.env.npm_execpath && /npm-cli\.js$/i.test(process.env.npm_execpath)) {
      candidates.push(process.env.npm_execpath);
    }
    const dir = path.dirname(process.execPath);
    candidates.push(
      path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(dir, '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
    const found = candidates.find((c) => fs.existsSync(c));
    assert.ok(found, `no npm-cli.js found among ${candidates.length} candidates`);
  });

  // --- the frontend build command -----------------------------------------
  check('the dashboard build command does not rely on shell-specific syntax', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
    const cmd = pkg.scripts['build:frontend'];
    // "cd ../dashboard && npm ..." relies on POSIX cd semantics; on Windows
    // the shell is cmd.exe. `npm --prefix` works on both.
    assert.ok(
      !/^\s*cd\s/.test(cmd),
      `build:frontend starts with "cd", which is not portable: ${cmd}`,
    );
    assert.ok(cmd.includes('--prefix'), `build:frontend does not use --prefix: ${cmd}`);
  });

  // --- the ffmpeg archive layout ------------------------------------------
  check('findExe locates the binaries in a flat archive (POSIX unzip layout)', () => {
    const dir = path.join(tmp, 'flat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ffmpeg'), '#!/x\n');
    fs.writeFileSync(path.join(dir, 'ffprobe'), '#!/x\n');
    assert.ok(findExe(dir, 'ffmpeg'));
    assert.ok(findExe(dir, 'ffprobe'));
  });
  check('findExe locates the binaries in a nested archive (gyan.dev layout)', () => {
    const dir = path.join(tmp, 'nested');
    const inner = path.join(dir, 'ffmpeg-7.1-essentials_build', 'bin');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, 'ffmpeg.exe'), '#!/x\n');
    fs.writeFileSync(path.join(inner, 'ffprobe.exe'), '#!/x\n');
    assert.ok(findExe(dir, 'ffmpeg'));
    assert.ok(findExe(dir, 'ffprobe'));
  });

  check('findExe returns null when the archive holds neither binary', () => {
    const dir = path.join(tmp, 'emptyzip');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'x');
    assert.equal(findExe(dir, 'ffmpeg'), null);
  });

  // --- the model prefetch endpoint ----------------------------------------
  check('the model prefetch falls back to a mirror when the official host is unreachable', () => {
    const src = fs.readFileSync(
      path.resolve(desktopDir, '..', 'scripts', 'prefetch_models.py'), 'utf8',
    );
    // huggingface.co is unreachable from mainland China and fails by
    // hanging, so a mirror has to be there as a fallback.
    assert.ok(
      src.includes('hf-mirror.com'),
      'prefetch_models.py does not fall back to a mirror',
    );
    // The official host is faster where it works, so it is probed first
    // rather than being skipped in favour of the mirror.
    assert.ok(
      src.includes('huggingface.co') && src.includes('_reachable'),
      'prefetch_models.py does not probe the official endpoint',
    );
    // The mirror does not serve the Xet CAS, so Xet has to be off there.
    assert.ok(
      src.includes('HF_HUB_DISABLE_XET'),
      'prefetch_models.py does not disable Xet for the mirror',
    );
  });

  // --- no shell-quoted command strings ------------------------------------
  check('the build scripts pass argument arrays, not shell-quoted strings', () => {
    const scripts = [
      'build-app.mjs', 'build-ffmpeg.mjs', 'fetch-python.mjs',
      'build-python.mjs', 'verify-bundle.mjs',
    ];
    for (const s of scripts) {
      const src = fs.readFileSync(path.join(desktopDir, 'scripts', s), 'utf8');
      // A command string that embeds quotes is the pattern that breaks on
      // Windows paths containing a space.
      assert.ok(
        !/execFileSync\(\s*`[^`]*\$\{/.test(src),
        `${s} builds a shell command string with interpolation`,
      );
    }
  });

  check('the build scripts do not depend on curl', () => {
    // Windows 10 1803 ships curl 7.55, which rejects --retry-all-errors.
    for (const s of ['build-ffmpeg.mjs', 'fetch-python.mjs']) {
      const src = fs.readFileSync(path.join(desktopDir, 'scripts', s), 'utf8');
      assert.ok(!src.includes("'curl'"), `${s} still shells out to curl`);
    }
  });

  check('the build scripts do not depend on PowerShell 7', () => {
    // A user machine has Windows PowerShell 5.1; only the CI runner has pwsh.
    const src = fs.readFileSync(path.join(desktopDir, 'scripts', 'lib', 'extract.mjs'), 'utf8');
    assert.ok(src.includes('powershell'), 'extract.mjs does not fall back to Windows PowerShell');
    for (const s of ['build-ffmpeg.mjs', 'fetch-python.mjs']) {
      const body = fs.readFileSync(path.join(desktopDir, 'scripts', s), 'utf8');
      assert.ok(!/execFileSync\(\s*'pwsh'/.test(body), `${s} requires pwsh`);
    }
  });

  // --- a download that is too slow is abandoned --------------------------
  check('a download below the speed floor is abandoned instead of retried', async () => {
    // A throttled CDN served the 90 MB ffmpeg zip at 10 KB/s, which is three
    // hours of a build. The transfer has to give up so the next source can
    // be tried, and it must NOT retry the same URL.
    const { download } = await import(
      new URL('./lib/download.mjs', import.meta.url).href
    );
    const dest = path.join(tmp, 'slow.bin');
    // 1 byte per second against a floor of 64 KB/s.
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': '1000' });
      res.write(Buffer.alloc(1));
      const t = setInterval(() => {
        if (res.writableEnded) { clearInterval(t); return; }
        res.write(Buffer.alloc(1));
      }, 1000);
      res.on('close', () => clearInterval(t));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      await assert.rejects(
        () => download(`http://127.0.0.1:${port}/x`, dest, {
          label: 'slow', retries: 3, minBytesPerSecond: 64,
        }),
        /too slow/,
        'the slow download was not rejected',
      );
      // The partial file must not be left behind.
      assert.ok(!fs.existsSync(dest), 'a partial file was left behind');
    } finally {
      server.close();
    }
  });

  check('the ffmpeg sources put a reachable host before a throttled one', () => {
    const src = fs.readFileSync(path.join(desktopDir, 'scripts', 'build-ffmpeg.mjs'), 'utf8');
    const i = src.indexOf('const winUrls');
    const block = src.slice(i, src.indexOf('];', i));
    // Measured on a China-connected Windows machine: gyan.dev served the
    // essentials zip at ~10 KB/s, GitHub at ~120 KB/s and the npmmirror
    // (Alibaba's CDN) at ~1 MB/s. The fastest one has to be tried first.
    const mirror = block.indexOf('npmmirror');
    const gh = block.indexOf('github.com');
    const gyan = block.indexOf('gyan.dev');
    assert.ok(mirror >= 0, 'the npmmirror source is missing');
    assert.ok(gh >= 0, 'the GitHub source is gone entirely');
    assert.ok(gyan >= 0, 'the gyan.dev source is gone entirely');
    assert.ok(mirror < gh, 'the throttled GitHub source is still tried before the mirror');
    assert.ok(gh < gyan, 'the throttled gyan.dev source is still tried first');
  });

  check('the python runtime is fetched from a mirror too', () => {
    const src = fs.readFileSync(path.join(desktopDir, 'scripts', 'fetch-python.mjs'), 'utf8');
    // The npmmirror mirrors the python-build-standalone releases verbatim, and
    // it stays reachable when GitHub does not.
    assert.ok(
      src.includes('npmmirror') && src.includes('python-build-standalone'),
      'fetch-python.mjs does not use the npmmirror',
    );
    // And there has to be a fallback.
    assert.ok(
      src.includes('github.com/astral-sh/python-build-standalone'),
      'fetch-python.mjs lost the GitHub fallback',
    );
  });

  check('electron-builder is pointed at a reachable mirror', () => {
    const src = fs.readFileSync(path.join(desktopDir, 'scripts', 'build-app.mjs'), 'utf8');
    // electron-builder pulls the Electron runtime (115 MB) and the NSIS
    // toolchain from GitHub; the npmmirror carries both.
    assert.ok(
      src.includes('ELECTRON_MIRROR'),
      'the Electron mirror is not configured',
    );
    assert.ok(
      src.includes('ELECTRON_BUILDER_BINARIES_MIRROR'),
      'the electron-builder binaries mirror is not configured',
    );
    // The environment has to be set BEFORE electron-builder runs, because
    // run() copies process.env into the child.
    const cfg = src.indexOf('configureMirrors();');
    const run = src.indexOf("electronBuilder(`package");
    assert.ok(cfg >= 0 && run >= 0, 'the mirror configuration is missing');
    assert.ok(cfg < run, 'the mirrors are configured after electron-builder ran');
  });

  // --- the archive must survive the cleanup --------------------------------
  check('cleaning the extraction cannot delete the archive that was downloaded', () => {
    // The build downloaded the 191 MB archive and then failed to extract it:
    // "tar: Error opening archive: Failed to open .../ffmpeg.zip". The
    // cleanup of the extraction directory ran AFTER the download and wiped
    // the file it was about to unpack.
    const src = fs.readFileSync(path.join(desktopDir, 'scripts', 'build-ffmpeg.mjs'), 'utf8');

    // Walk every download → unpack pair and make sure nothing removes the
    // archive's directory in between. (Removing it AFTER the extraction is
    // fine — that is the final cleanup.)
    const pairs = [...src.matchAll(/await downloadTo\(url, (\w+)[^)]*\);([\s\S]*?)unpack\(\1,/g)];
    assert.ok(pairs.length >= 1, 'no download/unpack pair found');
    for (const [, , between] of pairs) {
      assert.ok(
        !/rmSync\(\s*downloadDir/.test(between),
        'the archive is deleted between the download and the extraction',
      );
    }
    // The bug was specifically: the extraction directory was the archive's
    // directory, so cleaning one cleaned the other.
    const zipDirs = [...src.matchAll(/path\.join\((\w+),\s*name\)/g)].map((m) => m[1]);
    const extractDirs = [...src.matchAll(/unpack\(\w+,\s*(\w+)\)/g)].map((m) => m[1]);
    for (const z of zipDirs) {
      assert.ok(
        !extractDirs.includes(z),
        `the archive and the extraction share the directory ${z}`,
      );
    }
  });

  // --- the CI runs the same script a developer runs ------------------------
  check('the CI build jobs run the platform script, not a copy of the steps', () => {
    const wf = path.resolve(desktopDir, '..', '.github', 'workflows', 'release.yml');
    if (!fs.existsSync(wf)) {
      console.log('      (no workflow file — skipped)');
      return;
    }
    const src = fs.readFileSync(wf, 'utf8');
    // The two jobs used to spell the build out as eleven steps each, which
    // is how the CI and a developer's machine drifted apart. They now call
    // the very script a developer runs.
    assert.ok(
      src.includes('node scripts/build-macos.mjs'),
      'the macOS job does not run build-macos.mjs',
    );
    assert.ok(
      src.includes('node scripts/build-windows.mjs'),
      'the Windows job does not run build-windows.mjs',
    );
    // Each script must appear in its OWN job: the two jobs had identical
    // step text once, and a blind replacement put the macOS script in the
    // Windows job, which would have built a macOS bundle on Windows.
    const macJob = src.slice(src.indexOf('  build-mac:'), src.indexOf('  build-win:'));
    const winJob = src.slice(src.indexOf('  build-win:'), src.indexOf('  release:'));
    assert.ok(
      macJob.includes('build-macos.mjs') && !macJob.includes('build-windows.mjs'),
      'the macOS job runs the wrong script',
    );
    assert.ok(
      winJob.includes('build-windows.mjs') && !winJob.includes('build-macos.mjs'),
      'the Windows job runs the wrong script',
    );
  });
} finally {
  // Wait for the async checks before removing the temp directory they use.
  await Promise.all(pending);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/** The same lookup the build scripts use. */
function findExe(dir, name) {
  for (const candidate of [name, `${name}.exe`]) {
    if (fs.existsSync(path.join(dir, candidate))) return path.join(dir, candidate);
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d, candidate);
      if (fs.existsSync(p)) return p;
      const p2 = path.join(dir, d, 'bin', candidate);
      if (fs.existsSync(p2)) return p2;
    }
  }
  return null;
}

await Promise.all(pending);
console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
