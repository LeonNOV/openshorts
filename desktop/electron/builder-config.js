/**
 * electron-builder configuration for DW-shorts (plan §7.3).
 *
 * Deliberately NOT signed / notarized (plan §11 / P4). extraResources copies
 * the Python prefix, ffmpeg, models and the built dashboard into the app so
 * they land under process.resourcesPath at runtime. The Electron main process
 * points DW_SHORTS_BUNDLE at that directory.
 */
const path = require('path');

/** Repo root = desktop/.. */
const root = path.resolve(__dirname, '..', '..');

module.exports = {
  appId: 'com.dwshorts.app',
  productName: 'DW-shorts',
  // Build artifacts land in desktop/dist; buildResources are the static extras.
  directories: {
    output: 'dist',
    buildResources: 'resources',
    app: root,
  },
  // Only what the runtime needs — the large resources live in extraResources.
  files: [
    'desktop/electron/**/*',
    'desktop/package.json',
  ],
  extraResources: [
    { from: 'desktop/resources/python', to: 'python' },
    { from: 'desktop/resources/bin', to: 'bin' },
    { from: 'desktop/resources/models', to: 'models' },
    { from: 'dashboard/dist', to: 'app' },
    { from: 'fonts', to: 'fonts' },
  ],
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }],
    // No Developer ID / no notarization (plan §11). See install.command for the
    // free Personal-Team sign option that removes the Gatekeeper first-launch block.
    identity: null,
    notarize: false,
    hardenedRuntime: false,
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    // No Authenticode signature (plan §11). Users click "More info → Run anyway".
    signed: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
  publish: null,
};
