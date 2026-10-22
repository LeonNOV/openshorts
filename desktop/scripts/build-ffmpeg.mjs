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
import { execFileSync } from 'node:child_process';
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
// Array args, not a shell string: the path can contain spaces and the URL
// contains characters a shell would mangle.
execFileSync('curl', ['-fsSL', '--retry', '5', '--retry-all-errors', '-o', zipPath, url], { stdio: 'inherit' });

if (isWin) {
  // Expand-Archive is a PowerShell cmdlet; the runner's default shell is
  // PowerShell 7 (pwsh), and `powershell` (5.1) may not be on PATH.
  execFileSync('pwsh', ['-NoProfile', '-Command',
    `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${binDir}'`],
    { stdio: 'inherit' });
  // gyan.dev layout: ffmpeg-<ver>-essentials_build/bin/{ffmpeg,ffprobe}.exe
  const inner = fs.readdirSync(binDir).find((d) => d.startsWith('ffmpeg') && fs.statSync(path.join(binDir, d)).isDirectory());
  if (!inner) throw new Error(`[build-ffmpeg] could not find the extracted ffmpeg directory in ${binDir}`);
  const srcBin = path.join(binDir, inner, 'bin');
  for (const f of ['ffmpeg.exe', 'ffprobe.exe']) {
    fs.copyFileSync(path.join(srcBin, f), path.join(binDir, f));
  }
  fs.rmSync(path.join(binDir, inner), { recursive: true, force: true });
} else {
  execFileSync('unzip', ['-o', '-j', zipPath, '-d', binDir], { stdio: 'inherit' });
}
fs.rmSync(zipPath, { force: true });

const ff = isWin ? 'ffmpeg.exe' : 'ffmpeg';
const fp = isWin ? 'ffprobe.exe' : 'ffprobe';
console.log('[build-ffmpeg] versions:');
execFileSync(path.join(binDir, ff), ['-version'], { stdio: 'inherit' });
execFileSync(path.join(binDir, fp), ['-version'], { stdio: 'inherit' });
console.log('[build-ffmpeg] DONE ->', binDir);
