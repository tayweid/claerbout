// A smoke test of a Claerbout app: launch it on a document in a throwaway
// config folder, wait for the page to say it is ready, press its "run"
// control, and check what that wrote beside the document; then check
// that quitting stops the engine (uv). What to look for comes from the
// config's `smoke` section (README.md); without one, the launch and the
// document's title are all that is checked.
//
//   node smoke.mjs --config app/knuth.json browser              # the checkout, Pyodide
//   node smoke.mjs --config app/knuth.json uv                   # the checkout, uv's Python
//   node smoke.mjs --config app/knuth.json uv path/to/Knuth.app # a built app, complete or not
//   node smoke.mjs --config app/knuth.json update path/to/Knuth.app path/to/site
//                                               # an installed app updating itself from a
//                                               # site folder (app/latest.json and the zips)
//
// With one Python in the config, the mode may be left out. The uv run
// installs Python into the throwaway folder (and uv itself into
// ~/.local/bin if the machine has none), as a first launch would.

import { _electron as electron } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const at = args.indexOf('--config');
const configPath = at !== -1 ? args.splice(at, 2)[1] : null;
if (!configPath) {
  console.error('usage: node smoke.mjs --config app.json [browser|uv] [App.app]');
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const pythons = Array.isArray(config.pythons) && config.pythons.length > 0 ? config.pythons : ['uv', 'browser'];
let mode = args[0];
let bundle = args[1];
// The update check: an installed app, and a site folder whose build is
// not the app's. The app runs on the cheaper Python it offers.
const updating = mode === 'update';
const siteDir = updating ? path.resolve(args[2] ?? '') : null;
if (updating) {
  if (!bundle?.endsWith('.app') || !fs.existsSync(path.join(siteDir, 'app', 'latest.json'))) {
    console.error('usage: node smoke.mjs --config app.json update App.app site-folder');
    process.exit(2);
  }
  mode = pythons.includes('browser') ? 'browser' : pythons[0];
}
if (mode && mode.endsWith('.app')) {
  bundle = mode;
  mode = undefined;
}
mode ??= pythons.length === 1 ? pythons[0] : undefined;
if (!pythons.includes(mode)) {
  console.error(`usage: node smoke.mjs --config app.json ${pythons.join('|')} [App.app]`);
  process.exit(2);
}
const smoke = config.smoke ?? {};
const NAME = config.name;
const PREFIX = config.envPrefix;

const work = fs.mkdtempSync(path.join(os.tmpdir(), `${NAME.toLowerCase()}-smoke-${mode}-`));
const doc = path.join(work, 'docs', smoke.document ?? config.defaultDocument ?? 'document.txt');
fs.mkdirSync(path.dirname(doc));
fs.writeFileSync(doc, smoke.text ?? '');
const port = String(5400 + Math.floor(Math.random() * 400));

const env = {
  ...process.env,
  ...(bundle ? {} : { CLAERBOUT_APP: path.resolve(configPath) }),
  [`${PREFIX}_CONFIG_DIR`]: path.join(work, 'config'),
  // The engine's environment goes beside uv's Pythons; a throwaway one here.
  CLAERBOUT_UV_DIR: path.join(work, 'uv-claerbout'),
  [`${PREFIX}_CHOOSE`]: mode,
  [`${PREFIX}_PORT`]: port,
  // Which documents this app has open on which project, for the history
  // view's rewind (history.js): a throwaway folder, not the shared one.
  CLAERBOUT_PRESENCE_DIR: path.join(work, 'presence'),
  ...(updating ? { [`${PREFIX}_SITE`]: siteDir } : {}),
};
const executable = bundle ? path.join(bundle, 'Contents', 'MacOS', NAME) : null;

/** When the process dies before Playwright hears from it, run it plainly
 *  for a moment and report what it did: its status or signal, its output,
 *  and the signatures of what it executes (a process killed at exec on
 *  Apple silicon is an invalid signature). */
function launchFailed(error) {
  const lines = [`launch failed: ${error.message.split('\n')[0]}`];
  if (executable) {
    const run = spawnSync(executable, [], { env, timeout: 8000, encoding: 'utf8' });
    lines.push(`ran ${executable}: status ${run.status}, signal ${run.signal}${run.error ? `, error ${run.error.message}` : ''}`);
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    if (output) lines.push(`output: ${output.split('\n').slice(0, 12).join(' | ')}`);
    const contents = path.join(bundle, 'Contents');
    for (const target of [
      bundle,
      executable,
      path.join(contents, 'MacOS', `${NAME} Electron`),
      path.join(contents, 'Frameworks', 'Electron Framework.framework'),
    ]) {
      const check = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', target], { encoding: 'utf8' });
      lines.push(`codesign ${path.relative(bundle, target) || 'bundle'}: ${check.status === 0 ? 'valid' : (check.stderr || '').trim().split('\n').slice(-2).join(' | ')}`);
    }
    try {
      lines.push(`${NAME}.log: ${fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-6).join(' | ')}`);
    } catch {
      lines.push(`${NAME}.log: not written`);
    }
  }
  const report = `smoke (${NAME}, ${mode}): ${lines.join('\n  ')}`;
  console.error(report);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${report.replace(/\n/g, '%0A')}`);
  process.exit(1);
}

/**
 * A project for the history view's timing (`smoke.historyTiming`): a
 * course of 300 files in 30 week folders and a starter commit on main; a
 * record of `records` commits on claerbout-autosave over some days (timer
 * commits, cell runs writing a notebook, its values and a figure, session
 * opens and closes), its first holding every file; user commits on main of
 * the whole working tree now and then (each tied exactly to the record),
 * and a branch `exercises` whose commits tie to none. Written with git
 * fast-import, so 2,000 commits take a second; the working tree holds the
 * record's tip.
 */
function seedRecord(dir, records, appName) {
  fs.mkdirSync(dir, { recursive: true });
  const quiet = { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'] };
  execFileSync('git', ['init', '-q', '--initial-branch=main', '.'], quiet);
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const week = (w) => `lectures/week-${String(w).padStart(2, '0')}`;
  const body = (name, v) => Array.from({ length: 40 + Math.floor(random() * 80) }, (_, i) => `${name} line ${i} v${v} ${'x'.repeat(Math.floor(random() * 60))}`).join('\n') + '\n';
  const files = new Map();
  for (let w = 1; w <= 30; w++) {
    for (const name of ['notes.py', 'values.json', 'figs/a.svg', 'figs/b.svg', 'figs/c.svg', 'data.csv', 'note.txt', 'README.md', 'solutions.py', 'slides.tex']) files.set(`${week(w)}/${name}`, body(name, 0));
  }
  let stream = '';
  let mark = 0;
  const commit = (ref, when, message, from, changes, author = 'Taylor') => {
    const blobs = changes.map(([file, text]) => {
      mark += 1;
      stream += `blob\nmark :${mark}\ndata ${Buffer.byteLength(text)}\n${text}\n`;
      return [file, mark];
    });
    mark += 1;
    stream += `commit ${ref}\nmark :${mark}\nauthor ${author} <t@example.invalid> ${when} +0000\ncommitter ${author} <t@example.invalid> ${when} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`;
    if (from) stream += `from :${from}\n`;
    for (const [file, blob] of blobs) stream += `M 100644 :${blob} ${file}\n`;
    stream += '\n';
    return mark;
  };
  const now = Math.floor(Date.now() / 1000) - 120;
  const span = Math.max(3, Math.ceil(records / 80)) * 86400;
  const at = (i) => Math.floor(now - span + (span * i) / records);
  let main = commit('refs/heads/main', now - span - 3600, 'Starter files', null, [...files]);
  const onMain = new Map(files);
  let record = commit('refs/heads/claerbout-autosave', at(0), `${appName}: session open`, null, [...files], 'Record');
  let exercises = null;
  for (let i = 1; i < records; i++) {
    const w = 1 + Math.floor(random() * 6) + Math.floor((i / records) * 24);
    const r = random();
    let message = `${appName}: timer`;
    let changes = [[`${week(w)}/notes.py`, body('notes.py', i)]];
    if (r >= 0.45 && r < 0.85) {
      message = `${appName}: cell run [${1 + Math.floor(random() * 9)}]`;
      changes = [...changes, [`${week(w)}/values.json`, body('values', i)], [`${week(w)}/figs/a.svg`, body('svg', i)]];
    } else if (r >= 0.85) {
      message = `${appName}: session ${r < 0.92 ? 'open' : 'close'}`;
      changes = [[`${week(w)}/note.txt`, body('note', i)]];
    }
    for (const [file, text] of changes) files.set(file, text);
    record = commit('refs/heads/claerbout-autosave', at(i), message, record, changes, 'Record');
    if (i % Math.max(10, Math.floor(records / 25)) === 0) {
      const differ = [...files].filter(([file, text]) => onMain.get(file) !== text);
      for (const [file, text] of differ) onMain.set(file, text);
      main = commit('refs/heads/main', at(i) + 30, `Week ${w}: notes`, main, differ);
    }
    if (i % Math.max(25, Math.floor(records / 8)) === 0) exercises = commit('refs/heads/exercises', at(i) + 40, `Exercises for week ${w}`, exercises ?? main, [[`${week(w)}/solutions.py`, body('exercise', i)]]);
  }
  execFileSync('git', ['fast-import', '--quiet'], { ...quiet, input: stream, maxBuffer: 1 << 30 });
  const index = { ...quiet, env: { ...process.env, GIT_INDEX_FILE: path.join(dir, '.git', 'seed-index') } };
  execFileSync('git', ['read-tree', 'claerbout-autosave'], index);
  execFileSync('git', ['checkout-index', '-a', '-f'], index);
  fs.rmSync(path.join(dir, '.git', 'seed-index'));
  execFileSync('git', ['reset', '-q'], quiet);
}

const logPath = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Logs', `${NAME}.log`)
  : path.join(work, 'config', `${NAME}.log`);
// Playwright reports a process that dies at launch as an uncaught error
// in its own machinery, not as a rejection of launch(), so it is caught
// at the process.
process.on('uncaughtException', launchFailed);
process.on('unhandledRejection', (reason) => launchFailed(reason instanceof Error ? reason : new Error(String(reason))));
const app = await electron.launch({
  ...(bundle ? { executablePath: executable, args: [doc] } : { args: [here, doc] }),
  env,
  // A slim app completes itself before Electron starts: allow for
  // Electron's download.
  timeout: 300_000,
});
process.removeAllListeners('uncaughtException');
process.removeAllListeners('unhandledRejection');
// What a failure on a CI runner needs to say, since its log is not always
// readable: the windows, the page, its console, and the app's own log.
const consoleLines = [];
const fail = async (message) => {
  const details = [`windows: ${app.windows().map((window) => window.url()).join(', ') || 'none'}`];
  if (page) {
    details.push(`title: ${await page.title().catch(() => '?')}`);
    details.push(`page text: ${(await page.evaluate(() => document.body?.innerText ?? '').catch(() => '?')).slice(0, 400).replace(/\s+/g, ' ')}`);
  }
  if (consoleLines.length) details.push(`console: ${consoleLines.slice(-8).join(' | ')}`);
  try {
    details.push(`${path.basename(logPath)}: ${fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-8).join(' | ')}`);
  } catch {
    details.push(`${path.basename(logPath)}: not written`);
  }
  const report = `smoke (${NAME}, ${mode}): ${message}\n  ${details.join('\n  ')}`;
  console.error(report);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${report.replace(/\n/g, '%0A')}`);
  await app.close().catch(() => {});
  process.exit(1);
};

// The setup window turns into the document's once the Python is ready.
const deadline = Date.now() + 600_000;
let page = null;
while (!page && Date.now() < deadline) {
  page = app.windows().find((window) => !window.url().includes('setup.html') && window.url() !== 'about:blank') ?? null;
  if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!page) await fail('no document window');
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') consoleLines.push(`${message.type()}: ${message.text()}`);
});
page.on('pageerror', (error) => consoleLines.push(`pageerror: ${error.message}`));
if (smoke.ready) {
  const want = smoke.readyText?.[mode] ?? smoke.readyText ?? null;
  await page
    .waitForFunction(
      ([selector, text]) => {
        const element = document.querySelector(selector);
        return element !== null && (text === null || element.textContent === text);
      },
      [smoke.ready, want],
      { timeout: Math.max(1000, deadline - Date.now()) },
    )
    .catch(() => fail(`the page never became ready (${smoke.ready}${want ? ` = ${want}` : ''})`));
}
const title = await page.title();
// The update test is about the bundle, not the document: a page that
// titles its window its own way (Plass) is not held to the file's name.
if (!updating && title !== path.basename(doc)) await fail(`the document did not open (title: ${title})`);
// A hidden title bar (config.window.titleBarStyle) reaches the page as
// the Window Controls Overlay, and a native one does not (README, the
// config's `window`); the geometry is the lights' room.
if (process.platform === 'darwin') {
  const hidden = ['hidden', 'hiddenInset'].includes(config.window?.titleBarStyle);
  const overlay = await page.evaluate(() => {
    const overlay = navigator.windowControlsOverlay;
    const rect = overlay?.getTitlebarAreaRect?.();
    return { visible: overlay?.visible === true, x: rect?.x ?? 0, height: rect?.height ?? 0 };
  });
  if (overlay.visible !== hidden) await fail(`the title bar is ${hidden ? 'hidden' : 'native'} but the overlay is ${overlay.visible ? '' : 'not '}visible`);
  // The overlay is as tall as the lights' band, 2·y plus the lights
  // themselves, and the lights' size is the OS's: 14 px on macOS 26, 16
  // on a macOS 15 runner (an overlay of 46 at y 15, seen in Knuth's
  // deploy). A page that sets its bar from env(titlebar-area-height) is
  // right under either, so the check allows the OS its lights.
  const lights = config.window?.trafficLightPosition;
  const band = overlay.height - 2 * (lights?.y ?? 0);
  if (hidden && lights && (overlay.x <= lights.x || band < 12 || band > 18)) {
    await fail(`the lights at ${JSON.stringify(lights)} give an overlay of x ${overlay.x}, height ${overlay.height}`);
  }
}

if (!updating) {
  // The `focus` request: a second open of the document (an open-file
  // event, as Finder sends one) puts a new window in front; the first
  // page asks to come forward and is answered {focused: true}, and its
  // window is the focused one again. A runner whose app is not the
  // active one has no focused window at all; that is said, not failed.
  const first = await (await app.browserWindow(page)).evaluate((window) => window.id);
  const opened = app.waitForEvent('window', { timeout: 30_000 });
  await app.evaluate(({ app: electronApp }, file) => electronApp.emit('open-file', { preventDefault() {} }, file), doc);
  const second = await opened;
  const secondWindow = await app.browserWindow(second);
  const secondId = await secondWindow.evaluate((window) => window.id);
  // The new window is shown, and takes the front, once its page has
  // painted: ask only after that, or its show() would undo the answer.
  const focused = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null);
  for (let i = 0; i < 40 && (await focused()) !== secondId; i++) await page.waitForTimeout(250);
  const answered = await page.evaluate(() => window.claerbout.request({ type: 'focus' }));
  if (answered?.focused !== true) await fail(`the focus request was answered ${JSON.stringify(answered)}`);
  const front = await focused();
  if (front === null) console.log(`smoke (${NAME}, ${mode}): no window is focused here (the app is not active); the fronting is not checked`);
  else if (front !== first) await fail(`after the focus request the focused window is ${front}, not the first (${first})`);
  await secondWindow.evaluate((window) => window.close());
  for (let i = 0; i < 40 && !second.isClosed(); i++) await page.waitForTimeout(250);
  if (!second.isClosed()) await fail('the second window did not close');
}

if (updating) {
  // The page asks, as its update button would: the site's build is not
  // this one, the install runs (its steps arrive as events), the bundle
  // on disk becomes the site's build, and the app relaunches into it.
  const stampOf = (app) => JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app', 'package.json'), 'utf8')).build;
  const before = stampOf(bundle);
  const wanted = JSON.parse(fs.readFileSync(path.join(siteDir, 'app', 'latest.json'), 'utf8')).build;
  if (before === wanted) await fail(`the site's build is the installed one (${wanted}); nothing to update to`);
  const checked = await page.evaluate(() => window.claerbout.request({ type: 'update' }));
  if (checked?.state !== 'available' || checked.latest?.build !== wanted) await fail(`the check answered ${JSON.stringify(checked)}`);
  await page.evaluate(() => {
    window.__update = null;
    window.claerbout.on('update', (detail) => { window.__update = detail; });
  });
  const exited = new Promise((resolve) => app.process().once('exit', resolve));
  await page.evaluate(() => window.claerbout.request({ type: 'update', action: 'install' }));
  let last = null;
  const until = Date.now() + 600_000;
  while (Date.now() < until) {
    const seen = await page.evaluate(() => window.__update).catch(() => ({ state: 'gone' }));
    if (seen) last = seen;
    if (last?.state === 'ready' || last?.state === 'failed' || last?.state === 'gone') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (last?.state === 'failed') await fail(`the update failed: ${last.text}`);
  if (!last || last.state === 'gone' && stampOf(bundle) !== wanted) await fail(`no update event arrived (last: ${JSON.stringify(last)})`);
  // The app relaunches itself into the new bundle: the process goes, and a
  // new one appears at the same path, which has the next build.
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 30_000))]);
  const after = stampOf(bundle);
  if (after !== wanted) await fail(`the bundle is build ${after}, not the site's ${wanted}`);
  await new Promise((resolve) => setTimeout(resolve, 6000));
  // macOS may report a path under /private without that prefix.
  const plain = bundle.replace(/^\/private/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const running = `^(/private)?${plain}/Contents/MacOS/`;
  let relaunched = '';
  try {
    relaunched = execFileSync('pgrep', ['-f', running], { encoding: 'utf8' });
  } catch {
    // pgrep exits 1 when nothing matches.
  }
  if (!relaunched.trim()) await fail('the app did not relaunch into the new bundle');
  spawnSync('pkill', ['-f', running]);
  if (fs.existsSync(`${bundle}.old`)) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (fs.existsSync(`${bundle}.old`)) await fail('the relaunched app left the old bundle beside itself');
  }
  // The relaunched app's engine, started in the throwaway folder, may
  // still be going down (it stops once its parent is gone): the folder
  // is removed once it lets go.
  for (let i = 0; i < 15; i++) {
    try {
      fs.rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  console.log(`smoke (${NAME}, update, ${path.basename(bundle)}): ok, build ${before} → ${after}`);
  process.exit(0);
}

if (smoke.run) {
  await page.click(smoke.run);
  if (smoke.written) {
    const written = path.join(path.dirname(doc), smoke.written);
    for (let i = 0; i < 120 && !fs.existsSync(written); i++) await page.waitForTimeout(500);
    if (!fs.existsSync(written)) await fail(`${smoke.run} wrote no ${smoke.written}`);
    const text = fs.readFileSync(written, 'utf8');
    if (smoke.json) {
      const parsed = JSON.parse(text);
      for (const [key, value] of Object.entries(smoke.json)) {
        if (JSON.stringify(parsed[key]) !== JSON.stringify(value)) await fail(`${smoke.written} holds ${text}`);
      }
    }
    if (smoke.contains && !text.includes(smoke.contains)) await fail(`${smoke.written} holds ${text}`);
  }
}

// The autosave record (autosave.js), when the config keeps one: the
// document's folder, in none of anyone's repositories, got one of its own,
// and its claerbout-autosave branch has the commits the config's
// `smoke.autosave` names ("<app>: session open", and for an app whose run
// commits, "<app>: cell run [1]"). The user's side of that repository is
// untouched: HEAD is still unborn; and the record wrote nothing into the
// folder by itself: no untracked/, no .claerbout/, no .gitignore (an
// untracked/ folder is the user's choice, below). Then the history view's
// graph.
if (config.autosave === true && Array.isArray(smoke.autosave) && smoke.autosave.length > 0) {
  const folder = path.dirname(doc);
  const recorded = () => {
    try {
      return execFileSync('git', ['-C', folder, 'log', '--format=%s', 'claerbout-autosave'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  let subjects = [];
  for (let i = 0; i < 120; i++) {
    subjects = recorded();
    if (smoke.autosave.every((wanted) => subjects.some((subject) => subject.includes(wanted)))) break;
    await page.waitForTimeout(500);
  }
  for (const wanted of smoke.autosave) {
    if (!subjects.some((subject) => subject.includes(wanted))) {
      await fail(`the autosave record has no "${wanted}" commit (it has: ${subjects.join(' | ') || 'no branch'})`);
    }
  }
  const head = spawnSync('git', ['-C', folder, 'rev-parse', '--verify', '-q', 'HEAD'], { encoding: 'utf8' });
  if (head.status === 0) await fail(`the autosave record touched the user's HEAD (${head.stdout.trim()})`);
  const strays = ['untracked', '.claerbout', '.gitignore'].filter((name) => fs.existsSync(path.join(folder, name)));
  if (strays.length > 0) await fail(`the autosave record wrote ${strays.join(', ')} into the project by itself`);
  console.log(`smoke (${NAME}, ${mode}): autosave record: ${subjects.join(' | ')}`);

  // The history view (history.js, history/history.html): the shell's own
  // page, served at <scheme>://app/_claerbout/history.html, which asks for
  // its project's graph and gets the record with its session-open commit,
  // and draws it. The document page itself is not given the graph.
  const sessionOpen = `${NAME.toLowerCase()}: session open`;
  const checkGraph = async (graph, where) => {
    const opening = graph?.commits?.find((commit) => commit.line === 'record' && commit.subject === sessionOpen);
    if (graph?.state !== 'on' || !opening || opening.trigger !== 'open' || graph.project?.branch !== 'claerbout-autosave') {
      await fail(`the ${where} History page's graph has no "${sessionOpen}" commit on the record (${JSON.stringify(graph).slice(0, 300)})`);
    }
  };
  const refused = await page.evaluate(() => window.claerbout.request({ type: 'history', action: 'graph' }));
  if (refused !== null) await fail(`a document page was given the graph (${JSON.stringify(refused).slice(0, 80)})`);
  const counted = (graph) => `${graph.commits.length} ${graph.commits.length === 1 ? 'commit' : 'commits'}, tip ${graph.tip.slice(0, 10)}`;

  // Inline, where the config names the page's History tile (`smoke.history`)
  // and the room it opens over (`smoke.room`): the tile has the shell lay
  // the History page over the room's box in the same window, as a
  // WebContentsView at that box in DIP; its page counts the commits; the
  // view follows the room when the window grows (the page's `bounds`); a
  // second `open` changes nothing; Escape in it puts it away, hidden and
  // kept for the next open (one page, never two), and the page hears
  // {kind: 'inline', state: 'closed'}. Then View › History… toggles it (the
  // page asked, `toggle`), the same view shown again, and the page's
  // reload puts it away too.
  if (smoke.history && smoke.room) {
    const host = await app.browserWindow(page);
    const windowId = await host.evaluate((win) => win.id);
    const views = () =>
      host.evaluate((win) =>
        win.contentView.children
          .filter((view) => view.webContents && view.webContents !== win.webContents && !view.webContents.isDestroyed())
          .map((view) => ({ id: view.webContents.id, url: view.webContents.getURL(), bounds: view.getBounds(), visible: view.getVisible() })),
      );
    // The History view up (want) or put away (not want: none visible).
    const historyView = async (want = true) => {
      for (let i = 0; i < 60; i++) {
        const found = (await views()).find((view) => view.visible && view.url.includes('/_claerbout/history.html?inline=1')) ?? null;
        if (want ? found : !(await views()).some((view) => view.visible)) return found;
        await page.waitForTimeout(250);
      }
      return want ? null : (await views()).find((view) => view.visible) ?? { url: '?' };
    };
    const roomInDIP = async () => {
      const zoom = await host.evaluate((win) => win.webContents.getZoomFactor());
      const r = await page.evaluate((selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return { x: box.left, y: box.top, width: box.width, height: box.height };
      }, smoke.room);
      return { x: Math.round(r.x * zoom), y: Math.round(r.y * zoom), width: Math.round(r.width * zoom), height: Math.round(r.height * zoom) };
    };
    const same = (a, b) => ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= 1);
    const inView = (id, code) => app.evaluate(({ webContents }, [viewId, source]) => webContents.fromId(viewId).executeJavaScript(source), [id, code]);
    const inlineStates = () => page.evaluate(() => window.__inline);
    const listen = () =>
      page.evaluate(() => {
        window.__inline = [];
        window.claerbout.on('history', (detail) => {
          if (detail && detail.kind === 'inline') window.__inline.push(detail.state);
        });
      });
    await listen();

    await page.click(smoke.history);
    const view = await historyView();
    if (!view) await fail(`the History tile (${smoke.history}) laid no History view over the room (views: ${JSON.stringify(await views())})`);
    const room = await roomInDIP();
    if (!same(view.bounds, room)) await fail(`the History view is at ${JSON.stringify(view.bounds)}, not the room's ${JSON.stringify(room)}`);
    if (!(await inlineStates()).includes('open')) await fail(`the page did not hear the view open (${JSON.stringify(await inlineStates())})`);
    const graph = await inView(view.id, "window.claerbout.request({ type: 'history', action: 'graph' })");
    await checkGraph(graph, 'inline');
    let drawn = false;
    for (let i = 0; i < 60 && !drawn; i++) {
      drawn = await inView(view.id, "!!document.querySelector('#rows .row.t-open')");
      if (!drawn) await page.waitForTimeout(250);
    }
    if (!drawn) await fail('the inline History page drew no session-open node');
    const layout = await inView(
      view.id,
      "({ inline: document.documentElement.classList.contains('inline'), title: getComputedStyle(document.getElementById('title')).display, rail: getComputedStyle(document.getElementById('rail')).display, close: getComputedStyle(document.getElementById('close')).display, row: document.getElementById('topbar').getBoundingClientRect().height })",
    );
    if (!layout.inline || layout.title !== 'none' || layout.rail !== 'none' || layout.close === 'none' || layout.row !== 44) {
      await fail(`the inline History page is not laid out inline (${JSON.stringify(layout)})`);
    }
    console.log(`smoke (${NAME}, ${mode}): history: ${counted(graph)}, inline at ${view.bounds.x},${view.bounds.y} ${view.bounds.width}×${view.bounds.height}`);

    // A picture of the window with the view over its room, for a person to
    // look at: CLAERBOUT_SMOKE_SHOTS names the folder.
    if (process.env.CLAERBOUT_SMOKE_SHOTS) {
      const shot = path.join(path.resolve(process.env.CLAERBOUT_SMOKE_SHOTS), `${NAME.toLowerCase()}-inline-history.png`);
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      const png = await app.evaluate(async ({ BrowserWindow, webContents, nativeImage }, [windowId, viewId, box]) => {
        const win = BrowserWindow.fromId(windowId);
        const under = await win.webContents.capturePage();
        const over = await webContents.fromId(viewId).capturePage();
        const scale = under.getSize().width / win.getContentSize()[0];
        const { width, height } = under.getSize(scale);
        const base = Buffer.from(under.toBitmap({ scaleFactor: scale }));
        const top = over.toBitmap({ scaleFactor: scale });
        const ow = over.getSize(scale).width, oh = over.getSize(scale).height;
        const ox = Math.round(box.x * scale), oy = Math.round(box.y * scale);
        for (let y = 0; y < oh && oy + y < height; y++) {
          for (let x = 0; x < ow && ox + x < width; x++) {
            const s = (y * ow + x) * 4, d = ((oy + y) * width + ox + x) * 4, a = top[s + 3] / 255;
            for (let c = 0; c < 3; c++) base[d + c] = Math.round(top[s + c] + base[d + c] * (1 - a));
          }
        }
        return nativeImage.createFromBitmap(base, { width, height, scaleFactor: scale }).toPNG().toString('base64');
      }, [windowId, view.id, view.bounds]);
      fs.writeFileSync(shot, Buffer.from(png, 'base64'));
      console.log(`smoke (${NAME}, ${mode}): history: the window with the view over its room, ${shot}`);
    }

    // The room moves with the window, by the page's `bounds`.
    await host.evaluate((win) => {
      const [width, height] = win.getContentSize();
      win.setContentSize(width + 80, height + 60);
    });
    let moved = null;
    for (let i = 0; i < 40; i++) {
      moved = await historyView();
      if (moved && same(moved.bounds, await roomInDIP()) && !same(moved.bounds, view.bounds)) break;
      await page.waitForTimeout(125);
    }
    if (!moved || !same(moved.bounds, await roomInDIP()) || same(moved.bounds, view.bounds)) {
      await fail(`after the window grew the History view is at ${JSON.stringify(moved?.bounds)}, not the room's ${JSON.stringify(await roomInDIP())}`);
    }
    const again = await page.evaluate(async (selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return window.claerbout.request({ type: 'history', action: 'open', inline: { x: box.left, y: box.top, width: box.width, height: box.height } });
    }, smoke.room);
    if (again?.opened !== true || again.inline !== true || (await views()).length !== 1) await fail(`a second open was answered ${JSON.stringify(again)} with ${(await views()).length} views`);

    // Escape in the view puts it away.
    await app.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id);
      contents.focus();
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    }, view.id);
    const left = await historyView(false);
    if (left) await fail(`Escape left a view over the room (${left.url})`);
    for (let i = 0; i < 20 && (await inlineStates()).at(-1) !== 'closed'; i++) await page.waitForTimeout(100);
    if ((await inlineStates()).at(-1) !== 'closed') await fail(`after Escape the page heard ${JSON.stringify(await inlineStates())}, not {kind: 'inline', state: 'closed'}`);
    // Put away, the page is kept for the next open: one, never a second.
    const kept = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL().includes('history.html?inline=1')).map((contents) => contents.id));
    if ((await kept()).join() !== String(view.id)) await fail(`put away, the inline History page is not kept as it was (pages: ${JSON.stringify(await kept())}, the view's ${view.id})`);

    // View › History… toggles it in a document window, and the page's
    // reload takes it away.
    const menuHistory = () =>
      app.evaluate(({ BrowserWindow, Menu }, id) => {
        const win = BrowserWindow.fromId(id);
        const view = Menu.getApplicationMenu().items.find((item) => item.label === 'View');
        view.submenu.items.find((item) => item.label === 'History…').click({}, win, win.webContents);
      }, windowId);
    await menuHistory();
    const shown = await historyView();
    if (!shown) await fail('View › History… laid no History view over the room');
    if (shown.id !== view.id) await fail(`View › History… made a new History view (${shown.id}), not the kept one (${view.id})`);
    await menuHistory();
    if (await historyView(false)) await fail('View › History… a second time left the History view up');
    await menuHistory();
    if (!(await historyView())) await fail('View › History… a third time laid no History view over the room');
    await page.reload();
    if (await historyView(false)) await fail("the page's reload left the History view up");
    if ((await kept()).length !== 1) await fail(`after the page's reload there are ${(await kept()).length} inline History pages, not the one kept`);
    if (smoke.ready) await page.waitForSelector(smoke.ready, { timeout: 30_000 });
    console.log(`smoke (${NAME}, ${mode}): history: inline followed the room, put away on Escape and kept, shown again from View › History…, put away with its page`);
  }

  // Where the run wrote a file, the record is asked to hold it (a notice,
  // as a page sends after a run; nothing is committed if it already does),
  // so the session-open commit's card below offers a rewind.
  const rewinds = Boolean(smoke.run && smoke.written);
  if (rewinds) {
    await page.evaluate(() => window.claerbout.request({ type: 'autosave', trigger: 'smoke' }));
    const holds = () => spawnSync('git', ['-C', folder, 'cat-file', '-e', `claerbout-autosave:${smoke.written}`]).status === 0;
    for (let i = 0; i < 60 && !holds(); i++) await page.waitForTimeout(250);
    if (!holds()) await fail(`the autosave record does not hold ${smoke.written} after a notice`);
  }

  // The History view opened from the document is the document's: the
  // document is changed alone and recorded, the tile pressed, and the
  // switch reads "This document" ("Its folder" left out, the document being
  // at the project's top), the river draws fewer commits than the whole
  // project's, and the session-open commit's card ticks the document
  // alone, its button saying so, with the link that ticks every file.
  // The temporary folder is reached through a link (/var is /private/var),
  // so the fine print saying the document is saved first and reloads is the
  // shell naming documents by their real paths in the project. "Whole
  // project" then ticks every file, and shows the box "Keep an untracked/
  // folder here" (never under "This document"), unchecked: ticked, the
  // folder and the .gitignore line appear; unticked, both are gone. The
  // view, opened once more, is on "This document" again: the switch is not
  // remembered.
  if (rewinds && smoke.history && smoke.room) {
    fs.appendFileSync(doc, 'a second line, recorded alone\n');
    await page.evaluate(() => window.claerbout.request({ type: 'autosave', trigger: 'smoke: the document alone' }));
    const recordedAlone = () => spawnSync('git', ['-C', folder, 'log', '-1', '--format=', '--name-only', 'claerbout-autosave'], { encoding: 'utf8' }).stdout.trim() === path.basename(doc);
    for (let i = 0; i < 60 && !recordedAlone(); i++) await page.waitForTimeout(250);
    if (!recordedAlone()) await fail(`the record's tip does not hold ${path.basename(doc)}'s change alone`);
    // The inline pages shown now (a kept one, put away, is hidden).
    const inlineIds = () =>
      app.evaluate(({ BrowserWindow, webContents }) => {
        const shown = new Set(BrowserWindow.getAllWindows().flatMap((win) => win.contentView.children.filter((view) => view.webContents && view.getVisible()).map((view) => view.webContents.id)));
        return webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && shown.has(contents.id) && contents.getURL().includes('history.html?inline=1')).map((contents) => contents.id);
      });
    const inPage = (id, code) => app.evaluate(({ webContents }, [viewId, source]) => webContents.fromId(viewId).executeJavaScript(source), [id, code]);
    const until = async (id, code, what) => {
      for (let i = 0; i < 60; i++) {
        const value = await inPage(id, code);
        if (value) return value;
        await page.waitForTimeout(250);
      }
      return fail(`the inline History page ${what}`);
    };
    await page.click(smoke.history);
    let id = null;
    for (let i = 0; i < 60 && id === null; i++) {
      id = (await inlineIds())[0] ?? null;
      if (id === null) await page.waitForTimeout(250);
    }
    if (id === null) await fail('the History tile laid no History view over the room a second time');
    await until(id, "!!document.querySelector('#rows .row.t-open')", 'drew no session-open node');
    // The kept page, shown again, has caught up with the record: the commit
    // of the document alone, made while it was put away, is drawn.
    const recordTip = spawnSync('git', ['-C', folder, 'rev-parse', 'claerbout-autosave'], { encoding: 'utf8' }).stdout.trim();
    await until(id, `document.documentElement.dataset.tip === ${JSON.stringify(recordTip)}`, `did not catch up with the record's tip ${recordTip.slice(0, 10)}`);
    const scopeRow = () => inPage(id, "({ hidden: document.getElementById('scope').hidden, on: [...document.querySelectorAll('#scope button.on')].map((b) => b.dataset.s), shown: [...document.querySelectorAll('#scope button')].filter((b) => !b.hidden).map((b) => b.dataset.s), picks: document.querySelectorAll('#rows .row.pick').length, keep: !!document.getElementById('keep') })");
    const opened = await scopeRow();
    if (opened.hidden || opened.on.join() !== 'document' || opened.shown.join() !== 'document,project') await fail(`the scope switch opened as ${JSON.stringify(opened)}, not "This document" of document and project`);
    if (opened.keep) await fail('under "This document" the page shows the untracked/ box, which belongs to the whole project');
    const ticks = () => inPage(id, "({ boxes: Object.fromEntries([...document.querySelectorAll('#card input[data-path]')].map((b) => [b.dataset.path, b.checked])), button: (document.querySelector('#card .rwl') || {}).textContent || '', all: (document.querySelector('#card .lnk[data-act=\"all\"]') || {}).textContent || null, fine: (document.querySelector('#card .rwfine') || {}).textContent || '' })");
    await inPage(id, "document.querySelector('#rows .row.t-open').click()");
    await until(id, "document.querySelectorAll('#card input[data-path]').length >= 2", 'offered no rewind of two files on the session-open card');
    const name = path.basename(doc);
    const mine = await ticks();
    const others = Object.keys(mine.boxes).filter((file) => file !== name);
    if (mine.boxes[name] !== true || others.length === 0 || others.some((file) => mine.boxes[file]) || !mine.button.startsWith('Rewind 1 file') || mine.all !== `all ${others.length + 1} files`) {
      await fail(`under "This document" the card ticks ${JSON.stringify(mine)}, not ${name} alone`);
    }
    if (!mine.fine.includes(`${name} is saved first and reloads`)) await fail(`with ${name} ticked the fine print does not say it is saved first and reloads: ${mine.fine}`);
    // The view alone, with the card open, for a person to look at.
    if (process.env.CLAERBOUT_SMOKE_SHOTS) {
      const shot = path.join(path.resolve(process.env.CLAERBOUT_SMOKE_SHOTS), `${NAME.toLowerCase()}-inline-history-document.png`);
      const png = await app.evaluate(async ({ webContents }, viewId) => (await webContents.fromId(viewId).capturePage()).toPNG().toString('base64'), id);
      fs.writeFileSync(shot, Buffer.from(png, 'base64'));
      console.log(`smoke (${NAME}, ${mode}): history: the view on "This document", ${shot}`);
    }
    await inPage(id, "document.querySelector('#scope button[data-s=\"project\"]').click()");
    const whole = await until(id, "(() => { const b = document.querySelector('#scope button.on'); return b && b.dataset.s === 'project' && document.querySelectorAll('#rows .row.pick').length; })()", 'did not switch to "Whole project"');
    if (whole <= opened.picks) await fail(`the whole project's river draws ${whole} commits, the document's ${opened.picks}: no fewer`);
    await until(id, "document.querySelectorAll('#card input[data-path]').length >= 2", 'lost the session-open card on "Whole project"');
    const every = await ticks();
    if (Object.values(every.boxes).some((ticked) => !ticked) || !every.button.startsWith(`Rewind all ${Object.keys(every.boxes).length} files`) || every.all !== null) {
      await fail(`under "Whole project" the card ticks ${JSON.stringify(every)}, not every file`);
    }
    // The untracked/ box, round trip: ticked, the folder and the line; unticked, gone.
    const box = () => inPage(id, "(() => { const b = document.querySelector('#keep input'); return b ? { checked: b.checked, disabled: b.disabled, label: document.getElementById('keep').textContent } : null; })()");
    const lined = () => {
      try {
        return /^\/untracked\/$/m.test(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8'));
      } catch {
        return false;
      }
    };
    const onDisk = () => ({ folder: fs.existsSync(path.join(folder, 'untracked')), line: lined(), manifest: fs.existsSync(path.join(folder, '.claerbout', 'untracked.json')) });
    const unticked = await box();
    if (!unticked || unticked.checked || unticked.disabled || !unticked.label.startsWith('Keep an untracked/ folder here: large data the record pins by name and hash, never by content')) {
      await fail(`under "Whole project" the untracked/ box is ${JSON.stringify(unticked)}, not unchecked and ready`);
    }
    await inPage(id, "document.querySelector('#keep input').click()");
    await until(id, "(() => { const b = document.querySelector('#keep input'); return b && b.checked && !b.disabled; })()", 'did not show the untracked/ box ticked');
    const ticked = onDisk();
    if (!ticked.folder || !ticked.line || !ticked.manifest) await fail(`ticked, the untracked/ box left ${JSON.stringify(ticked)}`);
    await inPage(id, "document.querySelector('#keep input').click()");
    await until(id, "(() => { const b = document.querySelector('#keep input'); return b && !b.checked && !b.disabled; })()", 'did not show the untracked/ box unticked');
    const untickedOnDisk = onDisk();
    if (untickedOnDisk.folder || untickedOnDisk.line || untickedOnDisk.manifest || fs.existsSync(path.join(folder, '.gitignore')) || fs.existsSync(path.join(folder, '.claerbout'))) {
      await fail(`unticked, the untracked/ box left ${JSON.stringify(untickedOnDisk)}`);
    }
    const close = async () => {
      await inPage(id, "window.claerbout.request({ type: 'history', action: 'close' })");
      for (let i = 0; i < 40 && (await inlineIds()).length > 0; i++) await page.waitForTimeout(100);
      if ((await inlineIds()).length > 0) await fail('the scoped History view did not close');
    };
    await close();
    // Opened again: the document's history, whatever was looked at last.
    await page.click(smoke.history);
    id = null;
    for (let i = 0; i < 60 && id === null; i++) {
      id = (await inlineIds())[0] ?? null;
      if (id === null) await page.waitForTimeout(250);
    }
    if (id === null) await fail('the History tile laid no History view over the room a third time');
    await until(id, "!!document.querySelector('#rows .row.t-open')", 'drew no session-open node when opened again');
    const reopened = await scopeRow();
    if (reopened.on.join() !== 'document') await fail(`opened again, the scope switch is on ${JSON.stringify(reopened.on)}, not "This document"`);
    await close();
    console.log(`smoke (${NAME}, ${mode}): history: opened from ${name}, "This document": ${opened.picks} commits drawn, the card ticks ${name} alone ("${mine.button}", ${mine.all} a click away), and says it is saved first and reloads`);
    console.log(`smoke (${NAME}, ${mode}): history: "Whole project": ${whole} commits drawn, every file ticked ("${every.button}"), the untracked/ box ticked (the folder and the line) and unticked (gone); opened again, "This document"`);
  }

  // The window form: a `history` request without the room's box opens the
  // project's History window.
  const opened = await page.evaluate(() => window.claerbout.request({ type: 'history' }));
  if (opened?.opened !== true) await fail(`the history request was answered ${JSON.stringify(opened)}`);
  let viewer = null;
  for (let i = 0; i < 60 && !viewer; i++) {
    viewer = app.windows().find((window) => window.url().includes('/_claerbout/history.html') && !window.url().includes('inline=1')) ?? null;
    if (!viewer) await page.waitForTimeout(250);
  }
  if (!viewer) await fail('the history request opened no History window');
  const windowGraph = await viewer.evaluate(() => window.claerbout.request({ type: 'history', action: 'graph' }));
  await checkGraph(windowGraph, 'window');
  await viewer.waitForSelector('#rows .row.t-open', { timeout: 15_000 }).catch(() => fail('the History page drew no session-open node'));
  console.log(`smoke (${NAME}, ${mode}): history${smoke.history ? ' (window)' : ''}: ${counted(windowGraph)}`);

  // The session-open commit's card offers the rewind that removes the
  // written file, and its fine print speaks of a kernel's memory only where
  // a kernel runs on the project: a .py or .ipynb open in a window, this
  // app's (the smoke's document) or another app's (a presence file, which
  // is written here where the document is not one).
  if (rewinds) {
    const finePrint = async () => {
      await viewer.click('#rows .row.t-open');
      const fine = await viewer.waitForSelector('#card .rwfine', { timeout: 15_000 }).catch(() => null);
      if (!fine) await fail(`the session-open commit's card offers no rewind (${((await viewer.textContent('#card')) ?? '').slice(0, 200)})`);
      return fine.textContent();
    };
    const cells = (file) => /\.(py|ipynb)$/i.test(file);
    const kernel = (text) => text.includes('kernel’s memory');
    const alone = await finePrint();
    if (kernel(alone) !== cells(doc)) await fail(`with ${path.basename(doc)} open the card's fine print ${kernel(alone) ? 'speaks' : 'does not speak'} of a kernel's memory: ${alone}`);
    if (!cells(doc)) {
      const root = windowGraph.project.root;
      const other = path.join(env.CLAERBOUT_PRESENCE_DIR, 'smoke-other.json');
      fs.mkdirSync(path.dirname(other), { recursive: true });
      fs.writeFileSync(other, JSON.stringify({ app: 'Other', pid: process.pid, root, documents: [path.join(root, 'other.ipynb')] }));
      await viewer.reload();
      await viewer.waitForSelector('#rows .row.t-open', { timeout: 15_000 }).catch(() => fail('the reloaded History page drew no session-open node'));
      const shared = await finePrint();
      fs.rmSync(other, { force: true });
      if (!kernel(shared)) await fail(`with another app's other.ipynb open on the project the card's fine print does not speak of a kernel's memory: ${shared}`);
    }
    console.log(`smoke (${NAME}, ${mode}): history: the rewind's fine print speaks of a kernel's memory ${cells(doc) ? `with ${path.basename(doc)} open` : `only with another app's notebook open`}`);
  }

  // How fast the History view comes, where the config asks
  // (`smoke.historyTiming: {records, first, again}`): a project seeded with
  // that many record commits (a course of 300 files in 30 folders, a user
  // branch beside main), a document of it opened in a window of its own,
  // and the tile pressed: the time from the click to the river drawn (the
  // page's `claerbout:river-painted` mark: the graph answered, the river
  // laid out, the next frame drawn) on the first open, and, put away and
  // pressed again, to the kept page's next frame (`claerbout:shown-painted`).
  // Each is printed, and above its budget in ms fails.
  const timing = smoke.historyTiming;
  if (timing && smoke.history && smoke.room) {
    const seeded = path.join(work, 'seeded');
    seedRecord(seeded, timing.records, NAME.toLowerCase());
    const seededDoc = path.join(seeded, 'lectures', 'week-01', 'note.txt');
    const opening = app.waitForEvent('window', { timeout: 30_000 });
    await app.evaluate(({ app: electronApp }, file) => electronApp.emit('open-file', { preventDefault() {} }, file), seededDoc);
    const timed = await opening;
    if (smoke.ready) await timed.waitForSelector(smoke.ready, { timeout: 30_000 });
    // The record's session open lands, and the shell's look has seen it.
    await timed.waitForTimeout(2500);
    const timedHost = await app.browserWindow(timed);
    const shownView = () =>
      timedHost.evaluate((win) => {
        const view = win.contentView.children.find((child) => child.webContents && child.webContents !== win.webContents && child.getVisible());
        return view ? view.webContents.id : null;
      });
    const markAfter = (id, name, since) =>
      app.evaluate(({ webContents }, [viewId, mark, t]) => webContents.fromId(viewId).executeJavaScript(`(performance.getEntriesByName(${JSON.stringify(mark)}).map((e) => performance.timeOrigin + e.startTime).find((at) => at >= ${t})) ?? null`), [id, name, since]);
    const press = async (mark) => {
      const t0 = await timed.evaluate((selector) => {
        const t = performance.timeOrigin + performance.now();
        document.querySelector(selector).click();
        return t;
      }, smoke.history);
      for (let i = 0; i < 3000; i++) {
        const id = await shownView();
        const at = id === null ? null : await markAfter(id, mark, t0).catch(() => null);
        if (at !== null) return { id, ms: Math.round(at - t0) };
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return fail(`the History view over ${path.basename(seededDoc)} never drew (${mark})`);
    };
    const first = await press('claerbout:river-painted');
    const drawn = await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.querySelectorAll('#rows .row').length"), first.id);
    if (!drawn) await fail('the History view over the seeded project drew no rows');
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("window.claerbout.request({ type: 'history', action: 'close' })"), first.id);
    for (let i = 0; i < 40 && (await shownView()) !== null; i++) await timed.waitForTimeout(50);
    if ((await shownView()) !== null) await fail('the History view over the seeded project was not put away');
    const again = await press('claerbout:shown-painted');
    if (again.id !== first.id) await fail(`opened again, the History view is a new page (${again.id}), not the kept one (${first.id})`);
    console.log(`smoke (${NAME}, ${mode}): history: open to river with ${timing.records} record commits: first ${first.ms} ms (budget ${timing.first}), again ${again.ms} ms (budget ${timing.again})`);
    if (first.ms > timing.first) await fail(`the first open of the History view took ${first.ms} ms, over its budget of ${timing.first}`);
    if (again.ms > timing.again) await fail(`the History view opened again took ${again.ms} ms, over its budget of ${timing.again}`);
    await timedHost.evaluate((win) => win.close());
  }
}

await app.close();
if (mode === 'uv') {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  let engines = '';
  try {
    engines = execFileSync('pgrep', ['-f', `serve --port ${port}`], { encoding: 'utf8' });
  } catch {
    // pgrep exits 1 when nothing matches: the engine is gone.
  }
  if (engines.trim()) {
    console.error(`smoke (${mode}): the engine outlived the app`);
    process.exit(1);
  }
}
fs.rmSync(work, { recursive: true, force: true });
console.log(`smoke (${NAME}, ${mode}${bundle ? `, ${path.basename(bundle)}` : ''}): ok`);
