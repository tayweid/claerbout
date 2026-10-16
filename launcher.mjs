// Compiling launcher.swift, the bundle's executable: for package.mjs, per
// processor, and for test/default-for.test.mjs, which runs its
// --claerbout-default-for in a bundle of its own.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// The command-line tools can ship an SDK newer than their own compiler,
// which swiftc refuses: take the newest SDK it accepts, else the default
// one (Xcode's, on the deploy's Mac).
let chosenSDK = null;
function sdk(scratch) {
  if (chosenSDK) return chosenSDK;
  const tools = '/Library/Developer/CommandLineTools/SDKs';
  mkdirSync(scratch, { recursive: true });
  const probe = path.join(scratch, 'probe.swift');
  writeFileSync(probe, 'import Foundation\n');
  const candidates = existsSync(tools)
    ? readdirSync(tools)
        .filter((entry) => /^MacOSX\d+\.\d+\.sdk$/.test(entry))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((entry) => path.join(tools, entry))
    : [];
  for (const candidate of candidates) {
    try {
      execFileSync('swiftc', ['-sdk', candidate, '-swift-version', '5', '-typecheck', probe], { stdio: 'ignore' });
      chosenSDK = candidate;
      break;
    } catch {
      // Too new for this compiler.
    }
  }
  chosenSDK ??= execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
  return chosenSDK;
}

/** launcher.swift, compiled for `arch` ('arm64' or 'x64') to `out`;
 *  `scratch` is a folder for the SDK probe. */
export function compileLauncher({ arch, out, scratch }) {
  execFileSync('swiftc', [
    '-O',
    '-swift-version', '5',
    '-sdk', sdk(scratch),
    '-target', `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
    '-o', out,
    path.join(here, 'launcher.swift'),
  ]);
}
