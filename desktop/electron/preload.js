/**
 * DW-shorts preload: a thin, context-isolated bridge between the dashboard
 * (renderer) and the Electron main process (plan §5.5 / §6).
 *
 * The dashboard's key handling (encrypt/decrypt) now calls window.dwSecrets
 * instead of the old client-side XOR; the actual cryptography lives in the
 * main process via safeStorage (macOS Keychain / Windows DPAPI). The old XOR
 * read path is preserved in the dashboard so upgraded users don't lose keys.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The per-launch desktop token, handed over by the main process through
// webPreferences.additionalArguments. The backend only accepts a local file
// path when a request carries it.
const tokenArg = process.argv.find((a) => a.startsWith('--dw-desktop-token='));
const DESKTOP_TOKEN = tokenArg ? tokenArg.slice('--dw-desktop-token='.length) : '';

contextBridge.exposeInMainWorld('dwSecrets', {
  set: (k, v) => ipcRenderer.invoke('secret:set', k, v),
  get: (k) => ipcRenderer.invoke('secret:get', k),
  del: (k) => ipcRenderer.invoke('secret:del', k),
});

// The real path of a file the user picked.
//
// In a browser a File object deliberately hides its path — the page only
// gets the bytes. Electron 32 added webUtils.getPathForFile for exactly
// this: the app is running on the user's own machine, so the path is
// already there and pushing a multi-gigabyte video through the loopback
// HTTP server copies it for nothing.
//
// Outside Electron this bridge does not exist, and the dashboard falls back
// to uploading the file as before.
contextBridge.exposeInMainWorld('dwFiles', {
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  desktopToken: DESKTOP_TOKEN,
});

contextBridge.exposeInMainWorld('dwShell', {
  onBackendExit: (cb) => ipcRenderer.on('backend:exit', (_e, code) => cb(code)),
  onBackendFailed: (cb) => ipcRenderer.on('backend:failed', () => cb()),
});
