/**
 * Build the bundled Python prefix for DW-shorts (plan §7.2).
 *
 * Creates a fresh venv at desktop/resources/python, installs requirements.txt
 * (via the Tsinghua mirror — measured ~3.6 MB/s vs ~120 KB/s from PyPI on this
 * network), trims the desktop-unneeded heavy deps, then verifies the real
 * import path still works. Runs on the target CI runner (macos-14 / win-2022)
 * so the platform binaries are correct — no cross-compilation.
 *
 * Usage: node scripts/build-python.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const pyDir = path.join(root, 'desktop', 'resources', 'python');
const requirements = path.join(root, 'requirements.txt');
const MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple';

// Remove any stale prefix so the trim verification is against a clean build.
fs.rmSync(pyDir, { recursive: true, force: true });

// Prefer `uv` (present on CI); fall back to the system python3.12.
function have(cmd) {
  try { execSync(`${cmd} --version`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}
const useUv = have('uv');
const py = useUv ? 'uv' : (process.platform === 'win32' ? 'py -3.12' : 'python3.12');

console.log(`[build-python] using ${useUv ? 'uv' : 'venv+pip'} (python 3.12)`);
const venvCmd = useUv
  ? `uv venv --python 3.12 "${pyDir}"`
  : `python3.12 -m venv "${pyDir}"`;
execSync(venvCmd, { stdio: 'inherit' });

const pip = useUv
  ? `uv pip install --python "${pyDir}" --default-index ${MIRROR}`
  : `"${path.join(pyDir, 'bin', 'python')}" -m pip install --index-url ${MIRROR}`;
const pyBin = process.platform === 'win32'
  ? path.join(pyDir, 'Scripts', 'python.exe')
  : path.join(pyDir, 'bin', 'python3.12');

execSync(`${pip} -r "${requirements}"`, { stdio: 'inherit' });

// Trim deps the desktop build never uses (plan §1.2 / risk §10). All confirmed
// to be either absent at import time or lazily imported inside excluded backends
// (onnxruntime is only pulled in by the Parakeet GPU path).
const trim = ['jaxlib', 'jax', 'polars', 'polars-runtime-32', 'onnxruntime', 'sympy'];
const trimCmd = useUv
  ? `uv pip uninstall --python "${pyDir}" ${trim.join(' ')}`
  : `"${pyBin}" -m pip uninstall -y ${trim.join(' ')}`;
try { execSync(trimCmd, { stdio: 'inherit' }); }
catch { console.warn('[build-python] some trim packages were not installed (ok)'); }

// Verify the real import path still works after trimming.
const verify = [
  'import main, fastapi, torch, ultralytics, mediapipe, faster_whisper',
  'print("import-ok")',
].join('; ');
execSync(`"${pyBin}" -c "${verify}"`, { stdio: 'inherit' });
console.log('[build-python] DONE ->', pyDir);
