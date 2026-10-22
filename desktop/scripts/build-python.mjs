/**
 * Build the bundled Python runtime for DW-shorts (plan §7.2).
 *
 * WHY NOT A VENV
 * --------------
 * A venv built by a system/hosted Python is NOT relocatable: bin/python is a
 * symlink to an absolute build-machine path, pyvenv.cfg records that path in
 * `home`/`executable`, and bin/pip's shebang points at the build directory.
 * Ship that inside an Electron app and the user's machine has no such path —
 * the bundled interpreter simply does not exist, so the backend never starts.
 *
 * Instead we use a RELOCATABLE interpreter (python-build-standalone, fetched
 * by scripts/fetch-python.mjs) and install the dependencies straight into its
 * site-packages. Its prefix is derived from the binary's own location, so the
 * whole tree can be moved anywhere and still works. No venv, no symlinks, no
 * absolute paths baked into the shipped bundle.
 *
 * Runs on the target CI runner (macos-14 / win-2022) so the platform binaries
 * are correct — no cross-compilation.
 *
 * Usage: node scripts/build-python.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const pyDir = path.join(root, 'desktop', 'resources', 'python');
const requirements = path.join(root, 'requirements.txt');
// On GitHub-hosted runners (US) the official PyPI is fastest; the Tsinghua
// mirror is only faster on a China-local network. Override with DW_PIP_INDEX.
const MIRROR = process.env.DW_PIP_INDEX || 'https://pypi.org/simple';

// 1) Fetch the relocatable interpreter (fresh every build).
execFileSync(process.execPath, [path.join(__dirname, 'fetch-python.mjs'), pyDir], { stdio: 'inherit' });

/**
 * Resolve the interpreter without assuming a version-stamped name.
 *
 * The standalone runtime's layout differs by platform:
 *   - POSIX   : <dir>/bin/python3.12 (+ python, python3 symlinks)
 *   - Windows : <dir>/python.exe  (at the ROOT, not under bin/ or Scripts/)
 * Probe rather than guess.
 */
function resolvePyBin(dir) {
  const isWin = process.platform === 'win32';
  const dirs = isWin ? ['', 'bin', 'Scripts'] : ['bin', ''];
  const names = isWin
    ? ['python.exe', 'python3.exe', 'python']
    : ['python', 'python3', 'python3.12'];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(dir, d, n);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error(`[build-python] no interpreter found under ${dir}`);
}
const pyBin = resolvePyBin(pyDir);
console.log(`[build-python] interpreter: ${pyBin}`);

// 2) Install the dependencies straight into the interpreter's site-packages.
// Use execFileSync with an argument array: a shell-quoted command string
// breaks on Windows once the path contains a space, and there is no shell
// feature we need here.
// --no-cache-dir: the wheels are ~1.3 GB and the CI runners have limited
// free disk; the cache would double the footprint for no benefit here.
const tInstall = Date.now();
console.log('[build-python] installing the dependencies (torch et al. — a few minutes)…');
execFileSync(pyBin, ['-m', 'pip', 'install', '--no-cache-dir', '--index-url', MIRROR, '-r', requirements], { stdio: 'inherit' });
console.log(`[build-python] dependencies installed in ${((Date.now() - tInstall) / 1000).toFixed(1)}s`);

/**
 * Trim deps the desktop build never uses (plan §1.2 / risk §10).
 *
 * Every entry was checked against the real dependency graph — a package may
 * only be trimmed when NOTHING in the runtime path needs it:
 *
 *   sympy  — HARD DEP of torch 2.11 (`sympy>=1.13.3`). torch.fx.experimental
 *            .symbolic_shapes imports it at import time, reached via
 *            torchvision.ops.roi_align → torch._dynamo. Trimming it breaks
 *            `import torch` outright. NEVER TRIM.
 *   onnxruntime — faster-whisper's Silero VAD imports it lazily inside
 *            vad.py's `get_speech_timestamps` (faster_whisper/vad.py:298) and
 *            the pipeline defaults to `"vad_filter": True` (subtitles.py:32),
 *            so it is required at RUNTIME. NEVER TRIM.
 *   polars — only ~5 MB, and ultralytics imports it inside to_df()/to_csv()/
 *            plot_results() WITHOUT a try/except guard. Not worth the risk.
 *   jax / jaxlib — 248 MB, the single biggest win. Pulled in by mediapipe
 *            0.10.14, but only ever used by mediapipe/tasks/python/genai/
 *            converter/ (model conversion tooling). The desktop app uses the
 *            legacy `mp.solutions` face detector, which never touches jax.
 *            Safe to trim.
 */
const trim = ['jaxlib', 'jax'];
try {
  execFileSync(pyBin, ['-m', 'pip', 'uninstall', '-y', ...trim], { stdio: 'inherit' });
} catch { console.warn('[build-python] some trim packages were not installed (ok)'); }

// A trimmed package leaves its dependents' metadata dangling. Report it
// loudly so a future dependency change can't silently break the shipped app —
// but do not fail the build, because jax's absence is intentional and known.
try {
  execFileSync(pyBin, ['-m', 'pip', 'check'], { stdio: 'inherit' });
  console.log('[build-python] pip check: clean');
} catch {
  console.warn('[build-python] pip check reported (expected for trimmed jax)');
}

// 3) Verify the real import path still works. The repo source lives at
// `root`, which is not on the bundled python's sys.path — insert it explicitly.
// Use execFileSync (arg array) so the embedded quotes never get reinterpreted
// by a shell.
const verify = [
  'import sys',
  `sys.path.insert(0, ${JSON.stringify(root)})`,
  'import main, fastapi, torch, ultralytics, mediapipe, faster_whisper',
  'print("import-ok")',
].join('; ');
execFileSync(pyBin, ['-c', verify], { stdio: 'inherit' });

// The runtime paths that an import check alone cannot prove: the legacy
// MediaPipe face detector (the precise face boxes) and faster-whisper's VAD
// (which lazily imports onnxruntime — its absence only shows up at runtime,
// never at import time). Both are load-bearing for the desktop app.
const runtimeVerify = [
  'import sys',
  `sys.path.insert(0, ${JSON.stringify(root)})`,
  'import mediapipe as mp',
  'mp.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.5)',
  'import faster_whisper.vad',
  'import onnxruntime',
  'print("runtime-ok")',
].join('; ');
execFileSync(pyBin, ['-c', runtimeVerify], { stdio: 'inherit' });

// 4) RELOCATION TEST — the whole point of using a relocatable interpreter.
// Run the runtime from a DIFFERENT path and make sure the dependencies still
// import. This catches any absolute path that leaked into the bundle, BEFORE
// it ships to a user who would get a dead app.
//
// RENAME the tree instead of copying it: a rename is atomic and free, while
// a copy of the ~1.3 GB runtime would blow past the runner's free disk
// space (and then the job gets cancelled mid-build). Renaming genuinely
// exercises the same thing — the interpreter resolves its prefix from its own
// location, and the dependencies are imported from the new path.
const probeParent = path.join(root, 'desktop', 'resources');
const relocated = path.join(probeParent, `.relocated-${process.pid}`);
try {
  fs.renameSync(pyDir, relocated);
  const movedBin = resolvePyBin(relocated);
  execFileSync(movedBin, ['-c',
    'import torch, ultralytics, mediapipe, faster_whisper, onnxruntime; ' +
    'import sys; print("relocate-ok", sys.prefix)'],
    { stdio: 'inherit' });
  console.log('[build-python] relocation test: PASS');
} finally {
  // Put it back where the rest of the build expects it.
  if (fs.existsSync(relocated) && !fs.existsSync(pyDir)) {
    fs.renameSync(relocated, pyDir);
  }
}

console.log('[build-python] DONE ->', pyDir);
console.log(`[build-python] DW_SHORTS_PYTHON=${pyBin}`);
