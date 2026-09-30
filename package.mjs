// Build a Claerbout app (README.md) with @electron/packager from its config,
// and install it or zip it.
//
//   node package.mjs --config app/knuth.json            # your own copy, into /Applications
//   node package.mjs --config app/knuth.json --install ~/K.app
//   node package.mjs --config app/knuth.json --zip out/ --arch arm64,x64
//                                                       # the deploy: download zips
//   node package.mjs --config app/knuth.json --web dist ...
//                                                       # the page from a site build
//   node package.mjs --config app/knuth.json --install-script public/install
//                                                       # render the install line only
//
// The app leaves Electron's framework out (286 of its 288 MB), so a zip is
// a few megabytes, one per processor. Whoever gets it completes it with
// complete.sh, which clones the framework from an installed Claerbout app
// on the same Electron version or downloads Electron's release: the
// install line before moving it into place, or the app itself on its first
// launch (launcher.swift), when it came from a page's download button.
// Needs swiftc (Apple's command-line tools). An installed copy from here
// is complete.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  return value && !value.startsWith('--') ? value : true;
}

function fail(message) {
  console.error(`package.mjs: ${message}`);
  process.exit(1);
}

const configPath = option('config', null);
if (typeof configPath !== 'string') fail('--config <app.json> names the app to build');
const configDir = path.dirname(path.resolve(configPath));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
for (const key of ['name', 'id', 'envPrefix', 'scheme', 'icon']) {
  if (!config[key]) fail(`the config needs "${key}"`);
}
if (!config.package && !config.web) fail('the config needs "package" (a Python package holding the page) or "web" (the page)');

// The app's version: the environment's, else the package.json beside the
// config or in its parent (an app repository's own).
const version =
  process.env.APP_VERSION ||
  [configDir, path.dirname(configDir)]
    .map((dir) => path.join(dir, 'package.json'))
    .filter(existsSync)
    .map((file) => JSON.parse(readFileSync(file, 'utf8')).version)
    .find(Boolean) ||
  '0.0.0';

// MARK: - The install line, rendered from its template

const installScriptTo = option('install-script', null);
if (installScriptTo) {
  if (typeof installScriptTo !== 'string') fail('--install-script <file> names where to write it');
  if (!config.site) fail('the config needs "site" (the URL the install line downloads from)');
  const elsewhere = config.elsewhere ? ` ${config.elsewhere}` : '';
  const rendered = readFileSync(path.join(here, 'install.template'), 'utf8')
    .replaceAll('@NAME@', config.name)
    .replaceAll('@PREFIX@', config.envPrefix)
    .replaceAll('@SITE@', config.site)
    .replaceAll('@ELSEWHERE@', elsewhere);
  mkdirSync(path.dirname(path.resolve(installScriptTo)), { recursive: true });
  writeFileSync(installScriptTo, rendered, { mode: 0o755 });
  console.log(`wrote ${installScriptTo}`);
  if (!option('zip', null) && !option('install', null)) process.exit(0);
}

// MARK: - What to build, and where

// The page: a site build named with --web, else the config's `web` folder
// (relative to the config), else the package's own web/ folder.
const devPython = path.resolve(configDir, config.devPython ?? '.');
const packageDir = config.package ? path.join(devPython, config.package) : null;
const web = path.resolve(
  configDir,
  option('web', null) ?? config.web ?? (packageDir ? path.join(packageDir, 'web') : ''),
);
if (!existsSync(path.join(web, 'index.html'))) fail(`no page at ${web}`);
// Top-level entries of the site that are not part of the page (the
// install line and the app download live beside it).
const webExclude = Array.isArray(config.webExclude) ? config.webExclude : ['install', 'app'];

const archs = String(option('arch', process.arch)).split(',');
const zipTo = option('zip', null);
let installTo = option('install', null);
if (!zipTo && !installTo) installTo = true;
if (installTo === true) {
  installTo = existsSync('/Applications') && isWritable('/Applications')
    ? `/Applications/${config.name}.app`
    : path.join(os.homedir(), 'Applications', `${config.name}.app`);
}
if (installTo && !installTo.endsWith('.app')) fail(`the install target must end in .app (got ${installTo})`);
if (installTo && archs.length !== 1) fail('install one architecture at a time');

function isWritable(dir) {
  try {
    execFileSync('test', ['-w', dir]);
    return true;
  } catch {
    return false;
  }
}

const build = path.join(configDir, 'build');
const stage = path.join(build, 'stage');
rmSync(stage, { recursive: true, force: true });

// The shell, with the app's config beside it as app.json.
const appDir = path.join(stage, 'app');
mkdirSync(appDir, { recursive: true });
for (const file of ['main.js', 'preload.js']) cpSync(path.join(here, file), path.join(appDir, file));
cpSync(configPath, path.join(appDir, 'app.json'));
writeFileSync(
  path.join(appDir, 'package.json'),
  JSON.stringify({ name: config.package ?? config.name.toLowerCase(), productName: config.name, version, main: 'main.js' }, null, 2),
);

// The bundle's resources: a Python package (the engine's code, with the
// page inside it), or just the page. No Python does — the first launch
// installs one (uv) or the page runs without (Pyodide, or nothing).
const extraResource = [];
const notCompiled = (source) => !/(__pycache__|\.pyc$)/.test(source);
const notExcluded = (root) => (source) => !webExclude.includes(path.relative(root, source).split(path.sep)[0]);
if (packageDir) {
  const python = path.join(stage, 'python');
  const packageWeb = path.join(packageDir, 'web');
  cpSync(packageDir, path.join(python, config.package), {
    recursive: true,
    filter: (source) => notCompiled(source) && source !== packageWeb && !source.startsWith(packageWeb + path.sep),
  });
  cpSync(web, path.join(python, config.package, 'web'), { recursive: true, filter: notExcluded(web) });
  extraResource.push(python);
} else {
  const pageDir = path.join(stage, 'web');
  cpSync(web, pageDir, { recursive: true, filter: notExcluded(web) });
  extraResource.push(pageDir);
}

// The app icon, from a PNG (512 px or larger).
const iconSource = path.resolve(configDir, config.icon);
const iconset = path.join(stage, 'AppIcon.iconset');
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  execFileSync('sips', ['-z', `${size}`, `${size}`, iconSource, '--out', path.join(iconset, `icon_${size}x${size}.png`)]);
  if (size * 2 <= 512) {
    execFileSync('sips', ['-z', `${size * 2}`, `${size * 2}`, iconSource, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
}
execFileSync('sips', ['-z', '1024', '1024', iconSource, '--out', path.join(iconset, 'icon_512x512@2x.png')]);
const icon = path.join(stage, 'AppIcon.icns');
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icon]);

// Document types as the config declares them; an app is an alternate
// handler unless its config says otherwise, so installing never takes a
// type from the user's editor.
const documentTypes = (config.documentTypes ?? []).map((type) => ({
  CFBundleTypeName: type.name,
  CFBundleTypeRole: type.role ?? 'Editor',
  LSHandlerRank: type.rank ?? 'Alternate',
  ...(type.contentTypes ? { LSItemContentTypes: type.contentTypes } : { CFBundleTypeExtensions: type.extensions }),
}));

// The command-line tools can ship an SDK newer than their own compiler,
// which swiftc refuses: take the newest SDK it accepts, else the default
// one (Xcode's, on the deploy's Mac).
let chosenSDK = null;
function sdk() {
  if (chosenSDK) return chosenSDK;
  const tools = '/Library/Developer/CommandLineTools/SDKs';
  const probe = path.join(build, 'probe.swift');
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

const frameworkName = 'Electron Framework.framework';
for (const arch of archs) {
  const [bundleDir] = await packager({
    dir: appDir,
    out: path.join(build, 'out'),
    overwrite: true,
    platform: 'darwin',
    arch,
    electronVersion,
    name: config.name,
    appBundleId: config.id,
    appVersion: version,
    buildVersion: version,
    appCopyright: config.copyright ?? '',
    icon,
    // No asar: packager writes an asar's integrity digest into Electron's
    // framework binary (Electron 41+) and re-signs it, and a framework
    // changed per app cannot be cloned from a sibling. The same goes for
    // fuses, which are also bits in that binary: none are flipped.
    asar: false,
    extraResource,
    extendInfo: {
      CFBundleDocumentTypes: documentTypes,
      // What the install line reads to find a sibling to clone from.
      ClaerboutElectronVersion: electronVersion,
    },
    quiet: true,
  });
  const bundle = path.join(bundleDir, `${config.name}.app`);
  // The framework's exact bytes, which a sibling's must match to be cloned
  // and Electron's release must match when downloaded.
  const frameworkBinary = path.join(bundle, 'Contents', 'Frameworks', frameworkName, 'Versions', 'A', 'Electron Framework');
  const frameworkHash = createHash('sha256').update(readFileSync(frameworkBinary)).digest('hex');
  execFileSync('/usr/libexec/PlistBuddy', [
    '-c',
    `Add :ClaerboutFrameworkSHA256 string ${frameworkHash}`,
    path.join(bundle, 'Contents', 'Info.plist'),
  ]);
  // The app ships without the framework: take it out, and put the
  // launcher in front of Electron's own executable. A launch that finds no
  // framework completes the app first (launcher.swift).
  const contents = path.join(bundle, 'Contents');
  const frameworkDir = path.join(contents, 'Frameworks', frameworkName);
  const framework = path.join(build, `framework-${arch}`, frameworkName);
  rmSync(path.dirname(framework), { recursive: true, force: true });
  mkdirSync(path.dirname(framework), { recursive: true });
  renameSync(frameworkDir, framework);
  renameSync(path.join(contents, 'MacOS', config.name), path.join(contents, 'MacOS', `${config.name} Electron`));
  execFileSync('swiftc', [
    '-O',
    '-swift-version', '5',
    '-sdk', sdk(),
    '-target', `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
    '-o', path.join(contents, 'MacOS', config.name),
    path.join(here, 'launcher.swift'),
  ]);
  cpSync(path.join(here, 'complete.sh'), path.join(contents, 'Resources', 'complete.sh'));
  // Ad-hoc signatures for what the packager renamed (the helper apps) and
  // the outer bundle, as it ships: without the framework, which keeps
  // Electron's own signature wherever it comes from. Only on Apple
  // silicon, which refuses unsigned code: Electron's x64 release ships
  // unsigned, and an Intel Mac runs it so.
  if (arch === 'arm64') {
    const frameworks = path.join(contents, 'Frameworks');
    // Electron's three small frameworks (Mantle, ReactiveObjC, Squirrel)
    // ship with signatures that fail a deep check, which a browser
    // download's Gatekeeper makes: it calls the app "damaged", with no
    // Open Anyway. They are never shared, so they are signed afresh too.
    for (const entry of readdirSync(frameworks).filter((name) => name.endsWith('.app') || name.endsWith('.framework'))) {
      execFileSync('codesign', ['--force', '--sign', '-', path.join(frameworks, entry)]);
    }
    execFileSync('codesign', ['--force', '--sign', '-', bundle]);
    // Deep, as Gatekeeper checks a download.
    execFileSync('codesign', ['--verify', '--deep', '--strict', bundle]);
  }
  console.log(`built ${bundle} (Electron ${electronVersion}, ${arch}, without its framework)`);

  if (zipTo) {
    mkdirSync(zipTo, { recursive: true });
    const zip = path.resolve(zipTo, `${config.name}-${arch}.zip`);
    rmSync(zip, { force: true });
    execFileSync('ditto', ['-c', '-k', '--keepParent', bundle, zip]);
    console.log(`zipped ${zip}`);
    // A page's download button: the same app under the plain name, for
    // Apple silicon (Intel Macs use the install line).
    if (arch === 'arm64') {
      const download = path.resolve(zipTo, `${config.name}.app.zip`);
      cpSync(zip, download);
      console.log(`zipped ${download} (the page's download)`);
    }
  }

  if (installTo) {
    // Replacing the bundle of a running app pulls it out from under the
    // windows it opens next.
    let running = false;
    try {
      // macOS may report a path under /private without that prefix.
      const plain = installTo.replace(/^\/private/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      execFileSync('pgrep', ['-f', `^(/private)?${plain}/Contents/MacOS/`], { stdio: 'ignore' });
      running = true;
    } catch {
      // pgrep exits 1 when nothing matches.
    }
    if (running) fail(`${config.name} is open (${installTo}); quit it, then install again`);
    // Replaced wholesale, through a sibling path so a failed copy never
    // leaves no app at all. The framework goes in as a clone of the one
    // this build set aside, as the install line would put it.
    const incoming = `${installTo}.incoming`;
    rmSync(incoming, { recursive: true, force: true });
    mkdirSync(path.dirname(installTo), { recursive: true });
    execFileSync('ditto', [bundle, incoming]);
    execFileSync('cp', ['-Rc', framework, path.join(incoming, 'Contents', 'Frameworks', frameworkName)]);
    rmSync(installTo, { recursive: true, force: true });
    renameSync(incoming, installTo);
    console.log(`installed ${installTo}`);
  }
}
