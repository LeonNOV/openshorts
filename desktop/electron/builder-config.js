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
    // No Developer ID / no notarization (plan §11). See 安装.command for the
    // free Personal-Team sign option that removes the Gatekeeper first-launch block.
    identity: null,
    notarize: false,
    hardenedRuntime: false,
    gatekeeperAssess: false,
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
