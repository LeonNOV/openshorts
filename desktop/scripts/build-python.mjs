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
import { execSync, execFileSync } from 'node:child_process';
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
execSync(`"${process.execPath}" "${path.join(__dirname, 'fetch-python.mjs')}" "${pyDir}"`, {
  stdio: 'inherit',
});

/** Resolve the interpreter without assuming a version-stamped name. */
function resolvePyBin(dir) {
  const bin = process.platform === 'win32' ? 'bin' : 'bin';
  const names = process.platform === 'win32'
    ? ['python.exe', 'python3.exe', 'python']
    : ['python', 'python3', 'python3.12'];
  for (const n of names) {
    const p = path.join(dir, bin, n);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`[build-python] no interpreter found in ${path.join(dir, bin)}`);
}
const pyBin = resolvePyBin(pyDir);
console.log(`[build-python] interpreter: ${pyBin}`);

// 2) Install the dependencies straight into the interpreter's site-packages.
const pip = `"${pyBin}" -m pip install --index-url ${MIRROR}`;
execSync(`${pip} -r "${requirements}"`, { stdio: 'inherit' });

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
  execSync(`"${pyBin}" -m pip uninstall -y ${trim.join(' ')}`, { stdio: 'inherit' });
} catch { console.warn('[build-python] some trim packages were not installed (ok)'); }

// A trimmed package leaves its dependents' metadata dangling. Report it
// loudly so a future dependency change can't silently break the shipped app —
// but do not fail the build, because jax's absence is intentional and known.
try {
  execSync(`"${pyBin}" -m pip check`, { stdio: 'inherit' });
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
// Copy the runtime to a throwaway location, run it from there, and make sure
// the dependencies still import. This catches any absolute path that leaked
// into the bundle, BEFORE it ships to a user who would get a dead app.
const probeParent = path.join(root, 'desktop', 'resources');
const probe = path.join(probeParent, `.relocate-probe-${process.pid}`);
try {
  fs.mkdirSync(probe, { recursive: true });
  execSync(`cp -R "${pyDir}" "${probe}/python"`, { stdio: 'inherit' });
  const movedBin = resolvePyBin(path.join(probe, 'python'));
  execFileSync(movedBin, ['-c',
    'import torch, ultralytics, mediapipe, faster_whisper, onnxruntime; ' +
    'import sys; print("relocate-ok", sys.prefix)'],
    { stdio: 'inherit' });
  console.log('[build-python] relocation test: PASS');
} finally {
  try { fs.rmSync(probe, { recursive: true, force: true }); }
  catch { console.warn(`[build-python] could not remove the relocation probe at ${probe} (ok)`); }
}

console.log('[build-python] DONE ->', pyDir);
console.log(`[build-python] DW_SHORTS_PYTHON=${pyBin}`);
