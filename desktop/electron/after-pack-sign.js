/**
 * electron-builder hook: sign the packaged macOS app before the DMG is built.
 *
 * The bundle is shipped unsigned (see builder-config.js: identity null,
 * notarize false). Unsigned is survivable; INVALIDLY signed is not.
 *
 * Electron's own binaries carry a linker-level ad-hoc signature, and
 * electron-builder copies extraResources in after that — so the bundle ends
 * up with a signature that claims a resource seal for files it does not
 * have. macOS reads an invalid signature as a corrupt bundle, not as an
 * unverified one, and refuses to open it with
 *
 *   "DW-shorts"已损坏，无法打开
 *
 * which is a much worse message than the usual "cannot be opened because
 * the developer cannot be verified", and it does not offer the right-click
 * → Open escape hatch. Re-signing the whole bundle produces a signature
 * that actually validates, so the app is merely unsigned rather than
 * broken.
 *
 * Ad-hoc ("-") is what is available without a Developer ID certificate.
 * It satisfies the code-signature check macOS makes before it will run an
 * app at all, which is the part that matters on Apple Silicon. It is NOT a
 * substitute for a Developer ID: Gatekeeper still blocks a quarantined
 * copy (one that arrived by download) until the quarantine attribute is
 * removed — which is what 安装.command in the DMG does.
 *
 * The verification is not decoration. A signing step that silently
 * produces a bundle that does not validate would put the broken signature
 * back and the build would still "succeed".
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CODESIGN = fs.existsSync('/usr/bin/codesign') ? '/usr/bin/codesign' : 'codesign';

function codesign(args) {
  return execFileSync(CODESIGN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

/**
 * @param {{appOutDir?: string}} context electron-builder's pack context
 */
async function afterPack(context) {
  if (process.platform !== 'darwin') return;
  let appPath = context && context.appOutDir;
  if (!appPath) {
    throw new Error('after-pack-sign: the pack context has no appOutDir');
  }
  // On macOS appOutDir is the arch directory (dist/mac-arm64); the bundle is
  // the .app inside it.
  if (!appPath.endsWith('.app')) {
    let apps = [];
    try { apps = fs.readdirSync(appPath).filter((n) => n.endsWith('.app')); } catch { /* gone */ }
    if (apps.length !== 1) {
      throw new Error(
        `after-pack-sign: expected exactly one .app in ${appPath}, found ${apps.length}`);
    }
    appPath = path.join(appPath, apps[0]);
  }
  if (!fs.existsSync(appPath)) {
    throw new Error(`after-pack-sign: no app bundle at ${appPath}`);
  }

  // --deep signs the nested helpers and frameworks first, then the bundle.
  codesign(['--force', '--deep', '--sign', '-', appPath]);

  // The point of the whole hook: the signature must validate.
  try {
    codesign(['--verify', '--deep', '--strict', appPath]);
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(
      `after-pack-sign: the ad-hoc signature does not validate, so macOS would ` +
      `call the bundle damaged and refuse to open it.\n${detail}`);
  }

  console.log(`  • signed ${path.basename(appPath)} (ad-hoc) and verified the signature`);
}

module.exports = afterPack;
module.exports.default = afterPack;
