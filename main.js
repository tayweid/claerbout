// The Claerbout shell: a native window around an app's page, with a Python
// of its own (APP.md, "Electron, one shell for Claerbout").
//
// Generic across the suite; everything particular to one app is in its
// config (app/knuth.json for Knuth), which the build copies in beside this
// file as app.json. The shell owns a window per document, the native
// open/save dialogs, the first-launch choice of Python and its setup, and
// the engine process's lifetime. Everything else is the served page.
//
// The app never uses a Python that happens to be on the machine. The first
// launch asks, inside the window, which of two it should run:
//
// - uv: the app finds uv (or downloads it), uv installs its own Python,
//   and the engine (the app's package, carried in the bundle) runs on it.
// - On the web: Pyodide runs the cells inside the window. Nothing is
//   installed; the shell serves the page and does the file I/O itself.
//
// Neither ships in the download, which is why the download is small.

'use strict';

const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, net, protocol, screen, session, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const netSocket = require('node:net');

// MARK: - The app's config

const configPath = process.env.CLAERBOUT_APP
  ? path.resolve(process.env.CLAERBOUT_APP)
  : path.join(__dirname, 'app.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const NAME = config.name;
const PREFIX = config.envPrefix;
const env = (key) => process.env[`${PREFIX}_${key}`] || '';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const home = os.homedir();

// What the app remembers lives in one folder, which is also the engine's
// own preference store; the engine's Python lives with uv's tools (below). <PREFIX>_CONFIG_DIR, _PORT,
// _UV, _UV_ARCHIVE and _CHOOSE are for development; a Finder launch has
// none of them.
const stateDir = env('CONFIG_DIR') || path.join(app.getPath('appData'), NAME);
const preferencesPath = path.join(stateDir, 'preferences.json');
const logPath = isMac
  ? path.join(home, 'Library', 'Logs', `${NAME}.log`)
  : path.join(stateDir, `${NAME}.log`);
// Chromium's own storage (caches, the page's localStorage) stays inside
// the app's folder, apart from what the engine keeps there, so a test
// config folder is a clean slate for the page too.
app.setPath('userData', path.join(stateDir, 'Chromium'));
app.setName(NAME);

const exe = isWindows ? '.exe' : '';
/** Where uv's own installer puts uv, and where the app puts it when the
 *  machine has none: then it is an ordinary uv, usable from a terminal. */
const standardUV = path.join(home, '.local', 'bin', `uv${exe}`);
/** uv's data directory, as uv computes it: %APPDATA%\uv on Windows, else
 *  $XDG_DATA_HOME/uv with ~/.local/share as the default. Its python/ and
 *  tools/ are uv's own; claerbout/ beside them is the suite's. Computed
 *  rather than asked of uv, which may not be installed yet. */
const uvDataDir = isWindows
  ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'uv')
  : path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'uv');
/** The engine's environment lives with uv's other Pythons, named by the
 *  app's package, so uv owns every Python on the machine and the app's
 *  own folder holds only its state (Taylor, 2026-09-30). Not in uv's
 *  tools/ folder: `uv tool list` calls an environment without a receipt
 *  malformed and offers to uninstall it. It is made with `uv venv` and
 *  filled with `uv pip install`, since the package comes from the bundle
 *  on PYTHONPATH, not from an index. CLAERBOUT_UV_DIR overrides, for a
 *  test's throwaway folder. */
const engineDir = path.join(process.env.CLAERBOUT_UV_DIR || path.join(uvDataDir, 'claerbout'), config.package || NAME.toLowerCase());
const enginePython = isWindows
  ? path.join(engineDir, 'Scripts', 'python.exe')
  : path.join(engineDir, 'bin', 'python');
// The app's engine keeps to its own port, apart from one someone runs in
// a terminal: two engines, two Pythons, never confused.
const preferredPort = Number(env('PORT')) || config.port || 0;
// The Pythons this app offers, in the order the setup page lists them:
// "uv" (the engine, on a Python uv installs) and "browser" (the page from
// the bundle, its Python in the tab, or none at all). With one, there is
// no choice to make: the first launch just starts it. Knuth offers both;
// Plass has no Python and lists only "browser".
const pythons = Array.isArray(config.pythons) && config.pythons.length > 0 ? config.pythons : ['uv', 'browser'];
const offers = (python) => pythons.includes(python);
// The app's package, carried in the bundle: the engine's code and, inside
// it, the page. The app and its engine are therefore always one version.
// Unpackaged (development), the checkout's own.
const bundledPython = app.isPackaged
  ? path.join(process.resourcesPath, 'python')
  : path.resolve(path.dirname(configPath), config.devPython ?? '.');
// The page: inside the package by default; an app with no package (Plass)
// names its page folder as `web` in its config, relative to the config
// unpackaged and `Resources/web` in the bundle.
const webRoot = config.web
  ? app.isPackaged
    ? path.join(process.resourcesPath, 'web')
    : path.resolve(path.dirname(configPath), config.web)
  : path.join(bundledPython, config.package, 'web');
const scheme = config.scheme;
const appOrigin = `${scheme}://app`;

// MARK: - Small helpers

function log(line) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${NAME}.app: ${line}\n`);
  } catch {
    // A log that cannot be written must never stop the app.
  }
}

function lastLines(text, count = 6) {
  return text.split('\n').filter(Boolean).slice(-count).join('\n');
}

/** Run a command to completion: {status, output}. A timeout kills it and
 *  reports -1, so a hung process never hangs the app. */
function run(file, args, { timeout = 30_000, env: childEnv } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, env: childEnv, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`;
      if (!error) resolve({ status: 0, output });
      else resolve({ status: typeof error.code === 'number' ? error.code : -1, output: output || String(error) });
    });
  });
}

// MARK: - Updating the app

/** The app updating itself from its site (update.js): a check on request
 *  and quietly after launch; an install the page or the menu starts. */
const updater = require('./update.js')({ app, net, config, env, log });
/** The last check that found a new build, told to every window opened
 *  since, so a page can show its update button. */
let latestKnown = null;
/** An update installed whose relaunch was stopped (a window kept its
 *  unsaved work at the sheet): the install's answer, {state: 'ready',
 *  latest, current}. The new bundle is in
 *  place and runs from the next launch; until then the next install, from
 *  a page or the menu, relaunches into it instead of installing again. */
let installedPending = null;

// MARK: - The autosave record

/** The git record of every project a window is on (autosave.js; Knuth's
 *  docs/AUTOSAVE.md), when the config asks for it: the shell is the git
 *  runner, since it knows each window's document; a page only says when
 *  something happened. Off, this is an object that does nothing. */
const autosave = require('./autosave.js').attach({ config, env, log, stateDir });

// MARK: - Closing unsaved work

/** What closing a window, quitting or relaunching would lose, as each page
 *  last said (`unsaved`), and what the shell does about it (close-guard.js:
 *  the decisions; askToClose and closeIO below: the sheet and the saves). */
const guard = new (require('./close-guard.js').Guard)({ log });

function broadcast(name, detail) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('claerbout:event', name, detail);
  }
}

function readPreferences() {
  try {
    return JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
  } catch {
    return {};
  }
}

function writePreference(key, value) {
  const merged = { ...readPreferences(), [key]: value };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(preferencesPath, JSON.stringify(merged));
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The uv on this machine, wherever it came from: uv is uv. An app opened
 *  from Finder gets a bare PATH, so the usual places are asked directly. */
function findUV() {
  const candidates = [
    env('UV'),
    standardUV,
    ...(isWindows ? [] : ['/opt/homebrew/bin/uv', '/usr/local/bin/uv']),
    path.join(home, '.cargo', 'bin', `uv${exe}`),
    ...(process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, `uv${exe}`)),
  ];
  return candidates.find((candidate) => candidate && isExecutable(candidate)) ?? null;
}

/** What uv is told, always: use only Pythons it manages itself, so nothing
 *  on the machine (Anaconda, Homebrew, python.org) is touched or relied on. */
function uvEnvironment() {
  return { ...process.env, UV_PYTHON_PREFERENCE: 'only-managed', UV_NO_PROGRESS: '1' };
}

class SetupError extends Error {}

// MARK: - Setting up the Python

/** uv, then a Python, then what the engine needs. Each step is skipped
 *  when its result is already in place, so a second run — or a run after
 *  an interrupted first — picks up where things stand. */
/** What the engine needs installed beside the bundled package: the
 *  config's `requirements` list, and the lines of `requirementsFile` (an
 *  exact export of the app's lockfile, say), which the build copies in
 *  beside the config. The stamp of what was installed is kept in the
 *  environment, so an app update that changes the list installs again;
 *  uv takes a second when nothing is missing. */
function requirementsFile() {
  if (!config.engine?.requirementsFile) return null;
  return app.isPackaged
    ? path.join(__dirname, 'requirements.txt')
    : path.resolve(path.dirname(configPath), config.engine.requirementsFile);
}

function requirementsSpec() {
  const listed = Array.isArray(config.engine?.requirements) ? config.engine.requirements : [];
  const file = requirementsFile();
  const fromFile = file ? fs.readFileSync(file, 'utf8') : '';
  return { listed, file, stamp: createHash('sha256').update(JSON.stringify(listed)).update(fromFile).digest('hex') };
}

const requirementsStamp = path.join(engineDir, 'claerbout-requirements.sha256');

const Installer = {
  get isInstalled() {
    if (findUV() === null || !isExecutable(enginePython)) return false;
    try {
      return fs.readFileSync(requirementsStamp, 'utf8').trim() === requirementsSpec().stamp;
    } catch {
      return false;
    }
  },

  async install(progress) {
    if (!findUV()) {
      progress('Downloading uv…');
      await fetchUV();
    }
    const uv = findUV();
    if (!uv) throw new SetupError('uv could not be found after installing it.');
    log(`using uv at ${uv}`);
    if (!isExecutable(enginePython)) {
      progress(`Installing Python ${config.engine.python}… (about a minute)`);
      const { status, output } = await run(uv, ['venv', '--python', config.engine.python, engineDir], {
        timeout: 900_000,
        env: uvEnvironment(),
      });
      log(`uv venv: exit ${status}\n${lastLines(output)}`);
      if (status !== 0) throw new SetupError(`Python could not be installed.\n${lastLines(output, 3)}`);
    }
    progress('Preparing the engine…');
    const spec = requirementsSpec();
    const { status, output } = await run(
      uv,
      ['pip', 'install', '--python', enginePython, ...(spec.file ? ['-r', spec.file] : []), ...spec.listed],
      { timeout: 600_000, env: uvEnvironment() },
    );
    log(`uv pip install: exit ${status}\n${lastLines(output)}`);
    if (status !== 0) throw new SetupError(`The engine could not be prepared.\n${lastLines(output, 3)}`);
    fs.writeFileSync(requirementsStamp, spec.stamp);
  },
};

/** The uv release for this machine, from Astral's GitHub releases, put
 *  where uv's own installer would put it. */
async function fetchUV() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const target = isWindows ? `${arch}-pc-windows-msvc.zip` : `${arch}-apple-darwin.tar.gz`;
  const source = env('UV_ARCHIVE') || `https://github.com/astral-sh/uv/releases/latest/download/uv-${target}`;
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), `${config.package}-uv-`));
  try {
    const archive = path.join(work, path.basename(target));
    if (path.isAbsolute(source)) {
      try {
        await fsp.copyFile(source, archive);
      } catch (error) {
        throw new SetupError(`Could not read ${source}: ${error.message}`);
      }
    } else {
      let response;
      try {
        response = await net.fetch(source, { signal: AbortSignal.timeout(600_000) });
      } catch (error) {
        log(`uv download failed: ${error.message}`);
        throw new SetupError(`uv could not be downloaded: ${error.message}. Check the network and try again.`);
      }
      if (!response.ok) {
        throw new SetupError(`uv could not be downloaded: the server answered ${response.status}.`);
      }
      await fsp.writeFile(archive, Buffer.from(await response.arrayBuffer()));
    }
    // bsdtar reads both archives, and ships with macOS and Windows 10+.
    const { status, output } = await run('tar', ['-xf', archive, '-C', work], { timeout: 120_000 });
    if (status !== 0) throw new SetupError(`uv could not be unpacked.\n${lastLines(output, 3)}`);
    const found = (await fsp.readdir(work, { recursive: true }))
      .map((entry) => path.join(work, entry))
      .find((entry) => path.basename(entry) === `uv${exe}`);
    if (!found) throw new SetupError('The uv download did not contain uv.');
    try {
      await fsp.mkdir(path.dirname(standardUV), { recursive: true });
      await fsp.copyFile(found, standardUV);
      await fsp.chmod(standardUV, 0o755);
    } catch (error) {
      throw new SetupError(`uv could not be put in place: ${error.message}`);
    }
    const version = await run(standardUV, ['--version']);
    log(`installed ${version.status === 0 ? version.output.trim() : 'uv (unverified)'} at ${standardUV}`);
    if (version.status !== 0) throw new SetupError('The downloaded uv does not run on this machine.');
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

// MARK: - The engine

function portIsFree(port) {
  return new Promise((resolve) => {
    const socket = netSocket.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The engine from this bundle, on the Python uv installed, as the app's
 *  own child: started at launch, stopped at quit, and told the app's pid
 *  so it stops by itself if the app is killed. */
const engine = {
  child: null,
  port: preferredPort,
  get origin() {
    return `http://127.0.0.1:${this.port}`;
  },
  get isRunning() {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  },

  async isUp() {
    try {
      const response = await net.fetch(`${this.origin}/`, {
        signal: AbortSignal.timeout(1500),
        cache: 'no-store',
      });
      return response.ok && (await response.text()).toLowerCase().includes(config.engine.probe);
    } catch {
      return false;
    }
  },

  async start() {
    if (this.isRunning) return;
    if (!fs.existsSync(path.join(bundledPython, config.package, config.engine.marker))) {
      throw new SetupError(`This build of ${NAME} does not carry the engine.`);
    }
    this.port = preferredPort;
    while (!(await portIsFree(this.port)) && this.port < preferredPort + 40) this.port += 1;

    const childEnv = {
      ...uvEnvironment(),
      PYTHONPATH: bundledPython,
      [`${PREFIX}_CONFIG_DIR`]: stateDir,
      PYTHONDONTWRITEBYTECODE: '1', // the bundle is not ours to write into
    };
    const uv = findUV();
    if (uv) childEnv[`${PREFIX}_UV`] = uv;
    const logFile = fs.openSync(logPath, 'a');
    const args = [...config.engine.args, '--port', String(this.port), '--parent', String(process.pid)];
    const child = spawn(enginePython, args, {
      cwd: home,
      env: childEnv,
      stdio: ['ignore', logFile, logFile],
      windowsHide: true,
    });
    fs.closeSync(logFile);
    let failure = null;
    child.once('error', (error) => {
      failure = error;
    });
    child.once('exit', (code, signal) => log(`engine exited with ${signal ?? `status ${code}`}`));
    this.child = child;
    log(`started engine on port ${this.port}: ${enginePython} ${args.join(' ')} (pid ${child.pid})`);
    const deadline = Date.now() + (Number(config.engine.startTimeout) || 25_000);
    while (Date.now() < deadline) {
      if (failure) throw new SetupError(`The engine could not be started: ${failure.message}`);
      if (await this.isUp()) return;
      if (!this.isRunning) {
        throw new SetupError(
          `The engine stopped as it started (status ${child.exitCode}). The log has the reason.`,
        );
      }
      await sleep(200);
    }
    throw new SetupError(`The engine did not answer within ${Math.round((Number(config.engine.startTimeout) || 25_000) / 1000)} seconds.`);
  },

  async stop() {
    const child = this.child;
    if (!child || !this.isRunning) return;
    log(`stopping engine (pid ${child.pid})`);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, sleep(5000)]);
    this.child = null;
  },
};

// MARK: - Serving the page from the bundle

const contentTypes = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  otf: 'font/otf',
  ttf: 'font/ttf',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
};

// Registered before `ready`: a standard, secure scheme, so the page has a
// real origin (not loopback, which is how it knows to run Python itself)
// and can fetch Pyodide from its CDN.
protocol.registerSchemesAsPrivileged([
  {
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  },
]);

/** The shell's own pages (the history view), in its own folder. */
const shellPages = path.join(__dirname, 'history');
const SHELL_PREFIX = '/_claerbout/';

/** <scheme>://app/<path> → the bundled page. What the engine serves over
 *  HTTP, for the mode with no engine. /_claerbout/ is the shell's own
 *  pages, from the history/ folder beside this file, checked before the
 *  app's page folder, so no app's page can shadow them or be reached
 *  through them. */
async function servePage(request) {
  const notFound = () => new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  let relative;
  try {
    relative = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return notFound();
  }
  if (!relative || relative === '/') relative = '/index.html';
  const own = relative.startsWith(SHELL_PREFIX);
  const root = path.resolve(own ? shellPages : webRoot);
  const file = path.resolve(root, `.${own ? relative.slice(SHELL_PREFIX.length - 1) : relative}`);
  if (!file.startsWith(root + path.sep)) return notFound();
  let data;
  try {
    data = await fsp.readFile(file);
  } catch {
    return notFound();
  }
  const type = contentTypes[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
  return new Response(data, {
    headers: { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
  });
}

// MARK: - Files on the page's behalf

/** The shell's answers to read/write/stat/rename/remove, shaped like the
 *  engine's files.py replies so the page's one file manager serves both. */
const FileOps = {
  maxDocumentBytes: 8 * 1024 * 1024,

  async modified(file) {
    try {
      return Math.trunc((await fsp.stat(file)).mtimeMs);
    } catch {
      return null;
    }
  },

  checked(value) {
    if (typeof value !== 'string' || !value) return { error: 'path must be a non-empty string' };
    if (!path.isAbsolute(value)) return { error: 'path must be absolute' };
    return null;
  },

  async read(file) {
    const problem = this.checked(file);
    if (problem) return problem;
    const name = path.basename(file);
    let info;
    try {
      info = await fsp.stat(file);
    } catch {
      return { error: `${name} does not exist` };
    }
    if (!info.isFile()) return { error: `${name} is not a file` };
    if (info.size > this.maxDocumentBytes) {
      return { error: `${name} is larger than ${this.maxDocumentBytes / (1024 * 1024)} MB` };
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await fsp.readFile(file));
    } catch (error) {
      return { error: error instanceof TypeError ? `${name} is not UTF-8 text` : `${name} could not be read` };
    }
    return { path: file, name, text, modified: await this.modified(file) };
  },

  async write(file, text) {
    const problem = this.checked(file);
    if (problem) return problem;
    if (typeof text !== 'string') return { error: 'text must be a string' };
    const name = path.basename(file);
    try {
      if ((await fsp.stat(file)).isDirectory()) return { error: `${name} is not a file` };
    } catch {
      // Not there yet: a new file.
    }
    // Staged beside the destination and renamed into place.
    const staged = path.join(path.dirname(file), `.${name}.${process.pid}.tmp`);
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(staged, text, 'utf8');
      await fsp.rename(staged, file);
    } catch (error) {
      await fsp.rm(staged, { force: true });
      return { error: `${name} could not be saved: ${error.message}` };
    }
    return { path: file, modified: await this.modified(file) };
  },

  async stat(file) {
    const problem = this.checked(file);
    if (problem) return problem;
    try {
      const info = await fsp.stat(file);
      return { path: file, modified: info.isFile() ? Math.trunc(info.mtimeMs) : null };
    } catch {
      return { path: file, modified: null };
    }
  },

  async rename(file, newName) {
    const problem = this.checked(file);
    if (problem) return problem;
    if (typeof newName !== 'string') return { error: 'name must be a string' };
    const name = newName.trim();
    if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
      return { error: 'name must be a file name, not a path' };
    }
    const target = path.join(path.dirname(file), name);
    if (!fs.existsSync(file)) return { error: `${path.basename(file)} does not exist` };
    if (target !== file && fs.existsSync(target)) return { error: `${name} already exists` };
    try {
      if (target !== file) await fsp.rename(file, target);
    } catch (error) {
      return { error: `could not rename: ${error.message}` };
    }
    return { path: target, name, modified: await this.modified(target) };
  },

  async remove(file) {
    const problem = this.checked(file);
    if (problem) return problem;
    let info;
    try {
      info = await fsp.stat(file);
    } catch {
      return {};
    }
    if (!info.isFile()) return { error: 'not a file' };
    try {
      await fsp.rm(file);
    } catch (error) {
      return { error: `could not delete: ${error.message}` };
    }
    return {};
  },
};

// MARK: - Document windows

/** window → the document it was opened with, for dialogs' start folder. */
const documents = new Map();
/** The files the pages' File System Access handles have lately touched:
 *  path → when. Chromium asks the permission check handler
 *  (grantPermissions) about every read and write of a handle, with the
 *  file's path but no webContents, which is the one way a page that keeps
 *  files by handle (Plass) can be followed by path: a File from a
 *  handle's getFile() is blob-backed and has no path for the preload's
 *  pathOf (both measured 2026-10-02; a dropped File has one). A page's
 *  `document` request names its file, with the File's size and mtime,
 *  and is matched here, newest first. */
const touched = new Map();
const TOUCHED_KEPT = 64;

function touch(file) {
  touched.delete(file);
  touched.set(file, Date.now());
  if (touched.size > TOUCHED_KEPT) touched.delete(touched.keys().next().value);
}

/** The touched file a page's report names: the newest whose name, size
 *  and mtime agree, else null. A report without the size and mtime, or
 *  one no touched file matches, names none, never a same-named file
 *  that happens to be newest (another window's Untitled.typ). */
function touchedFile({ name, size, modified }) {
  if (typeof size !== 'number' || typeof modified !== 'number') return null;
  for (const file of [...touched.keys()].reverse()) {
    if (path.basename(file) !== name) continue;
    try {
      const info = fs.statSync(file);
      if (info.isFile() && info.size === size && Math.abs(info.mtimeMs - modified) < 1) return file;
    } catch {
      // Gone since: not this one.
    }
  }
  return null;
}

/** A page's report of a path is taken only when it is an absolute path to
 *  an existing regular file: the shell starts a repository in its folder
 *  and writes there, so a page cannot point it anywhere else. A refusal
 *  is logged once per path. */
const refusedReports = new Set();
function reportedFile(file) {
  try {
    if (path.isAbsolute(file) && fs.statSync(file).isFile()) return file;
  } catch {
    // Not there: refused below.
  }
  if (!refusedReports.has(file)) {
    refusedReports.add(file);
    log(`document: refused ${JSON.stringify(file)}: not an absolute path to an existing file`);
  }
  return null;
}
/** nil until a Python is chosen and ready: documents wait in `pending`. */
let mode = null;
let pending = [];
let installing = false;

/** window → the origin the shell itself loaded into it. A window keeps
 *  trusting the page it opened with after the app switches Python: a
 *  window on the engine still gets its dialogs once new windows run in
 *  the tab. */
const origins = new Map();

/** Node's URL gives a custom scheme the opaque origin "null", so an origin
 *  is built from scheme and host. */
function originOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function load(window, url) {
  origins.set(window, originOf(url));
  void window.loadURL(url);
}

/** Only the app's own pages talk to the shell: a request is answered when
 *  it comes from the origin this window was given. */
function trusted(window, url) {
  const origin = originOf(url);
  return origin !== null && origin === origins.get(window);
}

function isOwnURL(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === `${scheme}:`) return true;
    return parsed.protocol.startsWith('http') && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function setDocument(window, file) {
  documents.set(window, file);
  if (isMac) window.setRepresentedFilename(file ?? '');
  void autosave.setDocument(window, file).then(syncPresence);
}

/** The window's title bar, from the config: the native one (`default`),
 *  or none (`hiddenInset`, `hidden`): the page reaches the top of the
 *  window and draws the bar itself, with the traffic lights over it —
 *  Zen's shape. The page marks its bar `-webkit-app-region: drag` (and
 *  its controls `no-drag`) so the window can still be moved by it, and
 *  learns where the lights are from the Window Controls Overlay
 *  (`navigator.windowControlsOverlay`, CSS `env(titlebar-area-*)`),
 *  which is published only when the title bar is not native, so a page
 *  that pads its bar by `env(titlebar-area-x, 0px)` is right under either
 *  bar and asks the shell nothing. `trafficLightPosition` ({x, y}, macOS)
 *  moves the lights; the overlay's height follows (2·y plus the lights,
 *  14 px on macOS 26 and 16 on macOS 15, so a page sets its bar from
 *  env(titlebar-area-height), never from the number). The
 *  setup page gets the same bar. */
/** macOS's rubber band at the end of a scroll, which Electron turns off
 *  unless asked (`webPreferences.scrollBounce`). On by default here: a
 *  paper or a column that stops dead at its edge feels cramped (Taylor,
 *  2026-10-02, of Plass's page), and every Mac scroller bounces. The
 *  config's `window.scrollBounce: false` turns it off. */
function scrollBounce() {
  return config.window?.scrollBounce !== false;
}

function titleBar() {
  const style = config.window.titleBarStyle;
  const titleBarStyle = ['hidden', 'hiddenInset'].includes(style) ? style : 'default';
  const position = config.window.trafficLightPosition;
  return {
    titleBarStyle,
    ...(titleBarStyle !== 'default' ? { titleBarOverlay: true } : {}),
    ...(isMac && position && Number.isFinite(position.x) && Number.isFinite(position.y)
      ? { trafficLightPosition: { x: position.x, y: position.y } }
      : {}),
  };
}

/** What every page of the app runs with: the document windows', the
 *  History window's and the inline History view's alike. */
function pagePreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: false,
    scrollBounce: scrollBounce(),
  };
}

function openWindow(url, document = null) {
  const last = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(-1);
  const size = readPreferences().windowSize;
  const window = new BrowserWindow({
    width: size?.[0] ?? config.window.width,
    height: size?.[1] ?? config.window.height,
    minWidth: config.window.minWidth,
    minHeight: config.window.minHeight,
    ...titleBar(),
    title: document ? path.basename(document) : NAME,
    show: false,
    webPreferences: pagePreferences(),
  });
  if (last) {
    const [x, y] = last.getPosition();
    window.setPosition(x + 22, y + 22);
  }
  setDocument(window, document);
  const contents = window.webContents;
  // window.open from the page ("New" opens a fresh session) becomes one of
  // our windows; links out of the page (the docs, GitHub) go to the default
  // browser. Only the app's own origins render here.
  contents.setWindowOpenHandler(({ url: target }) => {
    if (isOwnURL(target)) openWindow(target);
    else void shell.openExternal(target);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, target) => {
    if (!isOwnURL(target)) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });
  window.once('ready-to-show', () => window.show());
  contents.on('did-finish-load', () => {
    if (latestKnown) contents.send('claerbout:event', 'update', latestKnown);
  });
  // What the page said was unsaved goes with the page: a reloaded page
  // reports again, and a page that is gone can neither save nor answer.
  // Only a navigation that has happened takes the page away: one that
  // merely starts may never commit (a link out, which will-navigate above
  // hands to the browser; a mailto:; a download), and the page that
  // started it is still there, still unsaved, with no reason to report
  // again. `did-navigate` is a committed main-frame document; a failed one
  // commits an error page instead, said by `did-fail-load` (ERR_ABORTED,
  // -3, is a load stopped or a navigation cancelled: the page stays).
  const pageGone = () => {
    guard.forget(window);
    dropSaves(window);
  };
  contents.on('did-navigate', pageGone);
  contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) pageGone();
  });
  contents.on('render-process-gone', pageGone);
  window.on('close', (event) => {
    if (!window.isMaximized() && !window.isFullScreen()) writePreference('windowSize', window.getSize());
    // ⌘W, the red button, File › Close, and the quit's own closing: a
    // window whose page said closing would lose work is held and settled
    // (askToClose); once settled it closes for real.
    const decision = guard.onClose(window);
    if (decision === 'pass') return;
    event.preventDefault();
    if (decision === 'hold') void askToClose(window);
    // Its sheet is up, or its page is saving after Save (no time limit: a
    // picker may be open). A page must answer that save, cancelled picker
    // and errors included (README); one that never does keeps its window
    // until it reloads or goes, and this says where the close went.
    else log(`close: “${guard.reports.get(window)?.name ?? 'a window'}” is still being settled (its sheet, or a save the page has not answered); this close waits for it`);
  });
  window.on('closed', () => {
    documents.delete(window);
    origins.delete(window);
    pageGone();
    void autosave.closed(window).then(syncPresence);
  });
  load(window, url);
  return window;
}

/** Tell the setup page something: `progress` or `failed`, with a line. */
function setup(window, kind, text) {
  if (window && !window.isDestroyed()) window.webContents.send('claerbout:event', 'setup', { kind, text });
}

function pageURL(document) {
  const url = new URL(mode === 'browser' ? `${appOrigin}/` : `${engine.origin}/`);
  if (document) url.searchParams.set('open', document);
  return url.toString();
}

/** The choice, inside a window: the bundled setup page, which asks
 *  `choose` back and shows the progress the install reports. */
function showSetup(choosing) {
  const url = new URL(`${appOrigin}/${config.setupPage}`);
  if (choosing === 'uv' || choosing === 'browser') url.searchParams.set('choose', choosing);
  openWindow(url.toString());
}

async function choose(value, window) {
  if (!offers(value) || installing) return;
  log(`chosen: ${value} Python`);
  if (value === 'browser') {
    becomeReady('browser', window);
    return;
  }
  installing = true;
  try {
    await Installer.install((line) => {
      log(`setup: ${line}`);
      setup(window, 'progress', line);
    });
  } catch (error) {
    installing = false;
    log(`setup failed: ${error.message}`);
    setup(window, 'failed', error.message);
    return;
  }
  installing = false;
  setup(window, 'progress', 'Starting Python…');
  await startEngine(window);
}

async function startEngine(window) {
  try {
    await engine.start();
  } catch (error) {
    log(`engine failed: ${error.message}`);
    if (window) setup(window, 'failed', error.message);
    else await fail(error);
    return;
  }
  becomeReady('uv', window);
}

/** A Python is running: remember the choice, and open what was waiting —
 *  the first of it in the setup window, if that is where we are. */
function becomeReady(chosen, window) {
  if (chosen === 'browser' && !fs.existsSync(path.join(webRoot, 'index.html'))) {
    void fail(new SetupError(`This build of ${NAME} does not carry the page.`));
    return;
  }
  mode = chosen;
  writePreference('python', chosen);
  log(
    chosen === 'uv'
      ? `running the full Python (uv), engine on port ${engine.port}`
      : offers('uv')
        ? 'running Python on the web (Pyodide)'
        : 'running the page from the bundle',
  );
  const waiting = pending;
  pending = [];
  if (window && !window.isDestroyed()) {
    const first = waiting.shift() ?? null;
    setDocument(window, first);
    window.setTitle(first ? path.basename(first) : NAME);
    load(window, pageURL(first));
  }
  for (const file of waiting) openWindow(pageURL(file), file);
  // Launched with nothing to open (Dock, Finder): show the app. Files
  // arriving at launch land before this, so a short wait is enough.
  setTimeout(() => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow(pageURL(null));
  }, 300);
}

async function fail(error) {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: `${NAME} could not start Python`,
    detail: `${error.message}\n\nLog: ${logPath}`,
    buttons: [pythons.length > 1 ? 'Choose Python…' : 'Try Again', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) showSetup(pythons.length > 1 ? null : pythons[0]);
  else app.quit();
}

function openDocument(file) {
  if (mode) openWindow(pageURL(file), file);
  else pending.push(file);
}

// MARK: - Opening a document by drop

/** An app that keeps files by handle (Plass) cannot make one from a path:
 *  Chromium gives handles only to the page, through its pickers or a drop.
 *  So a document opened from Finder or the command line is dropped on the
 *  page — a real drag sequence through the devtools protocol, which the
 *  page's drop listener receives as a FileSystemFileHandle (a folder
 *  gives a directory handle the same way). Done once the page says it is
 *  listening (`ready`), beside the `?open=` path it was loaded with. Config
 *  `openBy: "drop"`; Knuth opens by path and never sees this. Verified by
 *  the Plass port, 2026-09-30, on Electron 44. */
async function dropDocument(window, file) {
  const debug = window.webContents.debugger;
  try {
    debug.attach('1.3');
  } catch (error) {
    log(`could not drop ${file}: ${error.message}`);
    return;
  }
  try {
    // Any point over the page: the page's listener is on the window.
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await debug.sendCommand('Input.dispatchDragEvent', { type, x: 300, y: 300, data });
    }
  } catch (error) {
    log(`could not drop ${file}: ${error.message}`);
  } finally {
    if (debug.isAttached()) debug.detach();
  }
}

// MARK: - The history view

/** The record as a path (history.js, history/history.html; Knuth's
 *  docs/mockups/history.md): the shell's own page, served at
 *  <scheme>://app/_claerbout/history.html, one copy for every app. It
 *  shows in the room of the document's own window, as a view laid over
 *  the room's box (`history {action: 'open', inline}`, the app's History
 *  tile; View › History…), or in a window of its own, one per project (a
 *  `history` request without `inline`; View › History… from a window that
 *  is not a document page). Its requests are answered by answerHistory,
 *  always for that view's or window's project: the page never names a
 *  folder, a document page cannot ask for a graph, and the history page
 *  cannot read or write files. */
const history = require('./history.js');
const appName = NAME.toLowerCase();
/** Where every Claerbout app says which documents it has open on which
 *  project, so a rewind can name another app's windows (history.js,
 *  presence). CLAERBOUT_PRESENCE_DIR is for a test's throwaway folder. */
const presence = history.presence(process.env.CLAERBOUT_PRESENCE_DIR || path.join(app.getPath('appData'), 'Claerbout', 'presence'));
/** History window → {key, root, reason, detail, document}: `document` the
 *  one of the window it was opened from (or brought forward from), which
 *  the page is scoped to. */
const historyWindows = new Map();
/** Document window → its inline History view: {view, contents, origin,
 *  host (that window), css (the room's last box, CSS px), hidden (put
 *  away, kept for the next open), attach and detach (the room's events),
 *  release (the window's), the target's root, reason, detail and document
 *  once known, and `known`: what its page last drew, {tip, refs, state,
 *  document}, which a hidden view is caught up from when it comes back. */
const historyViews = new Map();
/** The graphs kept between opens, and the ties, by project (history.js,
 *  Graphs). */
const graphs = new history.Graphs();
/** How long a document page has to answer `save` before a rewind goes on
 *  without it (the apps' pages do not answer yet), and before a close
 *  that asked for a quiet save shows the sheet. */
const SAVE_WAIT = 3000;
/** How long a close waits, after a page refused the quiet save, for a
 *  report it sent just after its answer (see closeIO). */
const REPORT_GRACE = 100;
/** Saves asked for (a rewind's, a close's): id → {window, resolve, drop}. */
const saves = new Map();

const tilde = (file) => (file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file);

/** This shell's document windows on a project. */
function openOn(root) {
  if (!autosave.enabled) return [];
  return [...autosave.windows].filter(([window, on]) => on === root && !window.isDestroyed()).map(([window]) => window);
}

/** The History pages on a project, as webContents: its History windows'
 *  and the inline views in its document windows. */
function viewersOf(root) {
  return pagesOn(root).map(({ contents }) => contents);
}

/** The History pages on a project, each with its entry: [{contents,
 *  entry}]. A hidden inline view is not among them: it hears nothing and
 *  costs the two-second look nothing, and is caught up when it comes back
 *  (catchUp). */
function pagesOn(root) {
  return [
    ...[...historyWindows].filter(([window, entry]) => entry.root === root && !window.isDestroyed()).map(([window, entry]) => ({ contents: window.webContents, entry })),
    ...[...historyViews.values()].filter((entry) => entry.root === root && !entry.hidden && !entry.contents.isDestroyed()).map((entry) => ({ contents: entry.contents, entry })),
  ];
}

/** The document a History page is scoped to, as a path in its project
 *  ('/'-separated), or null: the document its window has now, inline (a
 *  Save As moves it), else the one it was opened from. */
function scopeDocument(entry) {
  if (!entry?.root) return null;
  const host = entry.host && !entry.host.isDestroyed() ? entry.host : null;
  const file = (host ? documents.get(host) : null) ?? entry.document ?? null;
  return file ? history.relativeTo(entry.root, file) : null;
}

/** Another app's documents on a project, as the History page compares
 *  them: each one's path in the project (history.js, pagePaths). */
function pageOthers(root) {
  return presence.others(root, appName).map((other) => ({ ...other, documents: history.pagePaths(root, other.documents) }));
}

/** An event to each of some windows or webContents (a view's). */
function tell(targets, name, detail) {
  for (const target of targets) {
    const contents = target.webContents ?? target;
    if (!target.isDestroyed() && !contents.isDestroyed()) contents.send('claerbout:event', name, detail);
  }
}

/** The project a document window is on, or why it has none: 'unsaved'
 *  (no document path), 'refused' (a folder the record refuses, with the
 *  rule in `detail`), 'off' (the config or <PREFIX>_AUTOSAVE=0), 'no-git'. */
async function historyTarget(window) {
  const file = documents.get(window) ?? null;
  if (!autosave.enabled) return { root: null, reason: autosave.reason ?? 'off', document: file };
  const root = await autosave.rootOf(window);
  if (root) return { root, document: file };
  if (!file) return { root: null, reason: 'unsaved', document: null };
  return { root: null, reason: 'refused', detail: autosave.why(path.dirname(file)), document: file };
}

/** The History window for a document window's project, made or brought
 *  forward (with `history {kind: 'focus', at}` when it was open). It is
 *  never given a document, so the record opens no session for it. */
async function openHistory(source, at = null) {
  const wanted = typeof at === 'string' && /^[0-9a-f]{4,64}$/.test(at) ? at : null;
  const front = (window) => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (wanted) window.webContents.send('claerbout:event', 'history', { kind: 'focus', at: wanted });
    return window;
  };
  if (source && historyWindows.has(source)) return front(source);
  const target = source && !source.isDestroyed() ? await historyTarget(source) : { root: null, reason: 'unsaved', document: null };
  const key = target.root ?? `none ${target.reason} ${target.document ?? ''}`;
  for (const [window, entry] of historyWindows) {
    if (entry.key !== key || window.isDestroyed()) continue;
    // Brought forward from another document's window: scoped to that one now.
    if (target.root && target.document && target.document !== entry.document) {
      entry.document = target.document;
      window.webContents.send('claerbout:event', 'history', { kind: 'document' });
    }
    return front(window);
  }
  const size = readPreferences().historySize;
  const window = new BrowserWindow({
    width: size?.[0] ?? 1100,
    height: size?.[1] ?? 760,
    minWidth: 560,
    minHeight: 420,
    backgroundColor: '#18181a',
    // The page draws its own bar, in the suite's frame, with the lights in it.
    ...(isMac ? { titleBarStyle: 'hiddenInset', titleBarOverlay: true, trafficLightPosition: { x: 16, y: 15 } } : {}),
    title: target.root ? `History — ${path.basename(target.root)}` : 'History',
    show: false,
    webPreferences: pagePreferences(),
  });
  if (source && !source.isDestroyed()) {
    const [x, y] = source.getPosition();
    window.setPosition(x + 22, y + 22);
  }
  historyWindows.set(window, { ...target, key });
  const contents = window.webContents;
  // The page goes nowhere: links out open in the default browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  window.once('ready-to-show', () => window.show());
  // "History — week-3", not the page's <title>: with two projects open,
  // the Window menu and Mission Control tell them apart.
  window.on('page-title-updated', (event) => event.preventDefault());
  window.on('close', () => {
    if (!window.isMaximized() && !window.isFullScreen()) writePreference('historySize', window.getSize());
  });
  window.on('closed', () => {
    historyWindows.delete(window);
    origins.delete(window);
  });
  const url = new URL(`${appOrigin}${SHELL_PREFIX}history.html`);
  if (wanted) url.searchParams.set('at', wanted);
  load(window, url.toString());
  log(`history: opened for ${target.root ?? `no record (${target.reason})`}`);
  return window;
}

/** A document page that has a room for the History view: one of the
 *  app's document windows, not the setup page or a History window. */
function isDocumentPage(window) {
  if (!window || window.isDestroyed() || !documents.has(window) || historyWindows.has(window)) return false;
  try {
    return new URL(window.webContents.getURL()).pathname !== `/${config.setupPage}`;
  } catch {
    return false;
  }
}

/** The room's box a page sends, {x, y, width, height} in its CSS px, or
 *  null when it is not one. */
function roomBox(box) {
  if (!box || typeof box !== 'object') return null;
  const { x, y, width, height } = box;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** The view over the room: the page's CSS px times its zoom, in DIP. A
 *  resize of the window moves nothing by itself; the page's `bounds`
 *  does, from its ResizeObserver on the room. */
function placeInline(host, entry, css) {
  entry.css = css;
  const zoom = host.webContents.getZoomFactor() || 1;
  entry.view.setBounds({
    x: Math.round(css.x * zoom),
    y: Math.round(css.y * zoom),
    width: Math.round(css.width * zoom),
    height: Math.round(css.height * zoom),
  });
}

/** `history {action: 'open', inline}` from a document page: the History
 *  page laid over the room of the same window as a WebContentsView, for
 *  the window's project, with the document still loaded underneath (a
 *  rewind's save and reload reach it there). Transparent, so the page
 *  draws its own rounded panel and the frame shows at its corners. A
 *  second open while it is up changes nothing (`at` still selects). The
 *  view is made once per window: put away, it is hidden and kept, and the
 *  next open shows it again (showInline), so only the first open of a
 *  window pays for a page and its renderer. It goes with its window. */
async function openInline(host, css, at = null) {
  const wanted = typeof at === 'string' && /^[0-9a-f]{4,64}$/.test(at) ? at : null;
  const up = historyViews.get(host);
  if (up && !up.hidden) {
    if (wanted && !up.contents.isDestroyed()) up.contents.send('claerbout:event', 'history', { kind: 'focus', at: wanted });
    return { opened: true, inline: true };
  }
  if (up) return showInline(host, up, css, wanted);
  const view = new WebContentsView({ webPreferences: pagePreferences() });
  view.setBackgroundColor('#00000000');
  const contents = view.webContents;
  const entry = { view, contents, origin: appOrigin, host, css, hidden: false, root: null, reason: null, detail: null, document: null, known: null, attach: () => {}, detach: () => {}, release: () => {} };
  historyViews.set(host, entry);
  // The page goes nowhere: links out open in the default browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  // Each listener acts on this view only, never one opened since. Its own
  // page gone, or its window, it goes for good.
  const gone = () => destroyInline(host, entry);
  contents.on('render-process-gone', gone);
  contents.once('destroyed', gone);
  host.once('closed', gone);
  entry.release = () => host.removeListener('closed', gone);
  // Focused once drawn, so Escape reaches it.
  contents.once('did-finish-load', () => {
    if (historyViews.get(host) === entry && !entry.hidden && !contents.isDestroyed()) contents.focus();
  });
  // The room's events, while the view is up: when the window's page goes
  // (a reload, another page) the room it was measured from is no longer
  // there, and the view is put away.
  const hostContents = host.webContents;
  const away = () => closeInline(host, entry);
  const onNavigation = (details, ...rest) => {
    const mainFrame = details?.isMainFrame ?? rest[2];
    const sameDocument = details?.isSameDocument ?? rest[1];
    if (mainFrame && !sameDocument) away();
  };
  entry.attach = () => {
    hostContents.on('did-start-navigation', onNavigation);
    hostContents.on('render-process-gone', away);
  };
  entry.detach = () => {
    if (!hostContents.isDestroyed()) {
      hostContents.removeListener('did-start-navigation', onNavigation);
      hostContents.removeListener('render-process-gone', away);
    }
  };
  entry.attach();
  host.contentView.addChildView(view);
  placeInline(host, entry, css);
  tell([host], 'history', { kind: 'inline', state: 'open' });
  const target = await historyTarget(host);
  if (historyViews.get(host) !== entry) return { opened: true, inline: true };
  Object.assign(entry, target);
  loadInline(entry, wanted);
  // The graph is read while the page loads; the page's request joins it.
  const project = projectFor(entry);
  if (project) graphs.fresh(project).catch(() => {});
  log(`history: inline in ${host.getTitle()} for ${target.root ?? `no record (${target.reason})`}`);
  return { opened: true, inline: true };
}

/** The History page loaded into an inline view, for its entry's project. */
function loadInline(entry, at) {
  const url = new URL(`${appOrigin}${SHELL_PREFIX}history.html`);
  url.searchParams.set('inline', '1');
  if (at) url.searchParams.set('at', at);
  entry.known = null;
  void entry.contents.loadURL(url.toString());
}

/** A hidden inline view shown again at the room's box: at once, as it was
 *  left (its page put its look back to an open's when it was hidden: the
 *  card away, "This document", the river at now). Then, for a window now
 *  on another project (or none), the page is loaded afresh in the same
 *  view; on another document of the same project, the page is told
 *  `history {kind: 'document'}`; and otherwise it is caught up with what
 *  it missed while hidden (catchUp): the graph is asked again only if the
 *  record or the refs moved. */
async function showInline(host, entry, css, wanted) {
  entry.hidden = false;
  entry.attach();
  placeInline(host, entry, css);
  entry.view.setVisible(true);
  tell([entry.contents], 'history', { kind: 'shown' });
  tell([host], 'history', { kind: 'inline', state: 'open' });
  if (!entry.contents.isDestroyed()) entry.contents.focus();
  const target = await historyTarget(host);
  if (historyViews.get(host) !== entry || entry.hidden || entry.contents.isDestroyed()) return { opened: true, inline: true };
  const moved = ['root', 'reason', 'detail'].some((key) => (target[key] ?? null) !== (entry[key] ?? null));
  Object.assign(entry, target);
  if (moved || entry.contents.isLoading()) {
    if (moved) {
      loadInline(entry, wanted);
      const project = projectFor(entry);
      if (project) graphs.fresh(project).catch(() => {});
      log(`history: inline in ${host.getTitle()} for ${target.root ?? `no record (${target.reason})`}`);
    }
    return { opened: true, inline: true };
  }
  if (entry.known && scopeDocument(entry) !== entry.known.document) tell([entry.contents], 'history', { kind: 'document' });
  else void catchUp(host, entry);
  if (wanted) tell([entry.contents], 'history', { kind: 'focus', at: wanted });
  return { opened: true, inline: true };
}

/** A view shown again hears what it missed while hidden, as the
 *  two-second look would have told it (pageSince): the record's new
 *  commits (`history {kind: 'commit'}`, which the page draws at the tip
 *  without asking for the graph; taken from the kept graph, which the look
 *  grows, so they go out before the view's first frame, else read), the
 *  refs moved (`refs`, on which it asks for the graph, answered from the
 *  kept one), the guards (`state`). */
async function catchUp(host, entry) {
  const project = projectFor(entry);
  const known = entry.known;
  if (!project || !known) return;
  const here = () => historyViews.get(host) === entry && !entry.hidden && entry.known === known;
  try {
    const tip = await history.recordTip(project);
    const kept = tip && known.tip && tip !== known.tip ? graphs.since(project, known.tip, tip) : null;
    if (kept && here()) {
      known.tip = tip;
      if (kept.length > 0) tell([entry.contents], 'history', { kind: 'commit', commits: history.scoped(project.root, kept, scopeDocument(entry)) });
    }
    const [now, state] = await Promise.all([history.refs(project), project.blocked()]);
    if (here()) await pageSince(project, entry.contents, entry, { tip, now, state });
  } catch (error) {
    log(`history: ${error.message} (${entry.root})`);
  }
}

/** One History page told what moved since it drew (its `known`): the
 *  record's commits after the tip it has (`shared`, when they are the ones
 *  the two-second look read, else read for it), the refs, the guards. */
async function pageSince(project, contents, entry, { tip, now = null, state, shared = null }) {
  const known = entry.known;
  if (!known) return;
  if (tip && tip !== known.tip) {
    const from = known.tip;
    known.tip = tip;
    const commits = shared && shared.from === from ? shared.commits : await history.recordSince(project, from, tip);
    if (!shared || shared.from !== from) graphs.grow(project, from, tip, commits);
    if (commits.length > 0) tell([contents], 'history', { kind: 'commit', commits: history.scoped(project.root, commits, scopeDocument(entry)) });
  }
  if (now && known.refs !== now.signature) {
    known.refs = now.signature;
    tell([contents], 'history', { kind: 'refs', branches: now.branches, head: now.head });
  }
  if (state !== undefined && known.state !== state) {
    known.state = state;
    tell([contents], 'history', { kind: 'state', state: state ? 'paused' : 'on', reason: state });
  }
}

/** The inline view put away (the tile, Escape, its close control, View ›
 *  History…, its window's page going): hidden and kept, its listeners on
 *  the room taken off, its page told (`history {kind: 'hidden'}`, so it
 *  puts its look back to an open's while no one sees it), and the window's
 *  page told. `which`, when given, is the view meant: one already gone is
 *  not mistaken for a newer. */
function closeInline(host, which = null) {
  const entry = historyViews.get(host);
  if (!entry || entry.hidden || (which && entry !== which)) return false;
  entry.hidden = true;
  entry.detach();
  entry.view.setVisible(false);
  if (!entry.contents.isDestroyed()) tell([entry.contents], 'history', { kind: 'hidden' });
  if (!host.isDestroyed() && !host.webContents.isDestroyed()) {
    tell([host], 'history', { kind: 'inline', state: 'closed' });
    if (host.isFocused()) host.webContents.focus();
  }
  return true;
}

/** The inline view gone for good, with its window or its own page:
 *  removed and destroyed, its listeners taken off, and the window's page
 *  told if it was up. */
function destroyInline(host, which = null) {
  const entry = historyViews.get(host);
  if (!entry || (which && entry !== which)) return false;
  historyViews.delete(host);
  entry.detach();
  entry.release();
  const hostAlive = !host.isDestroyed();
  if (hostAlive) {
    try {
      host.contentView.removeChildView(entry.view);
    } catch {
      // Already gone with the window's views.
    }
  }
  if (!entry.contents.isDestroyed()) entry.contents.close();
  if (!entry.hidden && hostAlive && !host.webContents.isDestroyed()) {
    tell([host], 'history', { kind: 'inline', state: 'closed' });
    if (host.isFocused()) host.webContents.focus();
  }
  return true;
}

/** The inline view a webContents is, with its window: {host, entry}. */
function inlineOf(contents) {
  for (const [host, entry] of historyViews) if (entry.contents === contents) return { host, entry };
  return null;
}

/** View › History… (⇧⌘H): in a document window, the inline view, as the
 *  page's tile does it (the page is asked, since the room's box is its,
 *  and the view put away directly when it is up); elsewhere, the window. */
function historyFromMenu(window) {
  if (isDocumentPage(window)) {
    if (!closeInline(window)) window.webContents.send('claerbout:event', 'history', { kind: 'toggle' });
    return;
  }
  void openHistory(window);
}

/** The project a History window is on, or null. */
function projectFor(entry) {
  return entry?.root && autosave.enabled ? (autosave.projects.get(entry.root) ?? null) : null;
}

/** `history {action: 'graph', before?, limit?}`: the graph, with the
 *  record's state and why there is none, and for a page opened from a
 *  document, `scope: {document, folder}`: the document's path in the
 *  project and its folder's ('' at the top), with each commit's `scope`
 *  and `beside` (history.js, scoped). The page opens on that document
 *  every time. `windows` and `others` name documents by their paths in the
 *  project, resolved through any link, as the record's trees do.
 *  `untracked` is the whole project's "Keep an untracked/ folder here"
 *  box as it is (history.js, untracked). */
async function historyGraph(entry, message) {
  const shape = { app: appName, project: null, tip: null, head: null, branches: [], commits: [], more: false, total: 0, windows: [], others: [], scope: null };
  const project = projectFor(entry);
  if (!project) return { ...shape, state: 'none', reason: entry?.reason ?? 'refused', detail: entry?.detail ?? null, document: entry?.document ?? null };
  const document = scopeDocument(entry);
  // A page back in time (`before`) or of another size is read as asked;
  // the page's own graph is the kept one (history.js, Graphs).
  const paged = message.before != null || Number.isInteger(message.limit);
  const [reason, { signature, ...answer }, untracked] = await Promise.all([
    project.blocked(),
    paged
      ? history.graph(project, { before: message.before ?? null, limit: Number.isInteger(message.limit) ? message.limit : history.LIMIT, ties: graphs.tiesOf(project.root), document })
      : graphs.graph(project, { document }),
    history.untracked(project, {}),
  ]);
  if (!paged && entry) entry.known = { tip: answer.tip, refs: signature, state: reason, document };
  return {
    ...shape,
    ...answer,
    state: reason ? 'paused' : 'on',
    reason,
    scope: document
      ? { document, folder: document.includes('/') ? document.slice(0, document.lastIndexOf('/')) : '' }
      : null,
    project: { root: project.root, name: path.basename(project.root), display: tilde(project.root), branch: project.branchName },
    windows: history.pagePaths(project.root, openOn(project.root).map((window) => documents.get(window))),
    others: pageOthers(project.root),
    untracked,
  };
}

/** Ask a document window to write its open document: `save {id, reason}`
 *  for a rewind, `save {id, reason: 'close', choose}` for a close (see
 *  closeIO), answered `{type: 'saved', id, ok?, error?}`. {answered:
 *  false} after `wait` ms (none: `null`, for a save that may open a
 *  picker), or as soon as the page goes (dropSaves). */
function askToSave(target, { reason = 'rewind', choose = null, wait = SAVE_WAIT } = {}) {
  return new Promise((resolve) => {
    if (target.isDestroyed()) {
      resolve({ answered: false });
      return;
    }
    const id = randomUUID();
    let timer = null;
    const finish = (answer) => {
      if (timer !== null) clearTimeout(timer);
      saves.delete(id);
      resolve(answer);
    };
    if (wait !== null) timer = setTimeout(() => finish({ answered: false }), wait);
    saves.set(id, {
      window: target,
      resolve: (answer) => finish({ answered: true, ...answer }),
      drop: () => finish({ answered: false }),
    });
    target.webContents.send('claerbout:event', 'save', { id, reason, ...(choose === null ? {} : { choose }) });
  });
}

/** The window's page went (closed, crashed, navigated): the saves it was
 *  asked for are answered for it, unanswered. */
function dropSaves(window) {
  for (const pending of [...saves.values()]) if (pending.window === window) pending.drop();
}

/** A window's close, as the close guard settles it (close-guard.js,
 *  settle): written quietly where the page can (`save {reason: 'close',
 *  choose: false}`, SAVE_WAIT), else the standard sheet on the window, its
 *  Save asking `save {reason: 'close', choose: true}` with no wait once the
 *  page has user activation (a page reacting to the shell's event may then
 *  open a picker: without it, showDirectoryPicker throws "Must be handling
 *  a user gesture"; executeJavaScript with userGesture grants it, measured
 *  on Electron 44.5, 2026-10-06). */
function closeIO(window) {
  return {
    // A refusal may change what the sheet should offer (a file found
    // changed outside the app at the write is `none` now): the page sends
    // that report before its `saved` (README), and one sent just after it
    // is given a moment to arrive before the sheet is built from the
    // latest report.
    quietSave: async () => {
      const answer = await askToSave(window, { reason: 'close', choose: false });
      if (answer.answered && !answer.ok) await sleep(REPORT_GRACE);
      return answer;
    },
    ask: async (spec) => {
      if (window.isDestroyed()) return spec.cancelId;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      if (isMac) app.focus({ steal: true });
      const { response } = await dialog.showMessageBox(window, {
        message: spec.message,
        detail: spec.detail,
        buttons: spec.buttons,
        defaultId: spec.defaultId,
        cancelId: spec.cancelId,
        noLink: true,
      });
      return response;
    },
    // Bounded: a hung page never runs it, and is then not asked to save.
    activate: async () => {
      if (window.isDestroyed()) return false;
      try {
        return await Promise.race([
          window.webContents.executeJavaScript('0', true).then(() => true),
          sleep(SAVE_WAIT).then(() => false),
        ]);
      } catch (error) {
        log(`close: could not give the page activation: ${error.message}`);
        return false;
      }
    },
    chooseSave: () => askToSave(window, { reason: 'close', choose: true, wait: null }),
    log,
  };
}

/** A window held at its close: settled, and closed if that is the answer.
 *  Kept open otherwise; the page says why where it needs to. */
async function askToClose(window) {
  const outcome = await guard.settle(window, closeIO(window));
  if (outcome !== 'close' || window.isDestroyed()) return;
  guard.release(window);
  window.close();
}

/** The open document windows in the order the quit asks them: the focused
 *  one first. */
function windowsToAsk() {
  const focused = BrowserWindow.getFocusedWindow();
  const open = guard.waiting().filter((window) => !window.isDestroyed());
  return focused && open.includes(focused) ? [focused, ...open.filter((window) => window !== focused)] : open;
}

/** Quit, or relaunch into an update, once every window holding unsaved
 *  work is settled in turn (close-guard.js, quit): a Cancel on any stops
 *  it, and everything (the engine, the record, the windows) goes on as it
 *  was. A quit asked for while one is asking joins it; a relaunch asked for
 *  then makes it one. */
function quitAfterAsking({ relaunch = false } = {}) {
  return guard.quit({
    windows: windowsToAsk,
    ioFor: closeIO,
    gone: (window) => window.isDestroyed(),
    relaunch,
    proceed: ({ relaunch: again }) => {
      if (again) app.relaunch({ args: [...documents.values()].filter(Boolean) });
      app.quit();
    },
  });
}

/** Every one of this shell's windows on the project asked to save, at
 *  once, each for at most SAVE_WAIT: {unsaved: {path, error?}} for a
 *  window that answered it could not (the rewind is refused), else
 *  {silent: [path]}, the documents whose windows did not answer. Those
 *  are passed over (the apps do not answer yet), logged, and named to the
 *  page: not saved first, and, a page that does not answer save being one
 *  that does not reload either, to be reopened after the rewind. */
async function saveAll(windows) {
  const answers = await Promise.all(windows.map((window) => askToSave(window)));
  for (const [i, answer] of answers.entries()) {
    if (answer.answered && answer.ok === false) return { unsaved: { path: documents.get(windows[i]) ?? null, ...(answer.error ? { error: answer.error } : {}) } };
  }
  const silent = windows.filter((_window, i) => !answers[i].answered).map((window) => documents.get(window) ?? null).filter(Boolean);
  if (silent.length > 0) log(`history: ${someNames(silent.map((file) => path.basename(file)))} did not answer save within ${SAVE_WAIT / 1000} s; the rewind went on`);
  return { silent };
}

/** A few names for the log. */
function someNames(names) {
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/** `rewind {sha, tip, paths?, anyway?}` (history.js, rewind): the steps
 *  as `rewind {step, state, detail?}` events to the History windows on
 *  the project, then `reload {id, paths, reason, to}` to this shell's
 *  windows on it, with every path written or removed. The reload step's
 *  `done` names, in `silent`, the rewound documents whose windows did not
 *  answer save: they will not reload, and the page says to reopen them. */
async function historyRewind(entry, message) {
  const project = projectFor(entry);
  if (!project) return { refused: 'failed', detail: 'there is no record here' };
  const root = project.root;
  const viewers = () => viewersOf(root);
  const result = await history.rewind(
    project,
    { sha: message.sha, tip: message.tip ?? null, paths: Array.isArray(message.paths) ? message.paths : null, anyway: message.anyway === true },
    {
      save: () => saveAll(openOn(root)),
      // The page compares paths in the project, never absolute ones.
      onStep: (step, state, detail) => tell(viewers(), 'rewind', { step, state, ...(detail ? { detail: detail.silent ? { ...detail, silent: history.pagePaths(root, detail.silent) } : detail } : {}) }),
      others: () => presence.others(root, appName),
    },
  );
  if (result?.ok) {
    tell(viewers(), 'rewind', { step: 'reload', state: 'doing' });
    const paths = [...result.written, ...result.removed].map((file) => path.join(root, ...file.split('/')));
    tell(openOn(root), 'reload', { id: randomUUID(), paths, reason: 'rewind', to: result.target });
    const rewound = new Set([...result.written, ...result.removed]);
    const silent = (result.silent ?? []).filter((file) => {
      const relative = history.relativeTo(root, file);
      return relative !== null && rewound.has(relative);
    });
    tell(viewers(), 'rewind', { step: 'reload', state: 'done', ...(silent.length ? { detail: { silent: history.pagePaths(root, silent) } } : {}) });
    log(`history: rewound ${root} to ${result.target.slice(0, 10)}: ${result.written.length} written, ${result.removed.length} removed`);
    void watchProjects();
  } else if (result) {
    log(`history: no rewind of ${root}: ${result.same ? 'nothing to change' : `${result.refused}${result.reason || result.detail ? ` (${result.reason ?? result.detail})` : ''}`}`);
  }
  // To the page, documents by their paths in the project.
  if (result?.silent) return { ...result, silent: history.pagePaths(root, result.silent) };
  if (result?.refused === 'other-app') return { ...result, documents: history.pagePaths(root, result.documents) };
  return result;
}

/** A History page's requests, from its window or its inline view:
 *  `history {action: 'graph' | 'commit' | 'blob' | 'compare' | 'untracked'
 *  | 'close'}`
 *  and `rewind`, for its own project only. `close` puts the page away
 *  (the view destroyed, the window closed). */
async function answerHistory(entry, message, { open, close }) {
  const type = message?.type;
  try {
    if (type === 'history') {
      const project = projectFor(entry);
      switch (message.action) {
        case 'graph':
          return await historyGraph(entry, message);
        case 'commit':
          return project ? await history.commitDetail(project, message.sha) : null;
        case 'blob':
          return project ? await history.blob(project, message.sha, message.path) : null;
        case 'compare':
          return project
            ? await history.compare(project, message.sha, {
                paths: Array.isArray(message.paths) ? message.paths : null,
                others: () => pageOthers(project.root),
              })
            : null;
        case 'untracked':
          return project ? await history.untracked(project, { keep: message.keep }) : null;
        case undefined:
        case 'open':
          return await open();
        case 'close':
          close();
          return { closed: true };
        default:
          return null;
      }
    }
    if (type === 'rewind') return await historyRewind(entry, message);
    if (type === 'error') {
      log(`history page error: ${message.message ?? '?'}`);
      return null;
    }
  } catch (error) {
    return { error: error.message };
  }
  log(`unknown history message: ${type}`);
  return null;
}

// What the shell last saw of each project: root → {tip, failed?}.
const seen = new Map();
let watching = false;

/**
 * Every two seconds, every project with a window of this shell's on it:
 * the record's tip (a loose ref file, read; git for a packed one). When
 * it moved, the kept graph grows by the new commits (history.js, Graphs),
 * the History pages on the project hear `history {kind: 'commit',
 * commits}`, and a "rewind to" another app made has this shell's windows
 * on the project told to `reload`. With a History page up (a hidden
 * inline view is not), its user branches and HEAD (`history {kind:
 * 'refs'}`) and the record's guards (`history {kind: 'state'}`) too, each
 * page told what moved since it drew. A project with no window left has
 * its kept graph dropped.
 */
async function watchProjects() {
  if (watching || !autosave.enabled) return;
  watching = true;
  try {
    for (const [root, project] of autosave.projects) {
      const viewers = viewersOf(root);
      if (project.windows.size === 0 && viewers.length === 0) {
        seen.delete(root);
        graphs.forget(root);
        continue;
      }
      const last = seen.get(root) ?? {};
      const next = { ...last };
      try {
        next.tip = await history.recordTip(project);
        let shared = null;
        if ('tip' in last && next.tip && next.tip !== last.tip) {
          const commits = await history.recordSince(project, last.tip, next.tip);
          graphs.grow(project, last.tip, next.tip, commits);
          shared = { from: last.tip, commits };
          for (const commit of commits) {
            if (commit.trigger !== 'rewind-to' || commit.app === appName) continue;
            const paths = (await history.touched(project, commit.sha)).map((file) => path.join(root, ...file.split('/')));
            tell(openOn(root), 'reload', { id: commit.sha, paths, reason: 'rewind', to: commit.target, app: commit.app });
            log(`history: ${commit.app} rewound ${root}; this app's windows on it reload`);
          }
        }
        if (viewers.length > 0) {
          // Each page hears what moved since it drew (its `known`): the
          // record's new commits, scoped to its own document, the refs, the
          // guards.
          const [now, state] = await Promise.all([history.refs(project), project.blocked()]);
          for (const { contents, entry } of pagesOn(root)) await pageSince(project, contents, entry, { tip: next.tip, now, state, shared });
        }
        delete next.failed;
      } catch (error) {
        if (last.failed !== error.message) log(`history: ${error.message} (${root})`);
        next.failed = error.message;
      }
      seen.set(root, next);
    }
  } finally {
    watching = false;
  }
}

/** The projects this app has said it is on (presence files). */
const present = new Set();

/** This app's presence on each project it has windows on, rewritten when
 *  a window's document changes or it closes; removed when the last goes. */
function syncPresence() {
  if (!autosave.enabled) return;
  try {
    const byRoot = new Map();
    for (const [window, root] of autosave.windows) {
      const file = documents.get(window);
      if (file) byRoot.set(root, [...(byRoot.get(root) ?? []), file]);
    }
    for (const root of new Set([...present, ...byRoot.keys()])) {
      presence.write(appName, root, byRoot.get(root) ?? []);
      if (byRoot.has(root)) present.add(root);
      else present.delete(root);
    }
  } catch (error) {
    log(`history: presence not written: ${error.message}`);
  }
}

function clearPresence() {
  for (const root of present) {
    try {
      presence.remove(appName, root);
    } catch {
      // Gone already.
    }
  }
  present.clear();
}

// MARK: - Requests from the page (src/shell.ts)

async function answer(window, message) {
  const type = message?.type;
  const start = documents.get(window);
  switch (type) {
    case 'open': {
      const { canceled, filePaths } = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        defaultPath: start ? path.dirname(start) : undefined,
      });
      const chosen = canceled ? null : (filePaths[0] ?? null);
      if (chosen) setDocument(window, chosen);
      return { path: chosen };
    }
    case 'saveAs': {
      const name = typeof message.name === 'string' ? message.name : config.defaultDocument;
      const { canceled, filePath } = await dialog.showSaveDialog(window, {
        defaultPath: start ? path.join(path.dirname(start), name) : name,
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      const chosen = canceled || !filePath ? null : filePath;
      if (chosen) setDocument(window, chosen);
      return { path: chosen };
    }
    case 'read':
      return FileOps.read(message.path);
    case 'write':
      return FileOps.write(message.path, message.text);
    case 'stat':
      return FileOps.stat(message.path);
    case 'rename':
      return FileOps.rename(message.path, message.name);
    case 'remove':
      return FileOps.remove(message.path);
    case 'choose':
      void choose(message.python, window);
      return null;
    case 'ready':
      // The page is listening: hand it the document it was opened for, if
      // the app takes documents by drop.
      if (config.openBy === 'drop' && start) void dropDocument(window, start);
      return null;
    case 'focus':
      // The page asks for its own window to come forward: shown,
      // unminimized, focused, the app made active. A page that keeps one
      // window per file (Plass) has the window holding a file front
      // itself when a second launch of that file finds it, and the
      // launch's window closes. The shell knows windows and the pages
      // know handles, so the holder asks for itself and no window id
      // crosses the protocol. An older shell answers null here, which is
      // how a page tells it cannot ask.
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      if (isMac) app.focus({ steal: true });
      return { focused: true };
    case 'status':
      log(`page: Python is ${message.state ?? '?'} (${window.getTitle()})`);
      return null;
    case 'document': {
      // A page that keeps its documents by handle (Plass) tells the shell
      // which file its window holds: {path} when the preload's pathOf
      // knew it (a path-backed File), else {name, size, modified},
      // matched against the files handles have lately touched
      // (`touched`); {path: null} for none. The window's represented
      // file, and the project the autosave record follows for it. A
      // path is taken only when it is an absolute path to an existing
      // regular file; a report that matches nothing is none, never a
      // stale path. Knuth opens by path and never needs to.
      let file = typeof message.path === 'string' && message.path ? reportedFile(message.path) : null;
      if (!file && typeof message.name === 'string' && message.name) file = touchedFile(message);
      setDocument(window, file);
      return { path: file };
    }
    case 'shape': {
      // The page asks its window to keep the shape of what it shows
      // (ManimLive: the scene's picture, which has a shape of its own —
      // 16:9, 2:1 — where a paper or a notebook has none): {ratio, extra:
      // {width, height}}, the ratio of the room the page draws and the
      // chrome round it (its bar, its edges, the band its presenter's
      // bar stands on) the ratio must not include, in the page's px;
      // {ratio: null} lifts it (a landing page, a scene with no picture).
      // From then on a drag of the window's width sets its height and the
      // room fills the opening exactly. The window is resized at once to
      // meet the shape, keeping its width (its height, when that width's
      // height would not fit the display), so the room fills from this
      // moment and not from the next drag; a maximized or full-screen
      // window is left as it is (the shape holds for when it comes back).
      // The page's px are zoomed px, so the extra is scaled by the zoom
      // here and again when the zoom changes (zoomTo). Since 0.2.7; an
      // older shell answers null.
      const ratio = Number.isFinite(message.ratio) && message.ratio > 0 ? message.ratio : 0;
      const extra = {
        width: Math.max(0, Math.round(Number(message.extra?.width) || 0)),
        height: Math.max(0, Math.round(Number(message.extra?.height) || 0)),
      };
      const held = shapes.get(window);
      if (ratio) shapes.set(window, { ratio, extra });
      else shapes.delete(window);
      if (!shapeHooked.has(window)) {
        // A drag of the window's edge is held to the shape by the shell's
        // own rule (shapeResize); full screen is the display's shape, and
        // the window is fitted again once it is back on its frame.
        shapeHooked.add(window);
        window.on('will-resize', (event, bounds, details) => shapeResize(window, event, bounds, details));
        window.on('leave-full-screen', () => keepShape(window, null));
      }
      keepShape(window, held ?? null);
      return { ratio: ratio || null };
    }
    case 'autosave':
      // Something happened in the page worth a commit on the project's
      // record (a cell ran): {trigger: 'cell run [4]'}. Only if anything
      // changed, and only when the window is on a project.
      void autosave.notice(window, message.trigger);
      return null;
    case 'history': {
      // The History page for this window's project: `open` with the room's
      // box ({inline: {x, y, width, height}}, CSS px) lays it over the room
      // of this window, `bounds` moves it there, `close` puts it away;
      // `open` without a box (or no action) makes or brings forward the
      // History window. {at?} selects a commit. The graph is the History
      // page's alone.
      const at = typeof message.at === 'string' ? message.at : null;
      switch (message.action) {
        case 'open':
          if (message.inline !== undefined) {
            const css = roomBox(message.inline);
            if (!css) return { opened: false, error: 'inline must be the room\'s box, {x, y, width, height} in CSS px' };
            return openInline(window, css, at);
          }
        // falls through: the window
        case undefined:
          await openHistory(window, at);
          return { opened: true };
        case 'bounds': {
          const entry = historyViews.get(window);
          const css = roomBox(message.inline);
          if (!entry || !css) return { ok: false };
          placeInline(window, entry, css);
          return { ok: true };
        }
        case 'close':
          closeInline(window);
          return { closed: true };
        default:
          return null;
      }
    }
    case 'unsaved':
      // What closing this window now would lose (close-guard.js): {unsaved,
      // name, save: 'quiet' | 'choose' | 'none', label?, detail?}, sent by
      // the page whenever any of it changes and once after load. While
      // unsaved, a close is held and settled: written quietly where `save`
      // is quiet, else the sheet (Save, Don't Save, Cancel; no Save for
      // `none`), and the quit asks for each such window in turn. A blank
      // never-saved document is not unsaved. Since 0.2.8; an older shell
      // answers null, and the page then stops sending (and must not use
      // beforeunload in the shell: Electron silently refuses the close).
      guard.report(window, message);
      return { guarded: true };
    case 'saved': {
      // A page's answer to `save` (a rewind asked it to write its open
      // document first, or a close): {id, ok?, error?}; ok: false refuses
      // the rewind, and keeps the closing window open.
      const pending = saves.get(message.id);
      if (pending && pending.window === window) pending.resolve({ ok: message.ok !== false, ...(typeof message.error === 'string' ? { error: message.error } : {}) });
      return null;
    }
    case 'update': {
      // {action: 'install'} starts the install (the page follows it by
      // `update` events); anything else is a check, answered in full.
      if (message.action === 'install') {
        void runUpdate(false);
        return { state: 'installing', current: updater.current };
      }
      // Installed, its relaunch stopped: what is on offer is the relaunch,
      // which the install now is (runUpdate), whatever the site says.
      if (installedPending) return { state: 'available', installed: true, latest: installedPending.latest, current: installedPending.current };
      try {
        const result = await updater.check();
        if (result.state === 'available') latestKnown = { state: 'available', latest: result.latest, current: result.current };
        return result;
      } catch (error) {
        return { state: 'failed', text: error.message, current: updater.current };
      }
    }
    case 'error':
      log(`page error: ${message.message ?? '?'} (${window.getTitle()})`);
      return null;
    default:
      log(`unknown shell message: ${type}`);
      return null;
  }
}

ipcMain.handle('claerbout:request', async (event, message) => {
  // An inline History view first: its webContents is not its window's.
  const inline = inlineOf(event.sender);
  if (inline) {
    if (originOf(event.senderFrame?.url ?? '') !== inline.entry.origin) {
      log(`refused a shell request from ${event.senderFrame?.url ?? 'an unknown frame'}`);
      return null;
    }
    return answerHistory(inline.entry, message, {
      open: async () => ({ opened: true, inline: true }),
      // After the answer is on its way: the page asking is the one going.
      close: () => setTimeout(() => closeInline(inline.host, inline.entry), 0),
    });
  }
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !trusted(window, event.senderFrame?.url ?? '')) {
    log(`refused a shell request from ${event.senderFrame?.url ?? 'an unknown frame'}`);
    return null;
  }
  if (historyWindows.has(window)) {
    return answerHistory(historyWindows.get(window), message, {
      open: async () => {
        await openHistory(window);
        return { opened: true };
      },
      close: () => setTimeout(() => window.isDestroyed() || window.close(), 0),
    });
  }
  return answer(window, message);
});

// MARK: - Menu

function newWindow() {
  if (mode) openWindow(pageURL(null));
}

/** File → Open…: a document app opens each file in its own window. */
async function openFromMenu() {
  if (!mode) return;
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
  if (!canceled) for (const file of filePaths) openDocument(file);
}

/** The same choice as the first launch. It applies to windows opened from
 *  then on; a window already open keeps the Python it has. */
function choosePython() {
  if (!installing) showSetup(null);
}

const when = (build) => (build?.built ? `, built ${build.built.slice(0, 10)}` : '');

/** Check for Updates… in the menu: the answer in a dialog, and the offer
 *  to install when the site has a newer build. An update already in place
 *  whose relaunch was stopped is offered the relaunch instead. */
async function checkForUpdates() {
  if (installedPending) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `${NAME} has been updated`,
      detail: `Build ${installedPending.latest.build}${when(installedPending.latest)} is in place and runs from the next launch. Relaunch now? Open documents are reopened; a window with unsaved work asks first.`,
      buttons: ['Relaunch', 'Not Now'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) void runUpdate(false);
    return;
  }
  let result;
  try {
    result = await updater.check();
  } catch (error) {
    await dialog.showMessageBox({ type: 'warning', message: `${NAME} could not check for updates`, detail: error.message, buttons: ['OK'] });
    return;
  }
  const mine = `build ${result.current.build ?? 'unknown'}${when(result.current)}`;
  const theirs = `build ${result.latest.build}${when(result.latest)}`;
  if (result.state === 'current') {
    await dialog.showMessageBox({ type: 'info', message: `${NAME} is up to date`, detail: `This is ${mine}.`, buttons: ['OK'] });
    return;
  }
  if (result.state === 'development') {
    await dialog.showMessageBox({ type: 'info', message: `${NAME} is running from a checkout`, detail: `The site has ${theirs}. A development build is not updated: build or install it again.`, buttons: ['OK'] });
    return;
  }
  if (result.state === 'unsupported') {
    await dialog.showMessageBox({ type: 'info', message: `${NAME} updates itself only on a Mac`, detail: `The site has ${theirs}; this is ${mine}. Run the install line again to update.`, buttons: ['OK'] });
    return;
  }
  latestKnown = { state: 'available', latest: result.latest, current: result.current };
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: `A new ${NAME} is available`,
    detail: `The site has ${theirs}; this is ${mine}. ${NAME} downloads it, swaps it in and relaunches; open documents are reopened.`,
    buttons: ['Install and Relaunch', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) void runUpdate(true);
}

let updateRun = null;

/** One install at a time, from the menu or from a page: every window hears
 *  its progress as `update` events, the log keeps it, and the app relaunches
 *  into the new bundle once it is in place (from the menu, after saying so). */
function runUpdate(fromMenu) {
  if (updateRun) return updateRun;
  updateRun = (async () => {
    try {
      // Installed already, its relaunch stopped: only the relaunch is left.
      const result =
        installedPending ??
        (await updater.install((step) => {
          log(`update: ${step.text}`);
          broadcast('update', { ...step, current: updater.current });
        }));
      if (result.state !== 'ready') {
        broadcast('update', { ...result });
        return result;
      }
      const detail = `Build ${result.latest.build}${when(result.latest)} is in place; ${NAME} relaunches now.`;
      broadcast('update', { state: 'ready', text: detail, latest: result.latest, current: result.current });
      if (fromMenu) await dialog.showMessageBox({ type: 'info', message: `${NAME} has been updated`, detail, buttons: ['Relaunch'] });
      else await sleep(1500);
      relaunch(result);
      return result;
    } catch (error) {
      log(`update failed: ${error.message}`);
      broadcast('update', { state: 'failed', text: error.message, current: updater.current });
      if (fromMenu) {
        await dialog.showMessageBox({ type: 'warning', message: `${NAME} could not update`, detail: `${error.message}\n\nLog: ${logPath}`, buttons: ['OK'] });
      }
      return { state: 'failed', text: error.message };
    } finally {
      updateRun = null;
    }
  })();
  return updateRun;
}

/** The new bundle, with this instance's documents reopened: `relaunch`
 *  starts the executable at this process's path, which the swap made the
 *  new one's, once `quit` has stopped the engine. A window holding unsaved
 *  work is asked first, as the quit asks; a Cancel leaves the app running
 *  on the old build (the new one is in place for the next launch), and no
 *  relaunch armed. The pages were told it relaunches now: they are told it
 *  did not, as `failed` (today's pages put their update item back and say
 *  the text on it), and the next install, from a page or the menu, is the
 *  relaunch (installedPending). */
function relaunch(result) {
  void quitAfterAsking({ relaunch: true }).then((went) => {
    if (went) return;
    log('update: the relaunch was stopped: a window kept its unsaved work; the new build runs from the next launch');
    installedPending = result;
    latestKnown = { state: 'available', latest: result.latest, current: result.current };
    broadcast('update', {
      state: 'failed',
      stopped: true,
      text: `the relaunch was stopped to keep unsaved work open. Build ${result.latest.build} is installed: it runs from the next launch, or update again to relaunch into it now.`,
      latest: result.latest,
      current: result.current,
    });
  });
}

/** The View menu's zoom, with the window following when the config says so
 *  (`window.followZoom`; Plass): a page laid out as a fixed-width paper with
 *  a margin wants the window to grow and shrink with the zoom, so the paper
 *  keeps its room — scaled here, in screen pixels, in one step, never by
 *  the page measuring itself (a page's px are zoomed px, and a page that
 *  resized the window after every resize walked it there in several steps).
 *  The window stays on its display; maximized and fullscreen windows are
 *  left alone. Chromium's zoom levels: each is ×1.2, half-steps as the
 *  menu roles use. */
function zoomTo(window, level) {
  if (!window || window.isDestroyed()) return;
  const contents = window.webContents;
  const before = contents.getZoomFactor();
  contents.setZoomLevel(level);
  const after = contents.getZoomFactor();
  // The History view over the room, at the new zoom until the page's own
  // `bounds` (a window that follows the zoom keeps the room's CSS box).
  const inline = historyViews.get(window);
  if (inline && after !== before) placeInline(window, inline, inline.css);
  if (!config.window?.followZoom || window.isFullScreen() || window.isMaximized() || after === before) return;
  const ratio = after / before;
  const bounds = window.getBounds();
  const [contentWidth, contentHeight] = window.getContentSize();
  const area = screen.getDisplayMatching(bounds).workArea;
  const chrome = { x: bounds.width - contentWidth, y: bounds.height - contentHeight };
  const width = Math.min(Math.round(contentWidth * ratio), area.width - chrome.x);
  const height = Math.min(Math.round(contentHeight * ratio), area.height - chrome.y);
  window.setContentSize(width, height);
  // Still on the display: nudge back in if the growth ran past its edge.
  const grown = window.getBounds();
  const x = Math.max(area.x, Math.min(grown.x, area.x + area.width - grown.width));
  const y = Math.max(area.y, Math.min(grown.y, area.y + area.height - grown.height));
  if (x !== grown.x || y !== grown.y) window.setPosition(x, y);
  // The extra is in the page's px: at the new zoom it is a new size.
  keepShape(window, null);
}

/** The shape a window keeps (the `shape` request): its room's ratio and
 *  the chrome's extra, in the page's px. */
const shapes = new WeakMap();
const shapeHooked = new WeakSet();

/** The shape's extra in DIP: the page's px times the zoom. */
function shapeExtra(window, shape) {
  const zoom = window.webContents.getZoomFactor();
  return { width: Math.round(shape.extra.width * zoom), height: Math.round(shape.extra.height * zoom) };
}

/** A drag of the window's edge, held to the shape: the dimension the
 *  pointer moves is taken as given and the other follows it, the edges
 *  not being dragged kept where they are, so the room keeps the
 *  picture's ratio with the chrome's extra outside it. The shell's own
 *  rule rather than setAspectRatio: on macOS Electron sets AppKit's
 *  content aspect ratio (the plain ratio, extra and all) beside its
 *  delegate's (the ratio less the extra), and the two fought — a grabbed
 *  edge jumped smaller and left the pointer outside the window (Taylor,
 *  2026-10-04). A size under the window's minimum is refused whole. */
function shapeResize(window, event, bounds, details) {
  const shape = shapes.get(window);
  if (!shape || window.isDestroyed() || window.isFullScreen()) return;
  const extra = shapeExtra(window, shape);
  const current = window.getBounds();
  const [contentWidth, contentHeight] = window.getContentSize();
  const chrome = { x: current.width - contentWidth, y: current.height - contentHeight };
  const widthMoved = bounds.width !== current.width;
  const heightMoved = bounds.height !== current.height;
  const edge = details && details.edge;
  const vertical = heightMoved && (!widthMoved || edge === 'bottom' || edge === 'top');
  let { width, height } = bounds;
  if (vertical) width = Math.round((height - chrome.y - extra.height) * shape.ratio + extra.width + chrome.x);
  else height = Math.round((width - chrome.x - extra.width) / shape.ratio + extra.height + chrome.y);
  const [minWidth, minHeight] = window.getMinimumSize();
  if (width < minWidth || height < minHeight) {
    event.preventDefault();
    return;
  }
  if (width === bounds.width && height === bounds.height) return;
  event.preventDefault();
  // The edges the pointer is not on stay put: a left or top drag moves
  // x or y with the size, so the right or bottom edge is the anchor.
  const x = bounds.x !== current.x ? current.x + current.width - width : bounds.x;
  const y = bounds.y !== current.y ? current.y + current.height - height : bounds.y;
  window.setBounds({ x, y, width, height });
}

/** Hold the window to its shape: the content resized now to meet it
 *  (`fit`: false to do nothing but keep the shape for the next drag; the
 *  shape held before, or null, to fit from it). What is kept: the room,
 *  when the shape held before had the same ratio and only the chrome
 *  changed (a console opening beside the picture widens the window and
 *  leaves the picture as it was, rather than squeezing it to keep the
 *  window); otherwise the width, or the height where the width's height
 *  runs past the display's work area. Nudged back onto the display, as
 *  zoomTo does. */
function keepShape(window, fit) {
  if (!window || window.isDestroyed()) return;
  const shape = shapes.get(window);
  if (!shape) return;
  if (window.isFullScreen()) return;   // the display's shape; put back on leaving
  const extra = shapeExtra(window, shape);
  if (fit === false || window.isMaximized()) return;
  const bounds = window.getBounds();
  const [contentWidth, contentHeight] = window.getContentSize();
  const area = screen.getDisplayMatching(bounds).workArea;
  const chrome = { x: bounds.width - contentWidth, y: bounds.height - contentHeight };
  const held = fit && fit.ratio === shape.ratio ? shapeExtra(window, fit) : null;
  let width = held ? contentWidth - held.width + extra.width : contentWidth;
  let height = Math.round((width - extra.width) / shape.ratio + extra.height);
  if (width + chrome.x > area.width) {
    width = area.width - chrome.x;
    height = Math.round((width - extra.width) / shape.ratio + extra.height);
  }
  if (height + chrome.y > area.height) {
    height = area.height - chrome.y;
    width = Math.round((height - extra.height) * shape.ratio + extra.width);
  }
  const [minWidth, minHeight] = window.getMinimumSize();
  if (width < minWidth || height < minHeight) return;   // the minimum has the say
  if (width === contentWidth && height === contentHeight) return;
  window.setContentSize(width, height);
  const grown = window.getBounds();
  const x = Math.max(area.x, Math.min(grown.x, area.x + area.width - grown.width));
  const y = Math.max(area.y, Math.min(grown.y, area.y + area.height - grown.height));
  if (x !== grown.x || y !== grown.y) window.setPosition(x, y);
}

/** The window a menu item acts on: the one the menu passes, else the
 *  focused one (an item clicked programmatically passes none). */
const zoomBy = (window, step) => {
  const target = window ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (target) zoomTo(target, step === 0 ? 0 : target.webContents.getZoomLevel() + step);
};
const zoomItems = [
  { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: (_item, window) => zoomBy(window, 0) },
  { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: (_item, window) => zoomBy(window, 0.5) },
  // ⌘= is what the key says without shift; the role registers both.
  { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, acceleratorWorksWhenHidden: true, click: (_item, window) => zoomBy(window, 0.5) },
  { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: (_item, window) => zoomBy(window, -0.5) },
];

function buildMenu() {
  const appItems = [
    // A choice only where there is one.
    ...(pythons.length > 1 ? [{ label: 'Choose Python…', click: choosePython }] : []),
    { label: 'Check for Updates…', click: () => void checkForUpdates() },
    { label: 'Show Log', click: () => void shell.openPath(logPath) },
  ];
  const template = [
    ...(isMac
      ? [
          {
            label: NAME,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              ...appItems,
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: newWindow },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => void openFromMenu() },
        { type: 'separator' },
        ...(isMac ? [] : [...appItems, { type: 'separator' }]),
        { role: 'close' },
        ...(isMac ? [] : [{ role: 'quit' }]),
      ],
    },
    // Without an Edit menu, ⌘C/⌘V/⌘Z never reach the page on the Mac.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // ⌘Y is redo in both apps and ⌥⌘H is Hide Others.
        { label: 'History…', accelerator: 'CmdOrCtrl+Shift+H', click: (_item, window) => historyFromMenu(window ?? BrowserWindow.getFocusedWindow() ?? null) },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        ...(config.window?.followZoom ? zoomItems : [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }]),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// MARK: - What the page may ask Chromium for

/** Chromium asks the shell before a page uses a capability; Electron's
 *  default is to grant everything. The shell answers explicitly: the
 *  File System Access API, always — a stored handle then reopens after a
 *  relaunch with no request, which is the whole grants model of an app
 *  that keeps files by handle (Plass) — the page's own fullscreen, and
 *  copying to the clipboard; plus whatever the config lists in
 *  `permissions` (Electron's names: 'clipboard-read', 'media',
 *  'notifications', …). Everything else is refused, and logged. Only the app's own pages are asked about,
 *  and the answer is the same for both of Chromium's questions (a check
 *  before use, a request the page makes). */
function grantPermissions() {
  // What any of the suite's pages may need: files by handle, the page's
  // own fullscreen, and writing to the clipboard (copy).
  const always = ['fileSystem', 'fullscreen', 'clipboard-sanitized-write'];
  const allowed = new Set([...always, ...(Array.isArray(config.permissions) ? config.permissions : [])]);
  // Chromium checks some capabilities on every launch (background sync,
  // window management); a refusal is logged once per name, not each time.
  const refused = new Set();
  const decide = (origin, permission) => {
    const own = originOf(origin) === appOrigin || (engine.isRunning && originOf(origin) === engine.origin);
    const granted = own && allowed.has(permission);
    if (!granted && !refused.has(`${permission} ${origin}`)) {
      refused.add(`${permission} ${origin}`);
      log(`refused ${permission} for ${origin}`);
    }
    return granted;
  };
  // A fileSystem question names the file (and no window): remembered, so
  // a page's `document` request can be matched to a path (`touched`).
  const noticed = (permission, details) => {
    if (permission === 'fileSystem' && typeof details?.filePath === 'string' && !details.isDirectory) touch(details.filePath);
  };
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin, details) => {
    noticed(permission, details);
    return decide(origin, permission);
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    noticed(permission, details);
    callback(decide(contents.getURL(), permission));
  });
}

// MARK: - The application

/** Documents named on the command line: how Windows opens a file with the
 *  app, and how a second launch hands its files to the first. */
function filesIn(argv) {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((arg) => !arg.startsWith('-') && path.isAbsolute(arg) && fs.existsSync(arg))
    .filter((arg) => fs.statSync(arg).isFile());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Finder opens arrive before `ready` when they launch the app, so the
  // listener is registered first and anything early waits in `pending`.
  app.on('open-file', (event, file) => {
    event.preventDefault();
    openDocument(file);
  });
  app.on('second-instance', (_event, argv) => {
    const files = filesIn(argv);
    for (const file of files) openDocument(file);
    if (files.length === 0) {
      if (mode) newWindow();
      else BrowserWindow.getAllWindows()[0]?.focus();
    }
  });
  pending.push(...filesIn(process.argv));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    if (mode) newWindow();
    else if (!installing) showSetup(pythons.length > 1 ? null : pythons[0]);
  });

  // A Mac app stays open with no windows; elsewhere, closing the last
  // window is quitting.
  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });

  // Quitting first asks each window holding unsaved work, in turn, as its
  // close would (quitAfterAsking): a Cancel stops the quit before anything
  // else has happened, and a second quit while it asks joins it. Then the
  // quit flushes the autosave record (every open session closes) and stops
  // the engine, and quits for real. A second quit while that is under way
  // goes through at once.
  let stopped = false;
  app.on('before-quit', (event) => {
    if (!guard.quitAllowed) {
      if (guard.quitRun || guard.waiting().some((window) => !window.isDestroyed())) {
        event.preventDefault();
        void quitAfterAsking();
        return;
      }
      // Nothing to ask: decided, so a report arriving while the windows
      // close does not stop the quit halfway.
      guard.quitAllowed = true;
    }
    clearPresence();
    if (stopped || (!engine.isRunning && !autosave.enabled)) return;
    event.preventDefault();
    stopped = true;
    void Promise.allSettled([autosave.quit(), engine.stop()]).finally(() => app.quit());
  });

  app.whenReady().then(() => {
    protocol.handle(scheme, servePage);
    grantPermissions();
    buildMenu();
    if (autosave.enabled) setInterval(() => void watchProjects(), 2000);
    // What the last update left behind, then a quiet look at the site:
    // only an installed app, and the pages hear of a new build.
    updater.clean();
    if (updater.bundle) {
      setTimeout(() => {
        updater
          .check()
          .then((result) => {
            if (result.state !== 'available' || installedPending) return;
            latestKnown = { state: 'available', latest: result.latest, current: result.current };
            log(`update available: build ${result.latest.build} (this is ${result.current.build ?? 'unknown'})`);
            broadcast('update', latestKnown);
          })
          .catch((error) => log(`update check: ${error.message}`));
      }, 8000);
    }
    // What was chosen before, if the app still offers it; with one
    // Python on offer there is nothing to choose, and it is simply started.
    const remembered = readPreferences().python;
    const python = offers(remembered) ? remembered : pythons.length === 1 ? pythons[0] : null;
    if (python === 'browser') becomeReady('browser', null);
    else if (python === 'uv' && Installer.isInstalled) void startEngine(null);
    // Chosen before, but its pieces are gone: set it up again. With uv the
    // only Python, the setup page is the progress screen, no question asked.
    else if (python === 'uv') showSetup('uv');
    else showSetup(offers(env('CHOOSE')) ? env('CHOOSE') : null);
  });
}
