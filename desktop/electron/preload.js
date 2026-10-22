/**
 * DW-shorts preload: a thin, context-isolated bridge between the dashboard
 * (renderer) and the Electron main process (plan §5.5 / §6).
 *
 * The dashboard's key handling (encrypt/decrypt) now calls window.dwSecrets
 * instead of the old client-side XOR; the actual cryptography lives in the
 * main process via safeStorage (macOS Keychain / Windows DPAPI). The old XOR
 * read path is preserved in the dashboard so upgraded users don't lose keys.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dwSecrets', {
  set: (k, v) => ipcRenderer.invoke('secret:set', k, v),
  get: (k) => ipcRenderer.invoke('secret:get', k),
  del: (k) => ipcRenderer.invoke('secret:del', k),
});

contextBridge.exposeInMainWorld('dwShell', {
  onBackendExit: (cb) => ipcRenderer.on('backend:exit', (_e, code) => cb(code)),
  onBackendFailed: (cb) => ipcRenderer.on('backend:failed', () => cb()),
});
