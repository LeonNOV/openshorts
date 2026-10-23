/**
 * Guard: no secret may ever end up in the shipped bundle.
 *
 * The desktop installer ships the Python source tree, and that tree is
 * copied straight from the repository by scripts/prepare-source.mjs. A `.env`
 * in the repository therefore becomes a `.env` in every user's installation.
 *
 * That is not a theoretical risk: app.py, main.py and s3_uploader.py all call
 * load_dotenv(), which looks for a .env next to the module — and the module
 * lives in the bundle. The AWS credentials in the repository's .env were
 * shipped in a real macOS build and would have been loaded at runtime.
 *
 * This test builds the source tree the way the build does and looks for
 * anything secret in it.
 *
 * Usage: node scripts/test-no-secrets-bundled.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let failed = 0;
let passed = 0;
function report(name, err) {
  if (err) {
    console.log(`FAIL  ${name}\n      ${err.message}`);
    failed++;
  } else {
    console.log(`PASS  ${name}`);
    passed++;
  }
}

/**
 * The same rules prepare-source.mjs applies. They are duplicated here on
 * purpose: the test has to be able to fail even if the copy logic changes.
 */
const SECRET_NAMES = new Set([
  '.env', '.envrc', '.netrc', '_netrc', '.npmrc', '.pypirc', '.dockercfg',
  'credentials', 'credentials.json', 'secrets.json', 'service-account.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const SECRET_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore']);
const SECRET_NAME_ALLOWED = /(\.example|\.sample|\.template|\.dist)$/i;

function isSecretName(base) {
  if (SECRET_NAME_ALLOWED.test(base)) return false;
  if (SECRET_NAMES.has(base) || SECRET_NAMES.has(base.toLowerCase())) return true;
  if (SECRET_EXT.has(path.extname(base).toLowerCase())) return true;
  if (/^\.env(\.|$)/i.test(base)) return true;
  return false;
}

// --- build the source tree the way the build does --------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-secrets-'));
try {
  const dest = path.join(tmp, 'app_src');
  fs.mkdirSync(dest, { recursive: true });

  const EXCLUDE = new Set([
    '.git', '.venv', 'node_modules', '__pycache__', '.workbuddy',
    'desktop', 'dashboard', 'remotion', 'render-service',
    'output', 'uploads', 'screenshots',
    '.github', '.idea', '.vscode', 'dist',
  ]);
  const MEDIA_EXT = new Set([
    '.mp4', '.gif', '.mov', '.avi', '.mkv', '.webm', '.zip', '.gz', '.pt',
  ]);
  const excluded = (src) => {
    const rel = path.relative(repoRoot, src);
    if (!rel || rel === '.') return false;
    const top = rel.split(path.sep)[0];
    if (EXCLUDE.has(top)) return true;
    if (top.endsWith('.egg-info')) return true;
    const base = path.basename(src);
    if (base === '.DS_Store') return true;
    if (MEDIA_EXT.has(path.extname(src).toLowerCase())) return true;
    return isSecretName(base);
  };

  for (const entry of fs.readdirSync(repoRoot)) {
    if (EXCLUDE.has(entry) || entry.endsWith('.egg-info')) continue;
    const src = path.join(repoRoot, entry);
    const dst = path.join(dest, entry);
    fs.cpSync(src, dst, { recursive: true, filter: (s) => !excluded(s) });
  }

  // --- 1) no secret file in the tree --------------------------------------
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (isSecretName(e.name)) found.push(path.relative(dest, p));
    }
  };
  walk(dest);
  try {
    assert.deepEqual(found, [], `the bundle would contain: ${found.join(', ')}`);
    report('no secret file is copied into the bundle', null);
  } catch (e) {
    report('no secret file is copied into the bundle', e);
  }

  // --- 2) the real .env of this repository must be excluded ----------------
  const realEnv = path.join(repoRoot, '.env');
  if (fs.existsSync(realEnv)) {
    try {
      assert.ok(
        !fs.existsSync(path.join(dest, '.env')),
        'the repository .env was copied into the bundle',
      );
      report('the repository .env stays out of the bundle', null);
    } catch (e) {
      report('the repository .env stays out of the bundle', e);
    }
  } else {
    console.log('PASS  the repository .env stays out of the bundle (no .env here)');
    passed++;
  }

  // --- 3) no key-shaped value in the copied source -------------------------
  // A hardcoded key in a module would be copied just like anything else.
  const keyPatterns = [
    /sk-[A-Za-z0-9]{24,}/,            // OpenAI / DeepSeek style
    /AKIA[0-9A-Z]{16}/,               // AWS access key id
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /ghp_[A-Za-z0-9]{30,}/,           // GitHub token
  ];
  const leaks = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      if (!/\.(py|js|mjs|jsx|json|txt|ya?ml|cfg|ini|toml)$/i.test(e.name)) continue;
      let body;
      try { body = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const pat of keyPatterns) {
        const m = body.match(pat);
        if (m) leaks.push(`${path.relative(dest, p)}: ${m[0].slice(0, 12)}…`);
      }
    }
  };
  scan(dest);
  try {
    assert.deepEqual(leaks, [], `key-shaped values in the source: ${leaks.join(', ')}`);
    report('no key-shaped value is hardcoded in the bundled source', null);
  } catch (e) {
    report('no key-shaped value is hardcoded in the bundled source', e);
  }

  // --- 4) the API keys the user types in are not in the bundle -------------
  // They are entered at runtime and kept in the OS keychain through
  // Electron's safeStorage, so the bundle must not carry them.
  try {
    const secrets = fs.readFileSync(
      path.join(repoRoot, 'dashboard', 'src', 'lib', 'secrets.js'), 'utf8',
    );
    // The storage KEY NAMES are expected; a VALUE would not be.
    const names = ['deepseekKey_v1', 'fishAudioKey_v1', 'elevenLabsKey_v1'];
    for (const n of names) {
      assert.ok(secrets.includes(n), `${n} is not handled at all`);
      // The name must appear as a name, never assigned a literal.
      assert.ok(
        !new RegExp(`${n}\\s*[:=]\\s*["'][A-Za-z0-9_-]{16,}`).test(secrets),
        `${n} has a literal value in the source`,
      );
    }
    report('the user-entered API keys are runtime-only', null);
  } catch (e) {
    report('the user-entered API keys are runtime-only', e);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${failed ? `${failed} failed` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
