/**
 * Download a static ffmpeg/ffprobe into desktop/resources/bin (plan §7.2).
 *
 * Picks a platform-appropriate static build so the ~21 bare `ffmpeg` calls in
 * the pipeline resolve to the bundled binary via desktop_runtime's PATH injection
 * (no system ffmpeg dependency on the user's machine).
 *
 * Builds used:
 *   macOS   : osxexperts.net arm64 build (self-contained: only /usr/lib and
 *              the system frameworks are linked; no Homebrew dylib chasing)
 *   Windows : gyan.dev "essentials" build (x64)
 *
 * The macOS source used to be evermeet.cx, which now answers HTTP 410 Gone —
 * the service is gone, so the build cannot depend on it. Several URLs are
 * tried in order because these are third-party CDNs.
 *
 * Usage: node scripts/build-ffmpeg.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { download } from './lib/download.mjs';
import { extractTar, extractZip } from './lib/extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const binDir = path.join(root, 'desktop', 'resources', 'bin');
fs.mkdirSync(binDir, { recursive: true });

const isWin = process.platform === 'win32';
const arch = process.arch;

const ffName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
const fpName = isWin ? 'ffprobe.exe' : 'ffprobe';

/**
 * Reuse the binaries already in resources/bin when they work.
 *
 * The download is 21 MB from a third-party CDN that is often slow, and a
 * rebuild does not need a new ffmpeg. Pass --force to fetch it again.
 */
function existingBinaries() {
  if (process.argv.includes('--force')) return null;
  const ff = path.join(binDir, ffName);
  const fp = path.join(binDir, fpName);
  if (!fs.existsSync(ff) || !fs.existsSync(fp)) return null;
  try {
    execFileSync(ff, ['-version'], { stdio: 'ignore' });
    execFileSync(fp, ['-version'], { stdio: 'ignore' });
  } catch {
    return null;   // present but broken — download a fresh one
  }
  return { ff, fp };
}

// Candidate sources, most preferred first.
//
// The npmmirror (Alibaba's CDN) comes first on Windows. Measured on a
// China-connected Windows machine:
//
//   npmmirror  ffmpeg-builds   1069 KB/s
//   GitHub     ffmpeg-builds    100-130 KB/s
//   gyan.dev   essentials zip    10-26 KB/s
//
// The same file is an order of magnitude faster from the mirror. The
// archive there is a .tar.xz rather than a .zip; bsdtar reads it.
//
// The GitHub and gyan.dev entries stay as fallbacks for when the mirror is
// unreachable.
//
// Each entry is {url, name}: `name` is the local file name, and its
// extension decides how the archive is unpacked.
const macUrls = [
  { url: 'https://www.osxexperts.net/ffmpeg80arm.zip', name: 'ffmpeg.zip' },
  { url: 'https://www.osxexperts.net/ffmpeg7arm.zip', name: 'ffmpeg.zip' },
  { url: 'https://www.osxexperts.net/ffmpeg6arm.zip', name: 'ffmpeg.zip' },
];
const winUrls = [
  {
    url: 'https://registry.npmmirror.com/-/binary/ffmpeg-builds/v8.1.3/ffmpeg-8.1.3-win32-x64-gpl.tar.xz',
    name: 'ffmpeg.tar.xz',
  },
  {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    name: 'ffmpeg.zip',
  },
  {
    url: 'https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip',
    name: 'ffmpeg.zip',
  },
  {
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    name: 'ffmpeg.zip',
  },
];
// osxexperts ships ffmpeg and ffprobe as SEPARATE zips; the Windows builds
// ship both in one archive.
const separateProbe = !isWin;
const probeUrls = isWin
  ? []
  : [
    { url: 'https://www.osxexperts.net/ffprobe80arm.zip', name: 'ffprobe.zip' },
    { url: 'https://www.osxexperts.net/ffprobe7arm.zip', name: 'ffprobe.zip' },
    { url: 'https://www.osxexperts.net/ffprobe6arm.zip', name: 'ffprobe.zip' },
  ];

const urls = isWin ? winUrls : macUrls;
// The archive and the extracted files live in SEPARATE directories. Cleaning
// the extraction (which happens between attempts, and inside extractZip when
// a method fails) must never remove the archive that was just downloaded.
const downloadDir = path.join(binDir, '.download');
const extractDir = path.join(binDir, '.extract');
fs.mkdirSync(downloadDir, { recursive: true });

const existing = existingBinaries();
if (existing) {
  console.log(`[build-ffmpeg] already present and working -> ${binDir}`);
  console.log(`[build-ffmpeg] ${existing.ff} -version`);
  execFileSync(existing.ff, ['-version'], { stdio: 'inherit' });
  console.log('[build-ffmpeg] DONE ->', binDir);
  process.exit(0);
}

async function downloadTo(url, dest, label) {
  // Node's own fetch, not curl: Windows 10 1803 ships curl 7.55, which
  // rejects --retry-all-errors, so a curl-based download fails on the
  // user's machine while working on the CI runner.
  //
  // The speed floor matters more than the retry count: a throttled CDN can
  // serve the file at 10 KB/s, which is hours of a build. Below the floor
  // the transfer is abandoned so the next source gets a turn.
  await download(url, dest, {
    label,
    retries: 2,
    minBytesPerSecond: Number(process.env.DW_MIN_DOWNLOAD_KBPS || 64),
  });
}

/** Find the ffmpeg/ffprobe executables in a freshly extracted directory. */
function findExe(dir, name) {
  for (const candidate of [name, `${name}.exe`]) {
    // Direct hit.
    if (fs.existsSync(path.join(dir, candidate))) return path.join(dir, candidate);
    // One level down (the zip may contain a folder).
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d, candidate);
      if (fs.existsSync(p)) return p;
      const p2 = path.join(dir, d, 'bin', candidate);
      if (fs.existsSync(p2)) return p2;
    }
  }
  return null;
}

/** Copy a freshly extracted executable into the bundle, replacing any old one. */
function install(src, dest) {
  // The previous build's copy may be read-only; copyFileSync cannot
  // overwrite it, so clear it first. On Windows the removal can also fail
  // with EBUSY/EPERM when something still holds the file — retry, then fall
  // back to writing over it in place.
  try { fs.rmSync(dest, { force: true }); } catch { /* did not exist, or is locked */ }
  try {
    fs.copyFileSync(src, dest);
  } catch (e) {
    if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
    // Last resort: copy to a temp name and rename over the old one.
    const tmp = `${dest}.new`;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
  }
  try { fs.chmodSync(dest, 0o755); } catch { /* Windows ignores POSIX modes */ }
}

/**
 * Unpack an archive, choosing the method by its extension.
 *
 * A .zip goes through the zip path (which has the Windows-specific
 * fallbacks); a .tar.xz goes through tar, which bsdtar reads everywhere.
 */
function unpack(archive, dest) {
  if (/\.(tar\.xz|tar\.gz|tgz|tar)$/i.test(archive)) {
    extractTar(archive, dest);
  } else {
    extractZip(archive, dest);
  }
}

let installed = 0;
for (const source of urls) {
  const { url, name } = source;
  const archive = path.join(downloadDir, name);
  try {
    console.log(`[build-ffmpeg] downloading ${url}`);
    // Clean the extraction directory BEFORE downloading: the archive lives
    // in its own directory precisely so that cleaning the extraction cannot
    // delete the file that was just downloaded.
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    await downloadTo(url, archive, 'ffmpeg');
    unpack(archive, extractDir);
    const ff = findExe(extractDir, 'ffmpeg');
    if (!ff) throw new Error('ffmpeg not found in the archive');
    install(ff, path.join(binDir, ffName));
    installed++;
    // The Windows archives ship BOTH binaries — take ffprobe from the same
    // extraction rather than fetching it again.
    const fp = findExe(extractDir, 'ffprobe');
    if (fp) install(fp, path.join(binDir, fpName));
    break;
  } catch (e) {
    console.warn(`[build-ffmpeg] ${url} failed: ${e.message}`);
  }
}
if (!installed) throw new Error('[build-ffmpeg] could not obtain ffmpeg from any source');

if (separateProbe && !fs.existsSync(path.join(binDir, fpName))) {
  let ok = false;
  for (const source of probeUrls) {
    const { url, name } = source;
    const archive = path.join(downloadDir, name);
    try {
      console.log(`[build-ffmpeg] downloading ${url}`);
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      await downloadTo(url, archive, 'ffprobe');
      unpack(archive, extractDir);
      const fp = findExe(extractDir, 'ffprobe');
      if (!fp) throw new Error('ffprobe not found in the archive');
      install(fp, path.join(binDir, fpName));
      ok = true;
      break;
    } catch (e) {
      console.warn(`[build-ffmpeg] ${url} failed: ${e.message}`);
    }
  }
  if (!ok) throw new Error('[build-ffmpeg] could not obtain ffprobe from any source');
}

// Drop the AppleDouble sidecar files (._foo) that macOS zips carry — they
// are metadata, and electron-builder would ship them into the bundle.
for (const f of fs.readdirSync(binDir)) {
  if (f.startsWith('._')) fs.rmSync(path.join(binDir, f), { force: true });
}
try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch { /* locked */ }
try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* locked */ }

console.log('[build-ffmpeg] versions:');
// Informational only: verify-bundle.mjs runs the same check on the packaged
// bundle and fails the build if the binary does not work, and that is the
// authoritative gate. Failing here as well would only mean a build that is
// about to be rejected anyway.
for (const name of [ffName, fpName]) {
  try {
    execFileSync(path.join(binDir, name), ['-version'], { stdio: 'inherit' });
  } catch (e) {
    console.warn(`[build-ffmpeg] ${name} could not be run here: ${e.message}`);
  }
}
console.log('[build-ffmpeg] DONE ->', binDir);
void arch;
