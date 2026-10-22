/**
 * DW-shorts Electron main process (plan §6).
 *
 * Responsibilities:
 *  - spawn / monitor / restart the FastAPI backend (Python) as a child process;
 *  - probe the fixed port (48152) and poll /health before showing the window;
 *  - capture backend stdout/stderr to <userData>/logs/backend.log;
 *  - bridge secret storage to the renderer via safeStorage (OS keychain);
 *  - keep mutable data out of the read-only install dir (cwd = userData).
 *
 * The backend speaks HTTP on 127.0.0.1 only; the dashboard is served by the
 * backend itself, so the UI and API are same-origin (no CORS / dev proxy).
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

// Fixed loopback port (plan §2.2). Honors DW_SHORTS_PORT so a user can move it
// if 48152 is taken (§5.6); the value is also forwarded into the backend env.
const PORT = parseInt(process.env.DW_SHORTS_PORT, 10) || 48152;
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
let backend = null;
let win = null;

function logDir() {
  return path.join(app.getPath('userData'), 'logs');
}
function logFile() {
  return path.join(logDir(), 'backend.log');
}
function logBackend(label, chunk) {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${label} ${chunk}`);
  } catch (_) { /* best-effort */ }
}

/** Python executable inside the bundled resources. */
function pythonExe() {
  const res = process.resourcesPath;
  return process.platform === 'win32'
    ? path.join(res, 'python', 'python.exe')
    : path.join(res, 'python', 'bin', 'python3.12');
}

/** True if the port is already taken (another instance or a stale backend). */
function portInUse() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => { srv.close(() => resolve(false)); });
    srv.listen(PORT, '127.0.0.1');
  });
}

async function waitForHealth(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return true;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startBackend() {
  const res = process.resourcesPath;
  // Read persisted settings so the user's whisper-size choice reaches the
  // backend env (desktop_runtime honors DW_SHORTS_WHISPER_SIZE).
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8')); } catch (_) { /* none yet */ }
  const env = {
    ...process.env,
    DW_SHORTS_BUNDLE: res,                       // desktop_runtime reads this
    DW_SHORTS_DATA_DIR: app.getPath('userData'),  // writable: uploads/output/logs
    DW_SHORTS_PORT: String(PORT),
    PYTHONIOENCODING: 'utf-8',                    // Windows console safety (§5.7)
    PYTHONUNBUFFERED: '1',
  };
  if (settings.whisperSize) env.DW_SHORTS_WHISPER_SIZE = String(settings.whisperSize);
  backend = spawn(pythonExe(), ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1',
    '--port', String(PORT)], {
    cwd: app.getPath('userData'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (d) => logBackend('OUT', d));
  backend.stderr.on('data', (d) => logBackend('ERR', d));
  backend.on('exit', (code) => {
    logBackend('EXIT', `backend exited with code ${code}\n`);
    backend = null;
    // Surface a restart affordance in the UI rather than dying silently.
    if (win && !win.isDestroyed()) win.webContents.send('backend:exit', code);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

// ---- secret bridge (plan §5.5 / §6.3): OS keychain via safeStorage ----
const SECRETS_FILE = () => path.join(app.getPath('userData'), 'keys.json');

ipcMain.handle('secret:set', (_e, key, value) => {
  const buf = safeStorage.encryptString(value);
  const all = readSecrets();
  all[key] = buf.toString('base64');
  fs.writeFileSync(SECRETS_FILE(), JSON.stringify(all));
  return true;
});
ipcMain.handle('secret:get', (_e, key) => {
  const all = readSecrets();
  if (!(key in all)) return null;
  try {
    return safeStorage.decryptString(Buffer.from(all[key], 'base64'));
  } catch (_) { return null; }
});
ipcMain.handle('secret:del', (_e, key) => {
  const all = readSecrets();
  delete all[key];
  fs.writeFileSync(SECRETS_FILE(), JSON.stringify(all));
  return true;
});

function readSecrets() {
  try { return JSON.parse(fs.readFileSync(SECRETS_FILE(), 'utf-8')); }
  catch (_) { return {}; }
}

app.whenReady().then(async () => {
  if (await portInUse()) {
    // Another instance owns the port — just point the window at it.
    createWindow();
    return;
  }
  startBackend();
  const ok = await waitForHealth();
  if (ok) {
    createWindow();
  } else {
    // Show the error page with the backend log tail so the user isn't stranded.
    createWindow();
    if (win) win.webContents.once('did-finish-load', () =>
      win.webContents.send('backend:failed'));
  }
});

app.on('before-quit', () => { if (backend) backend.kill(); });
app.on('window-all-closed', () => { if (backend) backend.kill(); if (process.platform !== 'darwin') app.quit(); });
