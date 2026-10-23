/**
 * Fetch a RELOCATABLE Python interpreter (python-build-standalone).
 *
 * WHY THIS EXISTS
 * ---------------
 * A venv created by a system/hosted Python is NOT relocatable: its
 * bin/python is a symlink to an absolute build-machine path, pyvenv.cfg
 * records that same absolute path in `home`/`executable`, and bin/pip's
 * shebang points at the build directory. Ship that inside an Electron app
 * and the user's machine has no such path — the bundled interpreter simply
 * does not exist, so the backend never starts.
 *
 * python-build-standalone ships a CPython whose prefix is derived from the
 * binary's own location, so moving the whole tree keeps it working. We
 * therefore ship the standalone interpreter itself, with the dependencies
 * installed straight into its site-packages (no venv).
 *
 * Runs on the target CI runner (macos-14 / win-2022) so the binaries are
 * correct for the platform — no cross-compilation.
 *
 * Usage: node scripts/fetch-python.mjs <dest_dir>
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { download } from './lib/download.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const destDir = process.argv[2] || path.join(root, 'desktop', 'resources', 'python');
const isWin = process.platform === 'win32';

// Pinned: a moving target makes builds non-reproducible, and a pin that
// disappears from the release list breaks the build. Bump deliberately.
const PBS_RELEASE = process.env.DW_PBS_RELEASE || '20261021';
const PY_VERSION = process.env.DW_PY_VERSION || '3.12.15';

// python-build-standalone asset naming:
//   cpython-<ver>+<release>-<platform>-install_only.tar.gz
const platform = isWin
  ? 'x86_64-pc-windows-msvc'
  : (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin');
const asset = `cpython-${PY_VERSION}+${PBS_RELEASE}-${platform}-install_only.tar.gz`;
const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${asset}`;

/**
 * Where the interpreter lives inside the standalone tree.
 * The Windows build puts python.exe at the ROOT of the tree; the POSIX build
 * puts it under bin/. Getting this wrong makes the build fail with
 * "interpreter missing after extraction".
 */
function interpreterPath(dir) {
  if (isWin) return path.join(dir, 'python.exe');
  for (const n of ['python3.12', 'python3', 'python']) {
    const p = path.join(dir, 'bin', n);
    if (fs.existsSync(p)) return p;
  }
  return path.join(dir, 'bin', 'python3.12');
}

const exe = interpreterPath(destDir);
if (fs.existsSync(exe)) {
  console.log(`[fetch-python] already present -> ${destDir}`);
  process.exit(0);
}

// Stage OUTSIDE destDir so the swap below is a rename, never a delete.
// (Deleting a large tree is slow, and some sandboxes refuse to do it at all.)
const parent = path.dirname(destDir);
fs.mkdirSync(parent, { recursive: true });
const stage = path.join(parent, `.python-stage-${process.pid}`);
fs.mkdirSync(stage, { recursive: true });
const archive = path.join(stage, 'python.tar.gz');

try {
  console.log(`[fetch-python] downloading ${url}`);
  // Node's own fetch, not curl: Windows 10 1803 ships curl 7.55, which does
  // not know --retry-all-errors and fails with "option unknown". The URL also
  // contains a '+', which a shell-quoted command string would mangle.
  await download(url, archive, { label: 'python runtime' });

  console.log('[fetch-python] extracting…');
  // Both platform tarballs unpack to a top-level `python/` directory.
  // Windows 10 1803+ ships bsdtar as tar.exe, which reads .tar.gz.
  execFileSync('tar', ['-xzf', archive, '-C', stage], { stdio: 'inherit' });

  const extracted = path.join(stage, 'python');
  if (!fs.existsSync(extracted)) {
    throw new Error(`[fetch-python] expected ${extracted} after extraction`);
  }

  // Swap the staged tree into place. If a previous build left something at
  // destDir, move it aside first and remove it afterwards — best effort, so a
  // sandbox that blocks deletion cannot break the build.
  let previous = null;
  if (fs.existsSync(destDir)) {
    previous = path.join(parent, `.python-prev-${process.pid}`);
    fs.renameSync(destDir, previous);
  }
  fs.renameSync(extracted, destDir);

  if (previous) {
    try { fs.rmSync(previous, { recursive: true, force: true }); }
    catch { console.warn(`[fetch-python] could not remove the previous tree at ${previous} (ok)`); }
  }
} finally {
  try { fs.rmSync(stage, { recursive: true, force: true }); }
  catch { console.warn(`[fetch-python] could not remove the staging dir at ${stage} (ok)`); }
}

// Re-resolve the interpreter now that the tree is in place (the Windows
// layout differs from the POSIX one, and the check must reflect reality).
const finalExe = interpreterPath(destDir);
if (!fs.existsSync(finalExe)) {
  throw new Error(`[fetch-python] interpreter missing after extraction: ${finalExe}`);
}

// The standalone build ships its own pip. Make sure it is usable — some
// archives ship pip without the console scripts, and a stale pip cannot
// parse modern PEP 691 simple-index responses.
execFileSync(finalExe, ['-m', 'pip', 'install', '--no-cache-dir', '--upgrade', 'pip'], { stdio: 'inherit' });

console.log(`[fetch-python] DONE -> ${destDir}`);
console.log(`[fetch-python] DW_SHORTS_PYTHON=${finalExe}`);
