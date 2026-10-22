/**
 * Print the absolute path of the bundled Python interpreter.
 *
 * The bundle ships a RELOCATABLE standalone CPython whose layout is:
 *   - POSIX   : resources/python/bin/python3.12 (+ python, python3 symlinks)
 *   - Windows : resources/python/python.exe
 *
 * Usage: node scripts/resolve-python.mjs [runtime_dir]
 * Prints the resolved path on stdout (empty if nothing was found).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const runtimeDir = process.argv[2] || path.join(root, 'desktop', 'resources', 'python');
const isWin = process.platform === 'win32';

const dirs = isWin ? ['', 'bin', 'Scripts'] : ['bin', ''];
const names = isWin ? ['python.exe', 'python3.exe', 'python'] : ['python', 'python3', 'python3.12'];

for (const d of dirs) {
  for (const n of names) {
    const p = path.join(runtimeDir, d, n);
    if (fs.existsSync(p)) {
      console.log(p);
      process.exit(0);
    }
  }
}
process.exit(1);
