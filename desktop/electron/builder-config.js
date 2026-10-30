/**
 * electron-builder configuration for DW-shorts (plan §7.3).
 *
 * Deliberately NOT signed / notarized (plan §11 / P4). extraResources copies
 * the Python prefix, ffmpeg, models, the bundled Python SOURCE tree and the
 * built dashboard into the app so they land under process.resourcesPath at
 * runtime. The Electron main process points DW_SHORTS_BUNDLE, DW_SHORTS_DATA_DIR,
 * DW_SHORTS_DASHBOARD_DIR and PYTHONPATH at that directory.
 *
 * Run from desktop/ with:
 *   electron-builder --config electron/builder-config.js --mac --arm64
 */
const path = require('path');

module.exports = {
  appId: 'com.dwshorts.app',
  productName: 'DW-shorts',
  artifactName: 'DW-shorts-${version}-${arch}.${ext}',
  // Sign the packaged bundle before the DMG is assembled. Without this the app
  // keeps the linker-level ad-hoc signature Electron ships, which stops
  // validating once electron-builder has copied extraResources in — and macOS
  // reads an invalid signature as a corrupt bundle ("已损坏，无法打开"), which
  // offers no right-click → Open escape hatch. See electron/after-pack-sign.js.
  afterPack: path.join(__dirname, 'after-pack-sign.js'),
  // Build artifacts land in desktop/dist; app dir is desktop/ itself (it holds
  // the package.json whose `main` points at electron/main.js).
  directories: {
    output: 'dist',
    buildResources: 'resources',
    app: '.',
  },
  // Only the Electron shell goes into the asar; everything else is extraResources.
  files: [
    'electron/**/*',
    'package.json',
  ],
  extraResources: [
    { from: 'resources/python', to: 'python' },
    { from: 'resources/bin', to: 'bin' },
    // The model weights are NOT bundled: ~470 MB of float tensors that barely
    // compress, and they dominated what the user had to download for a 650 MB
    // app. The app fetches them on demand into its data directory instead
    // (see model_store.py and the first-run wizard).
    // Bundled Python source so `python -m uvicorn app:app` can import the pipeline.
    { from: 'resources/app_src', to: 'app_src' },
    // Built dashboard (dashboard/dist) served by the backend at "/".
    { from: '../dashboard/dist', to: 'app' },
  ],
  mac: {
    target: [{ target: 'dmg', arch: 'arm64' }],
    // No Developer ID / no notarization (plan §11). The bundle is still signed
    // ad-hoc by the afterPack hook above, so its signature validates; what
    // Gatekeeper wants on top of that is a Developer ID, or the user running
    // 安装.command, which ships in the DMG for exactly that reason.
    identity: null,
    notarize: false,
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  // dmg options live at the root of the configuration, not under `mac`.
  dmg: {
    // The default layout is the app plus the /Applications link. Adding the
    // installer helper means a user who cannot launch the app straight from
    // the DMG still has one file to double-click.
    contents: [
      { x: 130, y: 200 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
      { x: 130, y: 380, type: 'file', path: 'resources/安装.command', name: '安装.command' },
    ],
  },
  win: {
    target: [{ target: 'nsis', arch: 'x64' }],
    // No Authenticode signature (plan §11): simply provide no certificate —
    // electron-builder then leaves the exe unsigned and the user clicks
    // "More info → Run anyway". There is no `signed` option in its schema.
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
  publish: null,
};
