/**
 * Shared implementation for the one-shot desktop packaging scripts.
 *
 * Used by scripts/build-macos.mjs and scripts/build-windows.mjs. Each of those
 * is a thin entry point; the real work lives here so the two platforms cannot
 * drift apart.
 *
 * The build pipeline (plan §7):
 *   1. install the desktop build deps
 *   2. refresh the bundled Python source tree (app_src)
 *   3. build the relocatable Python runtime
 *   4. build ffmpeg/ffprobe
 *   5. pre-fetch the model weights (they are bundled in this branch)
 *   6. build the dashboard
 *   7. electron-builder
 *   8. verify the bundle
 *   9. report the artifact: path, size and SHA-256
 *
 * Usage:
 *   node scripts/build-app.mjs --target mac
 *   node scripts/build-app.mjs --target win
 *
 * Flags:
 *   --skip-deps      do not run npm install
 *   --skip-frontend  do not rebuild the dashboard
 *   --skip-models    do not pre-fetch the model weights
 *  *   --keep-going     continue after a failed step (for diagnosis only)
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..');

/** Run a command, showing it first so the log is reproducible by hand. */
function run(label, cmd, args, opts = {}) {
  console.log(`\n\x1b[1m▸ ${label}\x1b[0m`);
  console.log(`  ${cmd} ${args.join(' ')}`);
  const res = execFileSync(cmd, args, {
    cwd: opts.cwd || repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...(opts.env || {}) },
    // On Windows npm and the electron-builder shim are .cmd files, which
    // cannot be exec'd directly — they need a shell.
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd),
  });
  return res;
}

/** npm: prefer the local shim, fall back to whatever is on PATH. */
function npmCmd() {
  const local = localBin('npm');
  return fs.existsSync(local) ? local : 'npm';
}

/**
 * The path of a locally installed CLI (electron-builder and friends).
 * They live in desktop/node_modules/.bin, not on PATH. On Windows that
 * directory holds .cmd shims.
 */
function localBin(name) {
  const dir = path.join(desktopDir, 'node_modules', '.bin');
  if (process.platform === 'win32') {
    const cmd = path.join(dir, `${name}.cmd`);
    if (fs.existsSync(cmd)) return cmd;
  }
  return path.join(dir, name);
}

function dirSizeMb(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { total += fs.statSync(p).size; } catch { /* vanished */ }
      }
    }
  };
  walk(dir);
  return total / 1024 / 1024;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`
DW-shorts desktop build

  node scripts/build-macos.mjs    [flags]   build the macOS arm64 .dmg
  node scripts/build-windows.mjs  [flags]   build the Windows x64 .exe

Steps: install the desktop deps, refresh the bundled Python source tree,
build the relocatable Python runtime, build ffmpeg, pre-fetch the model
weights, build the dashboard, run electron-builder, verify the bundle, and
print the artifact's size and SHA-256.

Flags:
  --skip-deps      do not run npm install
  --skip-frontend  do not rebuild the dashboard
  --skip-models    do not pre-fetch the model weights
`);
    return;
  }
  const targetIdx = argv.indexOf('--target');
  const target = targetIdx >= 0 ? argv[targetIdx + 1] : 'mac';
  const skipDeps = argv.includes('--skip-deps');
  const skipFrontend = argv.includes('--skip-frontend');
  const skipModels = argv.includes('--skip-models');

  const isMac = target === 'mac';
  const isWin = target === 'win';
  if (!isMac && !isWin) {
    console.error(`unknown target: ${target} (use mac or win)`);
    process.exit(2);
  }

  // Both platforms must build on their own OS, and that is not a policy
  // choice: build-python.mjs fetches the interpreter for the HOST platform
  // and pip can only install wheels matching the host. Building the Windows
  // installer from a Mac would therefore bake a macOS Python into a .exe.
  const host = process.platform;
  if (isMac && host !== 'darwin') {
    console.error(`[build] a macOS dmg can only be built on macOS (this is ${host}).`);
    process.exit(2);
  }
  if (isWin && host !== 'win32') {
    console.error(`[build] the Windows installer can only be built on Windows (this is ${host}).`);
    console.error('[build] The bundled Python is fetched for the host platform and');
    console.error('[build] pip can only install wheels that match it, so a build');
    console.error('[build] from another OS would ship the wrong interpreter.');
    console.error('[build] Use the Windows CI runner, or a Windows machine.');
    process.exit(2);
  }

  const label = isMac ? 'macOS arm64' : 'Windows x64';
  console.log(`\x1b[1mDW-shorts desktop build — ${label}\x1b[0m`);
  console.log(`  repo:    ${repoRoot}`);
  console.log(`  desktop: ${desktopDir}`);

  // 1) build deps
  if (!skipDeps) {
    run('install desktop build deps', npmCmd(), ['install'], { cwd: desktopDir });
  }

  // 2) refresh the bundled Python source tree. This MUST run from the repo
  // root: scripts/prepare-source.mjs lives there, and it resolves the paths
  // it copies relative to the repo root.
  run('bundle the Python source tree (app_src)',
    process.execPath, [path.join(repoRoot, 'scripts', 'prepare-source.mjs')],
    { cwd: repoRoot });

  // 3) the relocatable Python runtime
  run('build the relocatable Python runtime',
    process.execPath, [path.join(desktopDir, 'scripts', 'build-python.mjs')],
    { cwd: desktopDir });

  // 4) ffmpeg
  run('build ffmpeg',
    process.execPath, [path.join(desktopDir, 'scripts', 'build-ffmpeg.mjs')],
    { cwd: desktopDir });

  // 5) model weights — bundled in this branch, so the installer is complete
  //    offline. They are large and slow to fetch, so an existing copy is kept.
  const modelsDir = path.join(desktopDir, 'resources', 'models');
  const whisperOk = fs.existsSync(path.join(modelsDir, 'faster-whisper-small', 'model.bin'));
  const yoloOk = fs.existsSync(path.join(modelsDir, 'yolov8n.pt'));
  if (skipModels) {
    console.log('\n▸ pre-fetch models — skipped (--skip-models)');
  } else if (whisperOk && yoloOk) {
    console.log('\n▸ pre-fetch models — already present, keeping the existing copy');
    console.log(`  ${modelsDir}`);
  } else {
    // Use the runtime we just built: it is the one that will ship, and it
    // already has faster-whisper and ultralytics in it.
    const bundled = isWin
      ? path.join(desktopDir, 'resources', 'python', 'python.exe')
      : path.join(desktopDir, 'resources', 'python', 'bin', 'python3.12');
    const py = fs.existsSync(bundled) ? bundled : (isWin ? 'python' : 'python3');
    run('pre-fetch the model weights', py, [
      path.join(repoRoot, 'scripts', 'prefetch_models.py'),
      modelsDir,
      process.env.DW_WHISPER_SIZE || 'small',
    ], { cwd: repoRoot });
  }

  // 6) the dashboard
  if (!skipFrontend) {
    run('build the dashboard',
      npmCmd(), ['run', 'build:frontend'], { cwd: desktopDir });
  }

  // 7) package
  const targetArgs = isMac ? ['--mac', '--arm64'] : ['--win', '--x64'];
  run(`package the ${label} installer`, localBin('electron-builder'),
    ['--config', 'electron/builder-config.js', ...targetArgs],
    { cwd: desktopDir });

  // 8) verify
  run('verify the bundle',
    process.execPath, [path.join(desktopDir, 'scripts', 'verify-bundle.mjs')],
    { cwd: desktopDir });

  // 9) report
  const distDir = path.join(desktopDir, 'dist');
  const pattern = isMac ? /\.dmg$/ : /\.exe$/;
  const artifacts = fs.existsSync(distDir)
    ? fs.readdirSync(distDir).filter((f) => pattern.test(f))
    : [];
  if (!artifacts.length) {
    console.error('\n[build] no artifact found in dist/ — something went wrong.');
    process.exit(1);
  }
  console.log('\n\x1b[1m=== build result ===\x1b[0m');
  console.log(`  dist/ total: ${dirSizeMb(distDir).toFixed(0)} MB`);
  for (const name of artifacts) {
    const full = path.join(distDir, name);
    const mb = fs.statSync(full).size / 1024 / 1024;
    const digest = await sha256(full);
    console.log(`  ${name}`);
    console.log(`    size   : ${mb.toFixed(0)} MB`);
    console.log(`    sha256 : ${digest}`);
  }
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(`\n[build] FAILED: ${e.message}`);
  process.exit(1);
});
