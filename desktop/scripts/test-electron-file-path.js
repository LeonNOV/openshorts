/**
 * Test: the desktop app can hand the backend a file's path instead of its
 * bytes.
 *
 * A browser deliberately hides a picked file's path — the page only gets the
 * bytes. Electron 32 added webUtils.getPathForFile for exactly this: the
 * app runs on the user's own machine, so a video they picked is already on
 * disk and pushing it through the loopback HTTP server copies a
 * multi-gigabyte file for nothing.
 *
 * The preload is the piece that exposes it, so this test loads the REAL
 * preload and asks it for the path of a real file.
 *
 * Getting a real path into the renderer needs the debugger: DOM
 * .setFileInputFiles attaches the OS path to the File the way the native
 * picker does. A File built in JavaScript has no path at all, which is why
 * this cannot be faked.
 *
 * Usage: node scripts/test-electron-file-path.js   (run under Electron)
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..');
const preload = path.join(desktopDir, 'electron', 'preload.js');

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
    passed++;
  } else {
    console.log(`FAIL  ${name}\n      ${detail || ''}`);
    failed++;
  }
}

async function main() {
  // A real file with a real path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-electron-'));
  const video = path.join(dir, 'pick me.mp4');
  fs.writeFileSync(video, Buffer.alloc(64, 7));

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const html = `<!doctype html><html><body>
    <input type="file" id="f">
    <script>
      window.picked = 'not-set';
      document.getElementById('f').addEventListener('change', (e) => {
        window.picked = window.dwFiles.getPathForFile(e.target.files[0]);
      });
    </script>
  </body></html>`;
  await win.loadURL('data:text/html,' + encodeURIComponent(html));

  check('the preload exposes dwFiles', await win.webContents.executeJavaScript(
    'typeof window.dwFiles === "object" && window.dwFiles !== null'));

  check('the preload exposes getPathForFile', await win.webContents.executeJavaScript(
    'typeof window.dwFiles?.getPathForFile === "function"'));

  check('the preload exposes a desktop token slot', await win.webContents.executeJavaScript(
    '"desktopToken" in (window.dwFiles || {})'));

  // Put the real file into the input, the way the native picker does.
  const dbg = win.webContents.debugger;
  await dbg.attach('1.3');
  await dbg.sendCommand('DOM.enable');
  const { root } = await dbg.sendCommand('DOM.getDocument');
  const { nodeId } = await dbg.sendCommand('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '#f',
  });
  check('the file input is there', !!nodeId);
  await dbg.sendCommand('DOM.setFileInputFiles', { files: [video], nodeId });
  await win.webContents.executeJavaScript(
    "document.getElementById('f').dispatchEvent(new Event('change'))");

  const picked = await win.webContents.executeJavaScript('window.picked');
  check('getPathForFile returns the real path', picked === video,
        `expected ${video}, got ${picked}`);

  // A File that never came from the picker has no path — the function has to
  // say so rather than throw.
  const synthetic = await win.webContents.executeJavaScript(
    '(function () { try { return window.dwFiles.getPathForFile(new File(["x"], "a.txt")); } ' +
    'catch (e) { return "THREW: " + e.message; } })()');
  check('a synthetic file yields an empty path, not an exception',
        synthetic === '' || synthetic === undefined || synthetic === null,
        `got ${JSON.stringify(synthetic)}`);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
}

app.whenReady()
  .then(main)
  .catch((e) => {
    console.error(`FAILED: ${e.stack || e.message}`);
    app.exit(1);
  });
