// The close guard in the real shell, on the fixture app (test/fixture): its
// page reports `unsaved` through the bridge and answers `save` as an app's
// page would, and the sheet (dialog.showMessageBox) is replaced from the
// main process, pressed by label in turn and recorded. A window is closed
// by BrowserWindow.close(), which on macOS is AppKit's performClose:, as
// ⌘W, the red button and File › Close are (a native role's menu item does
// nothing when clicked from script, and a synthesized ⌘W does not reach
// the menu). Checked: a window whose page never reports closes as before;
// an unsaved window's close shows the sheet on that window, Cancel keeps
// it, a second close while the sheet is up asks nothing more, and Don't
// Save closes it; a quiet report is written with
// no sheet and closes; Save asks the page with user activation and closes
// once it saved, and keeps the window when it did not; a report of nothing
// unsaved, and a reload, forget it; a page that does not answer the quiet
// save gets the sheet without Save, and a file changed outside the app
// (`none`) never offers Save; and the quit with two unsaved windows asks
// twice, a second quit while it asks joining it, and a Cancel stops it with
// every window open and the autosave record as it was (no session close,
// and a notice after it still commits); then a quit answered Don't Save
// twice goes through: the app exits and the record closes its session.
//
//   node test/close.mjs
import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.join(here, '..');
const configPath = path.join(here, 'fixture', 'app.json');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claerbout-close-'));
const docs = path.join(work, 'docs');
fs.mkdirSync(docs);
const docAt = (name) => {
  const file = path.join(docs, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${name}\n`);
  return file;
};
const DONT = 'Don’t Save';
const SAVE_WAIT = 3000;

const env = {
  ...process.env,
  CLAERBOUT_APP: configPath,
  FIXTURE_CONFIG_DIR: path.join(work, 'config'),
  FIXTURE_CHOOSE: 'browser',
  // The record's timer stays out of the way: only triggers commit here.
  FIXTURE_AUTOSAVE_INTERVAL: '3600',
  CLAERBOUT_UV_DIR: path.join(work, 'uv-claerbout'),
  CLAERBOUT_PRESENCE_DIR: path.join(work, 'presence'),
};

const app = await electron.launch({ args: [shellDir, docAt('note.txt')], env, timeout: 120_000 });
const exited = new Promise((resolve) => app.process().once('exit', resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fail(message) {
  console.error(`close: ${message}`);
  try {
    const sheets = await app.evaluate(() => globalThis.__sheets ?? []);
    console.error(`  sheets: ${JSON.stringify(sheets).slice(0, 600)}`);
  } catch {
    // The app is gone.
  }
  app.process().kill('SIGKILL');
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(1);
}
const check = (ok, message) => (ok ? Promise.resolve() : fail(message));

/** Until `test()` is true, for at most `ms`. */
async function until(test, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await test()) return true;
    if (Date.now() > deadline) return false;
    await wait(50);
  }
}

// The sheet, replaced: each call recorded (the window it is on, its text and
// buttons) and answered with the next press, by label, after its delay;
// with no press left, Cancel.
await app.evaluate(({ dialog }) => {
  globalThis.__sheets = [];
  globalThis.__presses = [];
  dialog.showMessageBox = async (window, options) => {
    globalThis.__sheets.push({ window: window?.id ?? null, message: options.message, detail: options.detail, buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId });
    const press = globalThis.__presses.shift() ?? { label: null };
    if (press.after) await new Promise((resolve) => setTimeout(resolve, press.after));
    const index = options.buttons.indexOf(press.label);
    return { response: index === -1 ? options.cancelId : index, checkboxChecked: false };
  };
});
const replaced = await app.evaluate(({ dialog }) => String(dialog.showMessageBox).includes('__sheets'));
await check(replaced, 'dialog.showMessageBox could not be replaced from the main process');
const press = (...presses) => app.evaluate((_electron, list) => globalThis.__presses.push(...list), presses.map((p) => (typeof p === 'string' ? { label: p } : p)));
const sheets = () => app.evaluate(() => globalThis.__sheets);
const clearSheets = () => app.evaluate(() => {
  globalThis.__sheets = [];
  globalThis.__presses = [];
});

/** A document window, ready: the launch's, or one opened as Finder would. */
async function ready(page) {
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready', null, { timeout: 30_000 });
  return page;
}
async function firstPage() {
  let page = null;
  await until(() => {
    page = app.windows().find((w) => !w.url().includes('setup.html') && w.url() !== 'about:blank') ?? null;
    return page !== null;
  }, 60_000);
  if (!page) await fail('no document window');
  return ready(page);
}
async function open(name) {
  const opened = app.waitForEvent('window', { timeout: 30_000 });
  await app.evaluate(({ app: electronApp }, file) => electronApp.emit('open-file', { preventDefault() {} }, file), docAt(name));
  return ready(await opened);
}
const idOf = async (page) => (await app.browserWindow(page)).evaluate((window) => window.id);

/** The page answers `save` as `policy` says, per kind (`quiet`: choose
 *  false, `choose`: true): {ok, error?} or 'silent', after `policy.after`
 *  ms (time for the test to read the ask before the window goes). Every
 *  ask is kept, with whether the page had user activation when it heard
 *  it. */
async function answer(page, policy) {
  await page.evaluate((how) => {
    window.__asks = [];
    window.__policy = how;
    if (window.__listening) return;
    window.__listening = true;
    window.claerbout.on('save', (ask) => {
      window.__asks.push({ ...ask, activated: navigator.userActivation.isActive });
      const reply = window.__policy[ask.choose ? 'choose' : 'quiet'];
      if (reply && reply !== 'silent') setTimeout(() => void window.claerbout.request({ type: 'saved', id: ask.id, ...reply }), window.__policy.after ?? 0);
    });
  }, policy);
}
const asks = (page) => page.evaluate(() => window.__asks ?? []);
async function report(page, message) {
  const reply = await page.evaluate((m) => window.claerbout.request({ type: 'unsaved', ...m }), message);
  await check(reply?.guarded === true, `the unsaved report was answered ${JSON.stringify(reply)}`);
}
/** Close the page's window as ⌘W does (see above). */
async function close(page) {
  const id = await idOf(page);
  await app.evaluate(({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId).close(), id);
  return id;
}
const closes = (page, ms = 8000) => until(() => page.isClosed(), ms);
const stays = async (page, ms = 600) => !(await until(() => page.isClosed(), ms));

const sayings = [];
const said = (line) => {
  sayings.push(line);
  console.log(`close: ${line}`);
};

// A page that never reports closes as before, with no sheet.
const first = await firstPage();
const never = await open('never.txt');
await close(never);
await check(await closes(never), 'a window whose page never reported did not close');
await check((await sheets()).length === 0, 'a window whose page never reported showed a sheet');
said('a page that never reports closes as before, no sheet');

// Unsaved, `choose` (a document with no file yet): the sheet on its window.
await answer(first, { quiet: { ok: true }, choose: { ok: true } });
await report(first, { unsaved: true, name: 'note.txt', save: 'choose' });
await press('Cancel');
const firstId = await close(first);
await check(await until(async () => (await sheets()).length === 1), 'closing an unsaved window showed no sheet');
const [sheet] = await sheets();
await check(sheet.window === firstId, `the sheet is on window ${sheet.window}, not the closing one (${firstId})`);
await check(sheet.message === 'Do you want to save the changes you made to “note.txt”?', `the sheet says ${sheet.message}`);
await check(sheet.detail === 'Your changes will be lost if you don’t save them.', `the sheet's detail is ${sheet.detail}`);
await check(JSON.stringify(sheet.buttons) === JSON.stringify(['Save…', DONT, 'Cancel']) && sheet.defaultId === 0 && sheet.cancelId === 2, `the sheet's buttons are ${JSON.stringify(sheet)}`);
await check(await stays(first), 'Cancel closed the window');
await check((await asks(first)).length === 0, `a choose report was asked to save before the sheet: ${JSON.stringify(await asks(first))}`);
said('unsaved (choose): the sheet on its window, Save… / Don’t Save / Cancel; Cancel keeps it, nothing written');

// Closed again, and again while the sheet is up: one sheet.
await clearSheets();
await press({ label: 'Cancel', after: 800 });
await close(first);
await check(await until(async () => (await sheets()).length === 1), 'a second close of an unsaved window showed no sheet');
await close(first);
await wait(1200);
await check((await sheets()).length === 1, `a second close while the sheet was up showed ${(await sheets()).length} sheets`);
await check(await stays(first), 'Cancel closed the window the second time');
said('closed again: the same sheet; a second close while it is up asks nothing more');

// Don't Save closes it.
await clearSheets();
await press(DONT);
await close(first);
await check(await closes(first), "Don't Save left the window open");
await check((await sheets()).length === 1, `Don't Save took ${(await sheets()).length} sheets`);
said('Don’t Save closes it');

// Quiet: written without asking, and closes with no sheet.
await clearSheets();
const quiet = await open('quiet.txt');
await answer(quiet, { quiet: { ok: true }, after: 600 });
await report(quiet, { unsaved: true, name: 'quiet.txt', save: 'quiet' });
await close(quiet);
let quietAsks = [];
await until(async () => (quietAsks = await asks(quiet).catch(() => quietAsks)).length > 0 || quiet.isClosed());
await check(await closes(quiet), 'a quiet window that saved did not close');
await check(quietAsks.length === 1 && quietAsks[0].reason === 'close' && quietAsks[0].choose === false, `the quiet window was asked ${JSON.stringify(quietAsks)}`);
await check((await sheets()).length === 0, 'a quiet window that saved showed a sheet');
said('quiet: asked save {reason: close, choose: false}, saved, closed with no sheet');

// Save: the page asked with choose and user activation; closes once saved.
await clearSheets();
const saving = await open('saving.txt');
await answer(saving, { choose: { ok: true }, after: 600 });
await report(saving, { unsaved: true, name: 'saving.txt', save: 'choose' });
await press('Save…');
await close(saving);
let savingAsks = [];
await until(async () => (savingAsks = await asks(saving).catch(() => savingAsks)).length > 0 || saving.isClosed());
await check(await closes(saving), 'Save, answered ok, left the window open');
await check(savingAsks.length === 1 && savingAsks[0].reason === 'close' && savingAsks[0].choose === true, `Save asked ${JSON.stringify(savingAsks)}`);
await check(savingAsks[0].activated === true, 'the page had no user activation when Save asked it (it could not open a picker)');
said('Save: asked save {reason: close, choose: true} with user activation, saved, closed');

// Save refused: kept open. Then a report of nothing unsaved: closes freely.
await clearSheets();
const refusing = await open('refusing.txt');
await answer(refusing, { choose: { ok: false, error: 'the picker was closed' } });
await report(refusing, { unsaved: true, name: 'refusing.txt', save: 'choose' });
await press('Save…');
await close(refusing);
await check(await until(async () => (await asks(refusing)).length === 1), 'Save did not ask the page');
await check(await stays(refusing), 'Save, answered ok: false, closed the window');
await report(refusing, { unsaved: false, name: 'refusing.txt', save: 'quiet' });
await close(refusing);
await check(await closes(refusing), 'after unsaved: false the window did not close');
await check((await sheets()).length === 1, 'after unsaved: false the close showed a sheet');
said('Save refused (ok: false) keeps the window; unsaved: false then closes it freely');

// A page that does not answer the quiet save: the sheet without Save.
await clearSheets();
const silent = await open('silent.txt');
await answer(silent, { quiet: 'silent' });
await report(silent, { unsaved: true, name: 'silent.txt', save: 'quiet' });
await press('Cancel', DONT);
await close(silent);
await check(await until(async () => (await sheets()).length === 1, SAVE_WAIT + 4000), 'a page that did not answer the quiet save got no sheet');
await check(JSON.stringify((await sheets())[0].buttons) === JSON.stringify([DONT, 'Cancel']), `the sheet for a silent page has ${JSON.stringify((await sheets())[0].buttons)}`);
await check(await stays(silent), 'Cancel closed the silent window');
await close(silent);
await check(await closes(silent, SAVE_WAIT + 4000), "Don't Save left the silent window open");
said('a page that does not answer the quiet save: after 3 s, the sheet with only Don’t Save and Cancel');

// A file changed outside the app (`none`): never offered Save, nothing written.
await clearSheets();
const changed = await open('changed.txt');
await answer(changed, { quiet: { ok: true }, choose: { ok: true } });
await report(changed, { unsaved: true, name: 'changed.txt', save: 'none', detail: 'changed.txt changed on disk.' });
await press(DONT);
await close(changed);
await check(await closes(changed), "Don't Save left the `none` window open");
const [noneSheet] = await sheets();
await check(JSON.stringify(noneSheet?.buttons) === JSON.stringify([DONT, 'Cancel']) && noneSheet.defaultId === 1 && noneSheet.detail === 'changed.txt changed on disk.', `the none sheet is ${JSON.stringify(noneSheet)}`);
said('none: the sheet offers no Save (Cancel the default) and shows the page’s detail');

// A reload forgets the report: the reloaded page reports again, or not.
await clearSheets();
const reloading = await open('reloading.txt');
await report(reloading, { unsaved: true, name: 'reloading.txt', save: 'choose' });
await reloading.reload();
await ready(reloading);
await close(reloading);
await check(await closes(reloading), 'a reloaded page that had not reported again did not close');
await check((await sheets()).length === 0, 'a reloaded page that had not reported again showed a sheet');
said('a reload forgets the report');

// The quit: two unsaved windows and a clean one. A record that a quit would
// close (the document changed on disk), and the quit Cancelled on the second.
await clearSheets();
const record = () => execFileSync('git', ['-C', docs, 'log', '--format=%s', 'claerbout-autosave'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const one = await open('one.txt');
const two = await open('two.txt');
const clean = await open('clean.txt');
// The record goes quiet before anything is compared: the last window's
// session close and these windows' session open land in their own time.
let quietSince = Date.now();
let last = JSON.stringify(record());
await check(
  await until(() => {
    const now = JSON.stringify(record());
    if (now !== last) {
      last = now;
      quietSince = Date.now();
    }
    return Date.now() - quietSince > 2000 && record().includes('fixture: session open');
  }, 20_000),
  'the record did not go quiet',
);
for (const page of [one, two]) await answer(page, { quiet: { ok: true }, choose: { ok: true } });
await report(one, { unsaved: true, name: 'one.txt', save: 'choose' });
await report(two, { unsaved: true, name: 'two.txt', save: 'choose' });
fs.appendFileSync(path.join(docs, 'one.txt'), 'changed before the quit\n');
const before = record();
await press({ label: DONT, after: 400 }, { label: 'Cancel', after: 400 });
await app.evaluate(({ app: electronApp }) => {
  setTimeout(() => electronApp.quit(), 0);
  // ⌘Q again while the first sheet is up: joins the quit, asks nothing more.
  setTimeout(() => electronApp.quit(), 150);
});
await check(await until(async () => (await sheets()).length === 2), `the quit showed ${(await sheets()).length} sheets, not one for each unsaved window`);
await wait(1500);
const quitSheets = await sheets();
await check(quitSheets.length === 2, `the quit (with a second ⌘Q) showed ${quitSheets.length} sheets`);
const asked = quitSheets.map((s) => s.message).sort();
await check(asked[0].includes('“one.txt”') && asked[1].includes('“two.txt”'), `the quit asked about ${JSON.stringify(asked)}`);
for (const page of [one, two, clean]) await check(!page.isClosed(), 'a window closed although the quit was cancelled');
await check((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 3, 'the cancelled quit closed windows');
await check(JSON.stringify(record()) === JSON.stringify(before), `the cancelled quit touched the record: ${record().slice(0, 3).join(' | ')}`);
fs.appendFileSync(path.join(docs, 'two.txt'), 'changed after the cancelled quit\n');
await one.evaluate(() => window.claerbout.request({ type: 'autosave', trigger: 'after the cancelled quit' }));
await check(await until(() => record()[0] === 'fixture: after the cancelled quit'), `after the cancelled quit a notice did not commit (the record: ${record().slice(0, 3).join(' | ')})`);
said('quit with two unsaved windows: two sheets, a second ⌘Q joins; Cancel stops it, every window open, the record untouched and still recording');

// The quit, Don't Save twice: it goes through, and the record closes its
// session on the way out.
await clearSheets();
fs.appendFileSync(path.join(docs, 'one.txt'), 'changed before the second quit\n');
await press({ label: DONT, after: 500 }, { label: DONT, after: 500 });
await app.evaluate(({ app: electronApp }) => setTimeout(() => electronApp.quit(), 0));
// The sheets are counted while the app is still there to ask.
let shown = 0;
const counting = (async () => {
  for (;;) {
    const count = await sheets().then((list) => list.length).catch(() => null);
    if (count === null) return;
    shown = Math.max(shown, count);
    await wait(100);
  }
})();
const gone = await Promise.race([exited.then(() => true), wait(30_000).then(() => false)]);
await counting;
if (!gone) await fail('the quit answered Don’t Save twice did not end the app');
if (shown !== 2) await fail(`the quit that went through showed ${shown} sheets, not two`);
await check(record()[0] === 'fixture: session close', `after the quit the record's tip is ${record()[0]}, not a session close`);
said('quit, Don’t Save twice: the app exits, and the record closes its session');

fs.rmSync(work, { recursive: true, force: true });
console.log(`close: ok (${sayings.length} checks)`);
