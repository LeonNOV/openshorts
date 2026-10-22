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

// Preferred loopback port (plan §2.2). DW_SHORTS_PORT overrides it.
//
// The port is resolved at startup rather than fixed: if 48152 is already
// taken — by an orphaned backend from a previous launch, or by something
// else entirely — the app used to silently point its window at whatever was
// listening there. That is how a stale backend (running an OLD build) kept
// answering job requests long after the app had been updated. Now the app
// always runs ITS OWN backend: when the preferred port is busy it picks a
// free one, and only an explicit DW_SHORTS_PORT is honored as-is.
const PREFERRED_PORT = parseInt(process.env.DW_SHORTS_PORT, 10) || 48152;
const PORT_IS_EXPLICIT = !!parseInt(process.env.DW_SHORTS_PORT, 10);
let PORT = PREFERRED_PORT;
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

/**
 * Python executable inside the bundled resources.
 *
 * The bundle ships a RELOCATABLE standalone CPython (see
 * desktop/scripts/fetch-python.mjs) whose layout is:
 *   - POSIX   : resources/python/bin/python3.12 (+ python, python3 symlinks)
 *   - Windows : resources/python/python.exe
 * Probe the candidates instead of assuming one, so the shipped app starts
 * regardless of which layout the bundle was built with.
 */
function pythonExe() {
  const res = process.resourcesPath;
  const win = process.platform === 'win32';
  const dirs = win ? ['', 'bin', 'Scripts'] : ['bin', ''];
  const names = win ? ['python.exe', 'python3.exe', 'python'] : ['python', 'python3', 'python3.12'];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(res, 'python', d, n);
      try { if (fs.existsSync(p)) return p; } catch (_) { /* keep probing */ }
    }
  }
  // Nothing matched — return the conventional path so the spawn error message
  // names the expected location instead of failing with "undefined".
  return win
    ? path.join(res, 'python', 'python.exe')
    : path.join(res, 'python', 'bin', 'python3.12');
}

/** True if the given port is already taken. */
function portInUse(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => { srv.close(() => resolve(false)); });
    srv.listen(port, '127.0.0.1');
  });
}

/** Ask the OS for a free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Decide which port this instance's backend should use.
 *
 * An explicitly configured DW_SHORTS_PORT is honored as-is (the user asked
 * for it; if it is taken we fail loudly rather than quietly moving). The
 * default port is only a preference: if something else already holds it, we
 * take a free port instead of attaching to a foreign server.
 */
async function resolvePort() {
  if (!(await portInUse(PREFERRED_PORT))) return PREFERRED_PORT;
  if (PORT_IS_EXPLICIT) {
    throw new Error(
      `port ${PREFERRED_PORT} is already in use (DW_SHORTS_PORT is set to it)`,
    );
  }
  const port = await freePort();
  console.log(`[main] port ${PREFERRED_PORT} is busy; using ${port} instead`);
  return port;
}

async function waitForHealth(timeoutMs = 30000) {
  const url = `http://127.0.0.1:${PORT}/health`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
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
  // The bundled Python source tree and the built dashboard both live under
  // process.resourcesPath; make the backend find them.
  env.DW_SHORTS_DASHBOARD_DIR = path.join(res, 'app');
  env.PYTHONPATH = path.join(res, 'app_src');
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

// One instance per user: a second launch focuses the running window instead
// of starting a second backend against the same data directory.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(async () => {
  try {
    PORT = await resolvePort();
  } catch (e) {
    console.error(`[main] ${e.message}`);
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
