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

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
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

/** <scheme>://app/<path> → the bundled page. What the engine serves over
 *  HTTP, for the mode with no engine. */
async function servePage(request) {
  let relative = decodeURIComponent(new URL(request.url).pathname);
  if (!relative || relative === '/') relative = '/index.html';
  const root = path.resolve(webRoot);
  const file = path.resolve(root, `.${relative}`);
  const notFound = () => new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
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
 *  moves the lights; the overlay's height follows (2·y + 14 px). The
 *  setup page gets the same bar. */
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
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
  window.on('close', () => {
    if (!window.isMaximized() && !window.isFullScreen()) writePreference('windowSize', window.getSize());
  });
  window.on('closed', () => {
    documents.delete(window);
    origins.delete(window);
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
    case 'update': {
      // {action: 'install'} starts the install (the page follows it by
      // `update` events); anything else is a check, answered in full.
      if (message.action === 'install') {
        void runUpdate(false);
        return { state: 'installing', current: updater.current };
      }
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
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !trusted(window, event.senderFrame?.url ?? '')) {
    log(`refused a shell request from ${event.senderFrame?.url ?? 'an unknown frame'}`);
    return null;
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
 *  to install when the site has a newer build. */
async function checkForUpdates() {
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
      const result = await updater.install((step) => {
        log(`update: ${step.text}`);
        broadcast('update', { ...step, current: updater.current });
      });
      if (result.state !== 'ready') {
        broadcast('update', { ...result });
        return result;
      }
      const detail = `Build ${result.latest.build}${when(result.latest)} is in place; ${NAME} relaunches now.`;
      broadcast('update', { state: 'ready', text: detail, latest: result.latest, current: result.current });
      if (fromMenu) await dialog.showMessageBox({ type: 'info', message: `${NAME} has been updated`, detail, buttons: ['Relaunch'] });
      else await sleep(1500);
      relaunch();
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
 *  new one's, once `quit` has stopped the engine. */
function relaunch() {
  app.relaunch({ args: [...documents.values()].filter(Boolean) });
  app.quit();
}

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
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
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
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => decide(origin, permission));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
    callback(decide(contents.getURL(), permission)),
  );
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

  let stopped = false;
  app.on('before-quit', (event) => {
    if (stopped || !engine.isRunning) return;
    event.preventDefault();
    void engine.stop().finally(() => {
      stopped = true;
      app.quit();
    });
  });

  app.whenReady().then(() => {
    protocol.handle(scheme, servePage);
    grantPermissions();
    buildMenu();
    // What the last update left behind, then a quiet look at the site:
    // only an installed app, and the pages hear of a new build.
    updater.clean();
    if (updater.bundle) {
      setTimeout(() => {
        updater
          .check()
          .then((result) => {
            if (result.state !== 'available') return;
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
