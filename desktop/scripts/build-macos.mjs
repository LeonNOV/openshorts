/**
 * Package the macOS (Apple Silicon) desktop app.
 *
 * One shot: builds the relocatable Python runtime, ffmpeg and the bundled
 * model weights, builds the dashboard, produces the .dmg and verifies it.
 *
 * Usage:
 *   cd desktop
 *   node scripts/build-macos.mjs
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
  [path.join(here, 'build-app.mjs'), '--target', 'mac', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(res.status === null ? 1 : res.status);
