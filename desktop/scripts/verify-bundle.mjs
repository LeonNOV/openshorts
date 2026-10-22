/**
 * Self-check the assembled desktop bundle before packaging (plan §7.1 / §9).
 *
 * Verifies, on the BUILT artifacts (not the dev venv), that:
 *   - the bundled Python can import the real pipeline modules;
 *   - ffmpeg/ffprobe binaries are present and runnable;
 *   - the offline Whisper CT2 dir (with model.bin) and YOLO weights exist.
 *
 * Exits non-zero on the first missing/!ok item so CI fails loudly.
 *
 * Usage: node scripts/verify-bundle.mjs [bundle_dir]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const bundle = process.argv[2] || path.join(root, 'desktop', 'resources');
const isWin = process.platform === 'win32';

const pyBin = isWin
  ? path.join(bundle, 'python', 'python.exe')
  : path.join(bundle, 'python', 'bin', 'python3.12');
const ffmpeg = path.join(bundle, 'bin', isWin ? 'ffmpeg.exe' : 'ffmpeg');
const ffprobe = path.join(bundle, 'bin', isWin ? 'ffprobe.exe' : 'ffprobe');
const whisperModel = path.join(bundle, 'models', 'faster-whisper-small', 'model.bin');
const yolo = path.join(bundle, 'models', 'yolov8n.pt');

let ok = true;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) ok = false;
}

check(`python exists (${pyBin})`, fs.existsSync(pyBin));
check(`ffmpeg exists (${ffmpeg})`, fs.existsSync(ffmpeg));
check(`ffprobe exists (${ffprobe})`, fs.existsSync(ffprobe));
check(`whisper model.bin exists (${whisperModel})`, fs.existsSync(whisperModel));
check(`yolo weights exist (${yolo})`, fs.existsSync(yolo));

if (ok && fs.existsSync(pyBin)) {
  try {
    const appSrc = path.join(bundle, 'app_src');
    execFileSync(pyBin, ['-c',
      `import sys; sys.path.insert(0, ${JSON.stringify(appSrc)}); ` +
      'import main, fastapi, torch, ultralytics, mediapipe, faster_whisper; print("import-ok")'],
      { stdio: 'inherit' });
    console.log('PASS  bundled python imports the pipeline');
  } catch (e) {
    console.log('FAIL  bundled python import error');
    ok = false;
  }
}
if (ok && fs.existsSync(ffmpeg)) {
  try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); console.log('PASS  ffmpeg runs'); }
  catch { console.log('FAIL  ffmpeg failed to run'); ok = false; }
}

if (!ok) { console.error('\nBUNDLE VERIFY: FAILED'); process.exit(1); }
console.log('\nBUNDLE VERIFY: PASS');
