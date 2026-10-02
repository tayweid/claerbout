// Updating a Claerbout app from inside the app (Knuth's SHELL_STABILITY.md,
// "An update path for the download button"). Every deploy publishes the
// app beside its site as app/<Name>-<arch>.zip and, since shell 0.2.0,
// app/latest.json beside them: which build the zips are. package.mjs
// stamps the same build into the bundle's package.json, so checking is one
// fetch of latest.json and a comparison, and "newer" is simply "not the
// build this is": the site only ever carries its current deploy.
//
// Installing is the install line's work done by the app on itself:
// download the zip, check it against the site's checksum and its own
// signature, unpack it beside the bundle, complete it with Electron's
// framework (the download's own complete.sh, which clones the framework
// from the running app when the Electron version is unchanged, and
// downloads Electron otherwise), and swap the two bundles with two
// renames. The app then relaunches, at once: after the swap its own path
// names the new bundle, and a helper process started later would come
// from there. A `.old` bundle is left beside the new one for the running
// process's sake and removed by the next launch (`clean`).
//
// Mac only, and only a packaged app. Elsewhere `check` still answers (the
// site's build against this one) and `install` says why not. <PREFIX>_SITE
// overrides the config's `site` for a test: a URL, or a folder holding
// app/latest.json and the zips.
'use strict';

const { createHash } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

module.exports = function updater({ app, net, config, env, log }) {
  const NAME = config.name;
  const isMac = process.platform === 'darwin';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  /** What this build is: the package.json beside main.js, which
   *  package.mjs writes with the build id and time. Unpackaged, the
   *  shell's own package.json, which names no build. */
  const current = (() => {
    try {
      const { version, build, built } = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
      return {
        version: typeof version === 'string' ? version : null,
        build: app.isPackaged && typeof build === 'string' ? build : null,
        built: app.isPackaged && typeof built === 'string' ? built : null,
      };
    } catch {
      return { version: null, build: null, built: null };
    }
  })();

  /** The bundle this process runs from, <App>.app, on a packaged Mac app;
   *  null anywhere else (a checkout, Windows), where nothing is replaced. */
  const bundle = (() => {
    if (!isMac || !app.isPackaged) return null;
    const candidate = path.resolve(process.execPath, '..', '..', '..');
    return candidate.endsWith('.app') ? candidate : null;
  })();

  const site = () => (env('SITE') || config.site || '').replace(/\/+$/, '');
  const isURL = (where) => /^https?:\/\//.test(where);
  const lastLine = (text) => text.trim().split('\n').filter(Boolean).pop() ?? '';
  const mb = (bytes) => Math.round(bytes / 1048576);
  const summary = (found) => ({
    version: found.version ?? null,
    build: found.build,
    built: found.built ?? null,
    electron: found.electron ?? null,
  });

  function run(file, args) {
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(lastLine(`${stdout ?? ''}${stderr ?? ''}`) || error.message));
        else resolve(`${stdout ?? ''}${stderr ?? ''}`);
      });
    });
  }

  async function fetchText(where, name) {
    if (!isURL(where)) return fsp.readFile(path.join(where, 'app', name), 'utf8');
    const response = await net.fetch(`${where}/app/${name}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`${where}/app/${name} answered ${response.status}.`);
    return response.text();
  }

  /** The zip, to `dest`, reporting bytes so far against the size when the
   *  site says it. */
  async function fetchFile(where, name, dest, onProgress) {
    if (!isURL(where)) {
      await fsp.copyFile(path.join(where, 'app', name), dest);
      return;
    }
    const response = await net.fetch(`${where}/app/${name}`, { cache: 'no-store' });
    if (!response.ok || !response.body) throw new Error(`${where}/app/${name} answered ${response.status}.`);
    const size = Number(response.headers.get('content-length')) || 0;
    const file = fs.createWriteStream(dest);
    let have = 0;
    try {
      for await (const chunk of response.body) {
        have += chunk.length;
        if (!file.write(chunk)) await new Promise((resolve) => file.once('drain', resolve));
        onProgress(have, size);
      }
    } finally {
      await new Promise((resolve) => file.end(resolve));
    }
  }

  async function sha256(file) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  }

  /** A rename, or a copy and a removal when the temp folder is on another
   *  volume. */
  async function move(from, to) {
    try {
      await fsp.rename(from, to);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await run('ditto', [from, to]);
      await fsp.rm(from, { recursive: true, force: true });
    }
  }

  /** The download's complete.sh on the download, with the running bundle
   *  named first as the sibling to clone from; its status file is followed
   *  for the progress line. */
  function complete(target, onStep) {
    return new Promise((resolve, reject) => {
      const status = path.join(os.tmpdir(), `${NAME.toLowerCase()}-update-status-${process.pid}`);
      fs.writeFileSync(status, '');
      const script = path.join(target, 'Contents', 'Resources', 'complete.sh');
      const child = spawn('/bin/bash', [script, target, status, bundle], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (data) => (output += data));
      child.stderr.on('data', (data) => (output += data));
      let shown = '';
      const timer = setInterval(() => {
        let last;
        try {
          last = lastLine(fs.readFileSync(status, 'utf8'));
        } catch {
          return;
        }
        if (!last || last === shown) return;
        shown = last;
        const cut = last.indexOf('|');
        const percent = cut > 0 ? Number(last.slice(0, cut)) : NaN;
        onStep({ text: last.slice(cut + 1), percent: Number.isFinite(percent) ? percent : null });
      }, 300);
      const done = () => {
        clearInterval(timer);
        fs.rmSync(status, { force: true });
      };
      child.on('error', (error) => {
        done();
        reject(error);
      });
      child.on('exit', (code) => {
        done();
        if (code === 0) {
          if (output.trim()) log(`update: ${lastLine(output)}`);
          resolve();
        } else {
          reject(new Error(lastLine(output).replace(/^complete\.sh: /, '') || `complete.sh exited ${code}`));
        }
      });
    });
  }

  async function latest() {
    const where = site();
    if (!where) throw new Error(`${NAME} has no site to check.`);
    let parsed;
    try {
      parsed = JSON.parse(await fetchText(where, 'latest.json'));
    } catch (error) {
      throw new Error(`could not read ${where}/app/latest.json: ${error.message}`);
    }
    if (!parsed || typeof parsed.build !== 'string' || !parsed.build) throw new Error(`${where}/app/latest.json names no build.`);
    return parsed;
  }

  /** {state, current, latest, site}: `current` (this build), `available`,
   *  `development` (a checkout: nothing to replace), `unsupported` (not a
   *  Mac). Throws when the site cannot be read. */
  async function check() {
    const found = await latest();
    const state = !bundle
      ? app.isPackaged
        ? 'unsupported'
        : 'development'
      : found.build === current.build
        ? 'current'
        : 'available';
    return { state, current, latest: summary(found), site: site() };
  }

  let installing = false;

  /** Download, check, complete and swap in the site's build; `progress`
   *  gets {state, text, percent} along the way. Resolves {state: 'ready',
   *  …} once the new bundle is in place, and the caller relaunches. */
  async function install(progress = () => {}) {
    if (installing) throw new Error('an update is already installing.');
    if (!bundle) {
      throw new Error(
        app.isPackaged
          ? `${NAME} updates itself only on a Mac; run the install line again.`
          : 'this is a development build: build or install again instead.',
      );
    }
    installing = true;
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), `${NAME.toLowerCase()}-update-`));
    const incoming = `${bundle}.incoming`;
    try {
      const found = await latest();
      if (found.build === current.build) return { state: 'current', current, latest: summary(found) };
      const zipName = found.zips?.[arch] ?? `${NAME}-${arch}.zip`;
      const zip = path.join(work, zipName);
      progress({ state: 'downloading', text: `Downloading ${NAME}…`, percent: 0 });
      await fetchFile(site(), zipName, zip, (have, size) =>
        progress({
          state: 'downloading',
          text: size ? `Downloading ${NAME} (${mb(have)} of ${mb(size)} MB)…` : `Downloading ${NAME} (${mb(have)} MB)…`,
          percent: size ? Math.round((have * 100) / size) : null,
        }),
      );
      const expected = found.sha256?.[arch];
      if (expected && (await sha256(zip)) !== expected) throw new Error("the download does not match the site's checksum.");
      progress({ state: 'unpacking', text: 'Checking the download…', percent: null });
      await run('ditto', ['-x', '-k', zip, work]);
      const unpacked = path.join(work, `${NAME}.app`);
      if (!fs.existsSync(path.join(unpacked, 'Contents', 'Resources', 'complete.sh'))) throw new Error('the download was incomplete.');
      // Apple silicon runs only signed code; the seal is the app as it ships.
      if (arch === 'arm64') {
        await run('codesign', ['--verify', '--strict', unpacked]).catch(() => {
          throw new Error('the download does not verify.');
        });
      }
      await fsp.rm(incoming, { recursive: true, force: true });
      await move(unpacked, incoming);
      progress({ state: 'completing', text: 'Getting Electron…', percent: null });
      await complete(incoming, (step) => progress({ state: 'completing', ...step }));
      progress({ state: 'installing', text: `Installing ${NAME}…`, percent: null });
      const old = `${bundle}.old`;
      await fsp.rm(old, { recursive: true, force: true });
      await fsp.rename(bundle, old);
      try {
        await fsp.rename(incoming, bundle);
      } catch (error) {
        await fsp.rename(old, bundle).catch(() => {});
        throw error;
      }
      log(`updated ${bundle} to build ${found.build} (was ${current.build ?? 'unknown'})`);
      return { state: 'ready', current, latest: summary(found) };
    } finally {
      installing = false;
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(incoming, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** What an update left beside the bundle: the bundle it replaced (the
   *  process that installed it was running from it) and an unfinished
   *  download. Run at launch. */
  function clean() {
    if (!bundle) return;
    for (const leftover of [`${bundle}.old`, `${bundle}.incoming`]) {
      if (!fs.existsSync(leftover)) continue;
      try {
        fs.rmSync(leftover, { recursive: true, force: true });
        log(`removed ${leftover}`);
      } catch (error) {
        log(`could not remove ${leftover}: ${error.message}`);
      }
    }
  }

  return {
    current,
    bundle,
    get installing() {
      return installing;
    },
    check,
    install,
    clean,
  };
};
