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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    failed++;
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
  check('the model prefetch points huggingface_hub at a reachable endpoint', () => {
    const src = fs.readFileSync(
      path.resolve(desktopDir, '..', 'scripts', 'prefetch_models.py'), 'utf8',
    );
    // huggingface.co is unreachable from mainland China and fails by
    // hanging, so a mirror has to be the default.
    assert.ok(
      src.includes('hf-mirror.com'),
      'prefetch_models.py does not fall back to a mirror',
    );
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
} finally {
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

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
