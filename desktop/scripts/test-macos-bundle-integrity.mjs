/**
 * Tests for the macOS bundle's integrity.
 *
 * The app is shipped unsigned on purpose, but the bundle still has to hold a
 * VALID signature, and it has to stay valid after the app has run. Both
 * things have bitten us:
 *
 *  - Electron's binaries carry only a linker-level ad-hoc signature, and
 *    electron-builder copies extraResources in afterwards, so the bundle's
 *    signature no longer validated. macOS reads an invalid signature as a
 *    corrupt bundle: "已损坏，无法打开", with no right-click → Open escape
 *    hatch.
 *
 *  - the bundled Python writes __pycache__/*.pyc next to the source it
 *    imports. That is a write INTO the signed bundle, and a file added or
 *    changed inside a signed bundle invalidates its signature — so a
 *    correctly signed app became "damaged" after its first run.
 *
 * The checks that need a built bundle are skipped when there is none; the
 * ones that read the source run everywhere.
 *
 * Usage: node scripts/test-macos-bundle-integrity.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const pending = [];

function check(name, fn) {
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

function skip(name, why) {
  console.log(`SKIP  ${name}\n      ${why}`);
}

const mainJs = fs.readFileSync(path.join(desktopDir, 'electron', 'main.js'), 'utf-8');
const config = fs.readFileSync(path.join(desktopDir, 'electron', 'builder-config.js'), 'utf-8');

// ---- the backend must not write into the bundle ----------------------------

check('the backend env redirects the Python bytecode cache out of the bundle', () => {
  assert.match(
    mainJs,
    /PYTHONPYCACHEPREFIX:\s*path\.join\(app\.getPath\('userData'\)/,
    'main.js must set PYTHONPYCACHEPREFIX to a path under userData',
  );
});

check('the bytecode cache is not redirected into the bundle', () => {
  // A prefix under process.resourcesPath would put the .pyc right back where
  // they broke the signature.
  const m = mainJs.match(/PYTHONPYCACHEPREFIX:\s*([^,\n]+)/);
  assert.ok(m, 'PYTHONPYCACHEPREFIX is not set at all');
  assert.ok(
    !/resourcesPath|DW_SHORTS_BUNDLE/.test(m[1]),
    `PYTHONPYCACHEPREFIX must not point into the bundle, got: ${m[1].trim()}`,
  );
});

// ---- the bundle must carry a valid signature -------------------------------

check('the build signs the app before the dmg is assembled', () => {
  assert.match(config, /afterPack:/, 'builder-config.js must set an afterPack hook');
  const m = config.match(/afterPack:\s*path\.join\(__dirname,\s*'([^']+)'\)/);
  assert.ok(m, 'afterPack must point at a file next to the config');
  const hook = path.join(desktopDir, 'electron', m[1]);
  assert.ok(fs.existsSync(hook), `the afterPack hook is missing: ${hook}`);
});

check('the signing hook verifies the signature it produced', () => {
  const hook = fs.readFileSync(
    path.join(desktopDir, 'electron', 'after-pack-sign.js'), 'utf-8');
  assert.match(hook, /--verify/, 'the hook must verify the signature');
  assert.match(hook, /--deep/, 'the hook must verify the nested code too');
});

// ---- behavioural checks against a built bundle ------------------------------

const bundle = path.join(desktopDir, 'dist', 'mac-arm64', 'DW-shorts.app');
const dmg = path.join(desktopDir, 'dist', 'DW-shorts-1.0.0-arm64.dmg');

if (!fs.existsSync(bundle)) {
  skip('running the bundled python leaves no bytecode behind', 'no built bundle');
  skip('the installed app keeps a valid signature after it runs', 'no built bundle');
} else {
  check('running the bundled python leaves no bytecode behind', () => {
    const python = path.join(bundle, 'Contents', 'Resources', 'python', 'bin', 'python3.12');
    if (!fs.existsSync(python)) throw new Error(`no bundled interpreter at ${python}`);
    const before = countPycache(bundle);
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pycache-'));
    try {
      execFileSync(python, ['-c', 'import uvicorn, fastapi, cv2, numpy'], {
        env: { ...process.env, PYTHONPYCACHEPREFIX: prefix },
        stdio: 'ignore',
      });
      const after = countPycache(bundle);
      assert.equal(after, before,
        `the run wrote ${after - before} bytecode file(s) into the bundle`);
      // And the bytecode really went somewhere — otherwise the check above
      // would pass simply because nothing was compiled at all.
      //
      // With a pycache prefix the layout is <prefix>/<absolute source path>.pyc
      // — there is no __pycache__ directory in it, so count the .pyc files.
      const redirected = countPycFiles(prefix);
      assert.ok(redirected > 0,
        'the prefix directory received no bytecode — the redirect is not working');
    } finally {
      fs.rmSync(prefix, { recursive: true, force: true });
    }
  });

  check('the bundle carries a valid signature', () => {
    execFileSync('/usr/bin/codesign',
                 ['--verify', '--deep', '--strict', bundle],
                 { stdio: 'pipe' });
  });
}

if (!fs.existsSync(dmg)) {
  skip('the dmg holds the installer helper', 'no dmg built');
} else {
  check('the dmg holds the installer helper', () => {
    const plist = execFileSync('/usr/bin/hdiutil',
      ['attach', dmg, '-nobrowse', '-readonly', '-plist'], { encoding: 'utf8' });
    const mount = (plist.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/) || [])[1];
    assert.ok(mount, 'the dmg did not mount');
    try {
      const entries = fs.readdirSync(mount);
      assert.ok(entries.includes('DW-shorts.app'),
        `DW-shorts.app is missing from the dmg: ${entries.join(', ')}`);
      assert.ok(entries.includes('安装.command'),
        `安装.command is missing from the dmg: ${entries.join(', ')}`);
    } finally {
      try {
        execFileSync('/usr/bin/hdiutil', ['detach', mount, '-quiet'], { stdio: 'ignore' });
      } catch { /* already gone */ }
    }
  });
}

function countPycache(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === '__pycache__') {
          try { n += fs.readdirSync(p).length; } catch { /* gone */ }
        } else {
          walk(p);
        }
      }
    }
  };
  walk(dir);
  return n;
}

/** Bytecode written under a pycache prefix: <prefix>/<abs source path>.pyc */
function countPycFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.pyc')) n++;
    }
  };
  walk(dir);
  return n;
}

await Promise.all(pending);
console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
