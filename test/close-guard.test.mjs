// The close guard's decisions (close-guard.js), with the I/O faked: what a
// page's `unsaved` report is taken as; the sheet for each kind of save
// (quiet, choose, none, a label and a detail of the page's own, a page that
// did not answer); one window's close settled every way (saved quietly with
// no sheet, a quiet save refused or unanswered and then asked, Save that
// saves or does not and is given activation first, a hung page that takes
// no activation, Don't Save, Cancel, a report gone or changed meanwhile, a
// sheet that throws); the window's
// 'close' event (held, passed once released, waited while a settle runs,
// passed once the quit is decided); one settle per window; and the quit
// (each window in turn, a Cancel stopping it before anything else happens,
// a second quit joining the first, a relaunch asked for meanwhile making
// it one, a window that reports during the quit asked too, a window closed
// while it is asked not stopping it, and nothing to ask going straight on).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Guard, settle, readReport, dialogFor, DONT_SAVE, LOST, SILENT } = require('../close-guard.js');

/** Fake I/O for one window: `answers` are what the sheet's buttons are
 *  pressed, by label, in turn; `quiet` and `chosen` what the page answers
 *  the two save asks (a function of the ask's number, or a value). The
 *  calls are kept in order. */
function fakeIO({ answers = [], quiet = { answered: true, ok: true }, chosen = { answered: true, ok: true }, current = undefined } = {}) {
  const calls = [];
  const sheets = [];
  const lines = [];
  const io = {
    calls,
    sheets,
    lines,
    quietSave: async () => {
      calls.push('quiet');
      return typeof quiet === 'function' ? quiet() : quiet;
    },
    ask: async (spec) => {
      calls.push('ask');
      sheets.push(spec);
      const label = answers.shift();
      const index = spec.buttons.indexOf(label);
      assert.notEqual(index, -1, `the sheet has no ${label} (it has ${spec.buttons.join(', ')})`);
      return index;
    },
    activate: async () => {
      calls.push('activate');
      return true;
    },
    chooseSave: async () => {
      calls.push('choose');
      return typeof chosen === 'function' ? chosen() : chosen;
    },
    log: (line) => lines.push(line),
  };
  if (current !== undefined) io.current = current;
  return io;
}

const report = (save, extra = {}) => ({ type: 'unsaved', unsaved: true, name: 'Notes.md', save, ...extra });

test('a report: unsaved true is kept, anything else is nothing to guard', () => {
  assert.deepEqual(readReport(report('quiet')), { name: 'Notes.md', save: 'quiet', label: null, detail: null });
  assert.equal(readReport({ unsaved: false, name: 'Notes.md', save: 'quiet' }), null);
  assert.equal(readReport({ unsaved: 'yes', name: 'Notes.md' }), null);
  assert.equal(readReport(null), null);
  assert.equal(readReport(undefined), null);
  // An unknown save is `choose`, which writes nowhere the user did not pick;
  // a missing name is Untitled; long text is cut to what a sheet can show.
  const odd = readReport({ unsaved: true, save: 'overwrite', name: '  ', label: 'x'.repeat(200), detail: 7 });
  assert.equal(odd.save, 'choose');
  assert.equal(odd.name, 'Untitled');
  assert.equal(odd.label.length, 64);
  assert.equal(odd.detail, null);
  assert.equal(readReport(report('none', { label: ' Save to a Folder… ', detail: ' Moved. ' })).label, 'Save to a Folder…');
});

test('the sheet: Save (or Save…, or the page\'s label), Don\'t Save, Cancel; Save the default, Cancel the cancel', () => {
  const choose = dialogFor(readReport(report('choose')));
  assert.equal(choose.message, 'Do you want to save the changes you made to “Notes.md”?');
  assert.equal(choose.detail, LOST);
  assert.deepEqual(choose.buttons, ['Save…', DONT_SAVE, 'Cancel']);
  assert.deepEqual(choose.actions, ['save', 'discard', 'cancel']);
  assert.equal(choose.defaultId, 0);
  assert.equal(choose.cancelId, 2);
  assert.deepEqual(dialogFor(readReport(report('quiet'))).buttons, ['Save', DONT_SAVE, 'Cancel']);
  const labelled = dialogFor(readReport(report('choose', { label: 'Save to a Folder…', detail: '“Notes.md” was moved or deleted.' })));
  assert.deepEqual(labelled.buttons, ['Save to a Folder…', DONT_SAVE, 'Cancel']);
  assert.equal(labelled.detail, '“Notes.md” was moved or deleted.');
});

test('the sheet without Save: a file changed outside the app, or a page that did not answer; Cancel is then the default', () => {
  const none = dialogFor(readReport(report('none', { detail: 'It changed on disk.' })));
  assert.deepEqual(none.buttons, [DONT_SAVE, 'Cancel']);
  assert.deepEqual(none.actions, ['discard', 'cancel']);
  assert.equal(none.defaultId, 1);
  assert.equal(none.cancelId, 1);
  assert.equal(none.detail, 'It changed on disk.');
  const silent = dialogFor(readReport(report('quiet')), { silent: true });
  assert.deepEqual(silent.buttons, [DONT_SAVE, 'Cancel']);
  assert.equal(silent.detail, SILENT);
  assert.equal(silent.defaultId, 1);
});

test('nothing unsaved: closes, nothing asked', async () => {
  const io = fakeIO({ current: () => null });
  assert.equal(await settle(io), 'close');
  assert.deepEqual(io.calls, []);
});

test('quiet: written without asking, and closes with no sheet', async () => {
  const io = fakeIO({ current: () => readReport(report('quiet')) });
  assert.equal(await settle(io), 'close');
  assert.deepEqual(io.calls, ['quiet']);
  assert.match(io.lines.join('\n'), /saved without asking/);
});

test('quiet, refused: the sheet with Save; Save asks again with activation, and closes once saved', async () => {
  const io = fakeIO({ current: () => readReport(report('quiet')), quiet: { answered: true, ok: false, error: 'it changed on disk' }, answers: ['Save'] });
  assert.equal(await settle(io), 'close');
  assert.deepEqual(io.calls, ['quiet', 'ask', 'activate', 'choose']);
  assert.deepEqual(io.sheets[0].buttons, ['Save', DONT_SAVE, 'Cancel']);
  assert.match(io.lines[0], /it changed on disk/);
});

test('quiet, refused, and the page says more meanwhile: the sheet is for what it says now', async () => {
  let now = readReport(report('quiet'));
  const io = fakeIO({
    current: () => now,
    quiet: () => {
      now = readReport(report('choose', { label: 'Save to a Folder…', detail: 'The file was moved or deleted.' }));
      return { answered: true, ok: false, error: 'the file is gone' };
    },
    answers: ['Cancel'],
  });
  assert.equal(await settle(io), 'keep');
  assert.deepEqual(io.sheets[0].buttons, ['Save to a Folder…', DONT_SAVE, 'Cancel']);
  assert.equal(io.sheets[0].detail, 'The file was moved or deleted.');
});

test('quiet, and the page saved meanwhile (it reports nothing unsaved): closes with no sheet', async () => {
  let now = readReport(report('quiet'));
  const io = fakeIO({
    current: () => now,
    quiet: () => {
      now = null;
      return { answered: true, ok: false };
    },
  });
  assert.equal(await settle(io), 'close');
  assert.deepEqual(io.calls, ['quiet']);
});

test('quiet, unanswered: the sheet offers only Don\'t Save and Cancel', async () => {
  const discard = fakeIO({ current: () => readReport(report('quiet')), quiet: { answered: false }, answers: [DONT_SAVE] });
  assert.equal(await settle(discard), 'close');
  assert.deepEqual(discard.sheets[0].buttons, [DONT_SAVE, 'Cancel']);
  assert.deepEqual(discard.calls, ['quiet', 'ask']);
  const cancel = fakeIO({ current: () => readReport(report('quiet')), quiet: { answered: false }, answers: ['Cancel'] });
  assert.equal(await settle(cancel), 'keep');
});

test('choose: no quiet save; Save gives the page activation and closes only once it saved', async () => {
  const saved = fakeIO({ current: () => readReport(report('choose')), answers: ['Save…'] });
  assert.equal(await settle(saved), 'close');
  assert.deepEqual(saved.calls, ['ask', 'activate', 'choose']);
  const refused = fakeIO({ current: () => readReport(report('choose')), answers: ['Save…'], chosen: { answered: true, ok: false, error: 'the picker was closed' } });
  assert.equal(await settle(refused), 'keep');
  assert.match(refused.lines.at(-1), /kept open: not saved \(the picker was closed\)/);
  const gone = fakeIO({ current: () => readReport(report('choose')), answers: ['Save…'], chosen: { answered: false } });
  assert.equal(await settle(gone), 'keep');
});

test('Save on a page that does not take activation (hung): kept, and never asked a save it could not answer', async () => {
  const io = fakeIO({ current: () => readReport(report('choose')), answers: ['Save…'] });
  io.activate = async () => {
    io.calls.push('activate');
    return false;
  };
  assert.equal(await settle(io), 'keep');
  assert.deepEqual(io.calls, ['ask', 'activate']);
  assert.match(io.lines.at(-1), /kept open: the page did not answer/);
});

test('Don\'t Save closes and Cancel keeps, whatever the save', async () => {
  for (const save of ['choose', 'none']) {
    const discard = fakeIO({ current: () => readReport(report(save)), answers: [DONT_SAVE] });
    assert.equal(await settle(discard), 'close');
    assert.deepEqual(discard.calls, ['ask']);
    const cancel = fakeIO({ current: () => readReport(report(save)), answers: ['Cancel'] });
    assert.equal(await settle(cancel), 'keep');
    assert.deepEqual(cancel.calls, ['ask']);
  }
});

test('none: the sheet never offers Save, and nothing is written', async () => {
  const io = fakeIO({ current: () => readReport(report('none')), answers: [DONT_SAVE] });
  assert.equal(await settle(io), 'close');
  assert.deepEqual(io.sheets[0].buttons, [DONT_SAVE, 'Cancel']);
  assert.ok(!io.calls.includes('quiet') && !io.calls.includes('choose'));
});

test('a sheet answered with an index past its buttons is Cancel', async () => {
  const io = fakeIO({ current: () => readReport(report('choose')) });
  io.ask = async () => 9;
  assert.equal(await settle(io), 'keep');
});

test('the close event: held while unsaved, passed once released (once), waited while settling, passed once the quit is decided', async () => {
  const guard = new Guard();
  const w = { id: 1 };
  assert.equal(guard.onClose(w), 'pass');
  assert.deepEqual(guard.report(w, report('choose')), readReport(report('choose')));
  assert.equal(guard.onClose(w), 'hold');
  guard.release(w);
  assert.equal(guard.onClose(w), 'pass');
  assert.equal(guard.onClose(w), 'hold', 'a release is spent by one close');
  // A report of nothing unsaved forgets it.
  assert.equal(guard.report(w, { unsaved: false }), null);
  assert.equal(guard.onClose(w), 'pass');
  guard.report(w, report('choose'));
  guard.release(w);
  guard.forget(w);
  assert.equal(guard.onClose(w), 'pass', 'forgotten: nothing to hold');
  assert.deepEqual(guard.waiting(), []);
  // While a settle runs, a second close waits for it.
  guard.report(w, report('choose'));
  let press;
  const io = fakeIO();
  io.ask = (spec) => new Promise((resolve) => (press = () => resolve(spec.buttons.indexOf('Cancel'))));
  const settling = guard.settle(w, io);
  assert.equal(guard.onClose(w), 'wait');
  assert.equal(guard.settle(w, fakeIO()), settling, 'one settle per window: a second ask joins it');
  await new Promise((resolve) => setImmediate(resolve));
  press();
  assert.equal(await settling, 'keep');
  assert.equal(guard.onClose(w), 'hold', 'settled, it is held again');
  guard.quitAllowed = true;
  assert.equal(guard.onClose(w), 'pass');
});

test('a settle that throws keeps the window, and says so', async () => {
  const lines = [];
  const guard = new Guard({ log: (line) => lines.push(line) });
  const w = {};
  guard.report(w, report('choose'));
  const io = fakeIO();
  io.ask = async () => {
    throw new Error('no sheet');
  };
  assert.equal(await guard.settle(w, io), 'keep');
  assert.match(lines.join('\n'), /could not settle a window: no sheet/);
  assert.equal(guard.settling.size, 0);
});

/** A quit's fakes: windows by name, each with its own I/O. */
function quitFixture(plan) {
  const guard = new Guard();
  const windows = Object.keys(plan).map((name) => ({ name }));
  const ios = new Map(windows.map((w) => [w, fakeIO(plan[w.name].io)]));
  for (const w of windows) if (plan[w.name].report) guard.report(w, report(plan[w.name].report, { name: `${w.name}.md` }));
  const proceeded = [];
  const run = (relaunch = false) => guard.quit({ windows: () => windows, ioFor: (w) => ios.get(w), proceed: (how) => proceeded.push(how), relaunch });
  return { guard, windows, ios, proceeded, run };
}

test('the quit asks each window in turn and goes on once all are settled', async () => {
  const { guard, windows, ios, proceeded, run } = quitFixture({
    a: { report: 'choose', io: { answers: [DONT_SAVE] } },
    clean: {},
    b: { report: 'quiet' },
    c: { report: 'none', io: { answers: [DONT_SAVE] } },
  });
  assert.equal(await run(), true);
  assert.deepEqual(proceeded, [{ relaunch: false }]);
  assert.equal(guard.quitAllowed, true);
  assert.deepEqual(ios.get(windows[0]).calls, ['ask']);
  assert.deepEqual(ios.get(windows[1]).calls, [], 'a window with nothing unsaved is not asked');
  assert.deepEqual(ios.get(windows[2]).calls, ['quiet']);
  assert.deepEqual(ios.get(windows[3]).calls, ['ask']);
  for (const w of windows) assert.equal(guard.onClose(w), 'pass');
});

test('a Cancel stops the quit: nothing goes on, the windows after it are not asked, and every window is guarded as before', async () => {
  const { guard, windows, ios, proceeded, run } = quitFixture({
    a: { report: 'choose', io: { answers: [DONT_SAVE] } },
    b: { report: 'choose', io: { answers: ['Cancel'] } },
    c: { report: 'choose', io: { answers: [DONT_SAVE] } },
  });
  assert.equal(await run(), false);
  assert.deepEqual(proceeded, []);
  assert.equal(guard.quitAllowed, false);
  assert.equal(guard.quitRun, null);
  assert.deepEqual(ios.get(windows[2]).calls, []);
  // A's Don't Save was for a quit that did not happen: it is asked again.
  for (const w of windows) assert.equal(guard.onClose(w), 'hold');
});

test('a second quit while one is asking joins it, and a relaunch asked for meanwhile makes it one', async () => {
  const guard = new Guard();
  const w = {};
  guard.report(w, report('choose'));
  let press;
  const io = fakeIO();
  io.ask = (spec) => new Promise((resolve) => (press = () => resolve(spec.buttons.indexOf(DONT_SAVE))));
  const proceeded = [];
  const args = { windows: () => [w], ioFor: () => io, proceed: (how) => proceeded.push(how) };
  const first = guard.quit(args);
  assert.equal(guard.quit(args), first, 'a second quit joins the first');
  assert.equal(guard.quit({ ...args, relaunch: true }), first);
  for (let i = 0; i < 5 && !press; i++) await new Promise((resolve) => setImmediate(resolve));
  press();
  assert.equal(await first, true);
  assert.deepEqual(proceeded, [{ relaunch: true }], 'it went on once, as a relaunch');
});

test('a window that reports during the quit is asked too; one settled is not asked twice', async () => {
  const guard = new Guard();
  const a = { name: 'a' };
  const late = { name: 'late' };
  guard.report(a, report('choose'));
  const ioA = fakeIO({ answers: [DONT_SAVE] });
  const ioLate = fakeIO({ answers: [DONT_SAVE] });
  const ask = ioA.ask;
  ioA.ask = async (spec) => {
    // While A's sheet is up, another window says it has unsaved work, and A
    // says so again.
    guard.report(late, report('choose', { name: 'late.md' }));
    guard.report(a, report('choose'));
    return ask(spec);
  };
  const proceeded = [];
  const went = await guard.quit({ windows: () => [a, late], ioFor: (w) => (w === a ? ioA : ioLate), proceed: (how) => proceeded.push(how) });
  assert.equal(went, true);
  assert.deepEqual(ioA.calls, ['ask']);
  assert.deepEqual(ioLate.calls, ['ask']);
  assert.equal(proceeded.length, 1);
});

test('a window closed while the quit asks it does not stop the quit', async () => {
  const guard = new Guard();
  const a = { name: 'a', destroyed: false };
  const b = { name: 'b', destroyed: false };
  guard.report(a, report('choose'));
  guard.report(b, report('choose'));
  const ioA = fakeIO();
  // A's sheet never gets an answer from the user: its window goes (and with
  // it its report), and the sheet comes back as Cancel.
  ioA.ask = async (spec) => {
    a.destroyed = true;
    guard.forget(a);
    return spec.cancelId;
  };
  const ioB = fakeIO({ answers: [DONT_SAVE] });
  const proceeded = [];
  const went = await guard.quit({ windows: () => [a, b].filter((w) => !w.destroyed && guard.reports.has(w)), ioFor: (w) => (w === a ? ioA : ioB), gone: (w) => w.destroyed, proceed: (how) => proceeded.push(how) });
  assert.equal(went, true);
  assert.deepEqual(ioB.calls, ['ask']);
  assert.equal(proceeded.length, 1);
});

test('a quit with nothing unsaved goes straight on, but never inside its caller', async () => {
  const guard = new Guard();
  const proceeded = [];
  const going = guard.quit({ windows: () => [{}], ioFor: () => fakeIO(), proceed: (how) => proceeded.push(how) });
  assert.deepEqual(proceeded, [], 'not before the caller returns');
  assert.equal(await going, true);
  assert.deepEqual(proceeded, [{ relaunch: false }]);
});
