/**
 * Download a static ffmpeg/ffprobe into desktop/resources/bin (plan §7.2).
 *
 * Picks a platform-appropriate static build so the ~21 bare `ffmpeg` calls in
 * the pipeline resolve to the bundled binary via desktop_runtime's PATH injection
 * (no system ffmpeg dependency on the user's machine).
 *
 * Builds used:
 *   macOS   : evermeet.cx static build (universal/arm64)
 *   Windows : gyan.dev "essentials" build (x64)
 *
 * Usage: node scripts/build-ffmpeg.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const binDir = path.join(root, 'desktop', 'resources', 'bin');
fs.mkdirSync(binDir, { recursive: true });

const isWin = process.platform === 'win32';
const url = isWin
  ? 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
  : 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip';
const zipPath = path.join(binDir, 'ffmpeg.zip');

console.log(`[build-ffmpeg] downloading ${url}`);
execSync(`curl -fsSL "${url}" -o "${zipPath}"`, { stdio: 'inherit' });

if (isWin) {
  execSync(`powershell -NoProfile -Command "Expand-Archive -Force '${zipPath}' '${binDir}'"`, { stdio: 'inherit' });
  // gyan.dev layout: ffmpeg-<ver>-essentials_build/bin/{ffmpeg,ffprobe}.exe
  const inner = fs.readdirSync(binDir).find((d) => d.startsWith('ffmpeg') && fs.statSync(path.join(binDir, d)).isDirectory());
  const srcBin = path.join(binDir, inner, 'bin');
  for (const f of ['ffmpeg.exe', 'ffprobe.exe']) {
    fs.copyFileSync(path.join(srcBin, f), path.join(binDir, f));
  }
  fs.rmSync(path.join(binDir, inner), { recursive: true, force: true });
} else {
  execSync(`unzip -o -j "${zipPath}" -d "${binDir}"`, { stdio: 'inherit' });
}
fs.rmSync(zipPath, { force: true });

const ff = isWin ? 'ffmpeg.exe' : 'ffmpeg';
const fp = isWin ? 'ffprobe.exe' : 'ffprobe';
console.log('[build-ffmpeg] versions:');
execSync(`"${path.join(binDir, ff)}" -version`, { stdio: 'inherit' });
execSync(`"${path.join(binDir, fp)}" -version`, { stdio: 'inherit' });
console.log('[build-ffmpeg] DONE ->', binDir);
