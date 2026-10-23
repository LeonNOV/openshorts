/**
 * Cross-platform archive extraction.
 *
 * Windows has no `unzip`, and the CI runner's PowerShell 7 (`pwsh`) is NOT
 * what a normal Windows installation has — a user machine only has Windows
 * PowerShell 5.1 (`powershell.exe`). A build script that shells out to
 * `pwsh` therefore works on the runner and fails on the user's desktop.
 *
 * Candidates for a zip, in order of preference:
 *   1. tar.exe  — bsdtar ships with Windows 10 1803+ and reads zip files
 *   2. pwsh     — PowerShell 7, Expand-Archive
 *   3. powershell — Windows PowerShell 5.1, Expand-Archive
 *
 * Usage:
 *   import { extractZip, extractTar } from './lib/extract.mjs';
 *   extractZip('/tmp/x.zip', '/tmp/out');
 *   extractTar('/tmp/x.tar.xz', '/tmp/out');
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';

/** True when the given executable can be started at all. */
function hasCommand(cmd) {
  const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !probe.error;
}

/**
 * Extract a tar archive (tar, tar.gz, tar.xz) into `dest`.
 *
 * bsdtar reads every one of those, and it is present on macOS, on Linux and
 * on Windows 10 1803+ — so this is the one method that works everywhere.
 */
export function extractTar(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', dest], { stdio: 'inherit' });
}

/**
 * Extract `zip` into `dest`.
 *
 * The archive's internal directory structure is preserved, so callers should
 * locate the files they want with a recursive search rather than assuming
 * they land flat in `dest`.
 */
export function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });

  if (!isWin) {
    // No -j here: the archive's directory structure is kept, so the
    // extraction matches what tar produces on Windows and the caller can
    // locate the binaries the same way on both platforms.
    execFileSync('unzip', ['-o', zip, '-d', dest], { stdio: 'inherit' });
    return;
  }

  // PowerShell's Expand-Archive takes the paths as parameters; passing them
  // through the environment avoids every quoting problem (a path with a
  // single quote in it would otherwise break the command string).
  const psScript = 'Expand-Archive -Force -LiteralPath $env:DW_ZIP -DestinationPath $env:DW_DEST';
  const strategies = [
    {
      name: 'tar',
      run: () => execFileSync('tar', ['-xf', zip, '-C', dest], { stdio: 'inherit' }),
    },
    {
      name: 'pwsh',
      run: () => execFileSync('pwsh', ['-NoProfile', '-Command', psScript], {
        stdio: 'inherit',
        env: { ...process.env, DW_ZIP: zip, DW_DEST: dest },
      }),
    },
    {
      name: 'powershell',
      run: () => execFileSync('powershell', ['-NoProfile', '-Command', psScript], {
        stdio: 'inherit',
        env: { ...process.env, DW_ZIP: zip, DW_DEST: dest },
      }),
    },
  ];

  const failures = [];
  for (const s of strategies) {
    if (!hasCommand(s.name)) continue;
    try {
      s.run();
      return;
    } catch (e) {
      failures.push(`${s.name}: ${e.message}`);
      // A partial extraction would poison the next attempt.
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
      fs.mkdirSync(dest, { recursive: true });
    }
  }
  throw new Error(
    `could not extract ${path.basename(zip)}: no working unzip method on this machine ` +
    `(${failures.join('; ') || 'tar, pwsh and powershell are all unavailable'})`,
  );
}
