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

/**
 * Locate the bundled interpreter.
 *
 * The bundle ships a RELOCATABLE standalone CPython whose layout is:
 *   - POSIX   : python/bin/python3.12 (+ python, python3 symlinks)
 *   - Windows : python/python.exe
 * Probe the candidates rather than assuming one layout.
 */
function resolvePyBin() {
  const isWin = process.platform === 'win32';
  const dirs = isWin ? ['', 'bin', 'Scripts'] : ['bin', ''];
  const names = isWin ? ['python.exe', 'python3.exe', 'python'] : ['python', 'python3', 'python3.12'];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(bundle, 'python', d, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
const pyBin = resolvePyBin();
const ffmpeg = path.join(bundle, 'bin', isWin ? 'ffmpeg.exe' : 'ffmpeg');
const ffprobe = path.join(bundle, 'bin', isWin ? 'ffprobe.exe' : 'ffprobe');
const whisperModel = path.join(bundle, 'models', 'faster-whisper-small', 'model.bin');
const yolo = path.join(bundle, 'models', 'yolov8n.pt');

let ok = true;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) ok = false;
}

check(`python interpreter found (${pyBin || 'none'})`, !!pyBin);
check(`ffmpeg exists (${ffmpeg})`, fs.existsSync(ffmpeg));
check(`ffprobe exists (${ffprobe})`, fs.existsSync(ffprobe));
check(`whisper model.bin exists (${whisperModel})`, fs.existsSync(whisperModel));
check(`yolo weights exist (${yolo})`, fs.existsSync(yolo));

if (ok && pyBin) {
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
  // The two runtime-only paths an import check cannot prove: the legacy
  // MediaPipe face detector and faster-whisper's VAD (which imports
  // onnxruntime lazily, so a missing onnxruntime only fails at runtime).
  try {
    execFileSync(pyBin, ['-c',
      'import mediapipe as mp; ' +
      'mp.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.5); ' +
      'import faster_whisper.vad, onnxruntime; print("runtime-ok")'],
      { stdio: 'inherit' });
    console.log('PASS  bundled python runtime paths (mediapipe face detection + whisper VAD)');
  } catch (e) {
    console.log('FAIL  bundled python runtime path error');
    ok = false;
  }
}
if (ok && fs.existsSync(ffmpeg)) {
  try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); console.log('PASS  ffmpeg runs'); }
  catch { console.log('FAIL  ffmpeg failed to run'); ok = false; }
}

if (!ok) { console.error('\nBUNDLE VERIFY: FAILED'); process.exit(1); }
console.log('\nBUNDLE VERIFY: PASS');
