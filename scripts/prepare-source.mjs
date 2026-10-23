/**
 * Prepare the bundled Python source tree for the DW-shorts desktop build.
 *
 * Copies the repository's Python project (app.py, main.py, pipeline modules,
 * assets/, fonts/, subpackages) into desktop/resources/app_src so the packaged
 * backend can `python -m uvicorn app:app` with PYTHONPATH pointing here. This is
 * the missing piece the Electron shell needs: extraResources already ships the
 * Python *venv*, ffmpeg and models, but not the project *source*.
 *
 * Heavy / irrelevant directories are excluded so the app stays lean and so we
 * never copy the very resources/ tree we are building into.
 *
 * Usage: node scripts/prepare-source.mjs   (run from repo root)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'desktop', 'resources', 'app_src');

// Top-level entries that must NOT be copied into the bundle.
const EXCLUDE = new Set([
  '.git', '.venv', 'node_modules', '__pycache__', '.workbuddy',
  'desktop',        // its resources/ is built separately; avoid recursion
  'dashboard',      // React source (we ship dashboard/dist instead)
  'remotion',       // cloud render-only, not used by the local pipeline
  'render-service',  // cloud render-only
  'output', 'uploads', 'screenshots',
  '.github', '.idea', '.vscode', 'dist',
]);

// Binary / media extensions that are demo assets, not runtime source.
const MEDIA_EXT = new Set([
  '.mp4', '.gif', '.mov', '.avi', '.mkv', '.webm', '.zip', '.gz', '.pt',
]);

// Files that hold secrets and must never end up in a shipped installer.
//
// The important one is `.env`: app.py, main.py and s3_uploader.py all call
// load_dotenv(), which looks for a .env next to the module — and the module
// lives in the bundle. A .env in the repository therefore becomes a .env in
// every user's installation, complete with the AWS credentials it carries,
// and the app loads it at runtime.
//
// The rest are the usual suspects for a machine that also happens to be a
// development machine.
const SECRET_NAMES = new Set([
  '.env', '.envrc', '.netrc', '_netrc', '.npmrc', '.pypirc', '.dockercfg',
  'credentials', 'credentials.json', 'secrets.json', 'service-account.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const SECRET_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore']);
// A template carries no secrets and is worth shipping.
const SECRET_NAME_ALLOWED = /(\.example|\.sample|\.template|\.dist)$/i;

function excluded(src) {
  const rel = path.relative(root, src);
  if (!rel || rel === '.') return false;
  const top = rel.split(path.sep)[0];
  if (EXCLUDE.has(top)) return true;
  if (top.endsWith('.egg-info')) return true;
  const base = path.basename(src);
  if (base === '.DS_Store') return true;
  if (MEDIA_EXT.has(path.extname(src).toLowerCase())) return true;
  // Secrets, by name — at any depth, not just at the top level.
  if (!SECRET_NAME_ALLOWED.test(base)) {
    if (SECRET_NAMES.has(base) || SECRET_NAMES.has(base.toLowerCase())) return true;
    if (SECRET_EXT.has(path.extname(base).toLowerCase())) return true;
    // .env.local, .env.production, ... — any .env with a suffix.
    if (/^\.env\./i.test(base) || /^\.env$/i.test(base)) return true;
  }
  return false;
}

/**
 * Remove a directory tree, tolerating the failures Windows throws.
 *
 * rmSync fails with EPERM on read-only files, and EBUSY on a directory that
 * something still holds open. Neither should stop a build: the copy below
 * overwrites what it can, and a leftover file only matters if it is a stale
 * copy of a file that no longer exists in the source tree.
 */
function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (e) {
    // Read-only leftovers: clear the attribute and try once more.
    try {
      const { chmodSync, readdirSync, statSync } = fs;
      const clear = (p) => {
        try { chmodSync(p, 0o700); } catch { /* not a file we can chmod */ }
        let entries;
        try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          const child = path.join(p, ent.name);
          if (ent.isDirectory()) clear(child);
          else { try { chmodSync(child, 0o600); } catch { /* ignore */ } }
        }
      };
      clear(dir);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (e2) {
      console.warn(`[prepare-source] could not fully clean ${dir}: ${e2.message}`);
    }
  }
}

removeTree(dest);
fs.mkdirSync(dest, { recursive: true });

// Copy top-level entries individually so we never try to copy `root` into a
// subdirectory of itself (desktop/resources/app_src lives under root).
for (const entry of fs.readdirSync(root)) {
  if (EXCLUDE.has(entry) || entry.endsWith('.egg-info')) continue;
  const src = path.join(root, entry);
  const dst = path.join(dest, entry);
  fs.cpSync(src, dst, { recursive: true, filter: (s) => !excluded(s) });
}
console.log('[prepare-source] copied repo source ->', dest);
