/**
 * Package the Windows (x64) desktop app.
 *
 * One shot: builds the relocatable Python runtime, ffmpeg and the bundled
 * model weights, builds the dashboard, produces the .exe installer and
 * verifies it.
 *
 * Usage:
 *   cd desktop
 *   node scripts/build-windows.mjs
 *
 * The bundled Python runtime is fetched for the host platform and pip can
 * only install wheels that match it, so this script has to run on Windows —
 * a Windows CI runner (windows-2022) or a Windows machine. Building it from
 * macOS would ship the wrong interpreter inside the installer.
 *
 * Flags (see scripts/build-app.mjs):
 *   --skip-deps --skip-frontend --skip-models
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const res = spawnSync(
  process.execPath,
  [path.join(here, 'build-app.mjs'), '--target', 'win', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(res.status === null ? 1 : res.status);
