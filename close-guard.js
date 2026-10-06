// The close guard: what the shell does when a window holding unsaved work
// is asked to close (⌘W, the red button, File › Close), and when the app
// is asked to quit or to relaunch into an update (README, "The protocol":
// the `unsaved` request and the `save {reason: 'close'}` event).
//
// The page says what closing now would lose; the shell decides at close
// time and asks the page to save. Taylor's answers (2026-10-06): a window
// whose document can be written without asking is written and closes with
// no dialog (autosave); otherwise the standard sheet asks Save, Don't Save
// or Cancel, and a blank never-saved document is not unsaved and closes
// (the page decides that, by not reporting it); a file changed outside the
// app is never overwritten quietly (no Save on the sheet); and quitting
// asks for each window in turn, the same way, a Cancel stopping the whole
// quit.
//
// Everything here is decisions: main.js hands in the I/O (the save asks,
// the sheet, the user activation the page needs to open a picker), so
// test/close-guard.test.mjs runs every path under node --test.

'use strict';

/** What the sheet's Save can do: write the open file without asking
 *  (`quiet`), have the user pick a place (`choose`), or nothing (`none`: the
 *  file changed outside the app, and the window is where that is settled). */
const SAVES = ['quiet', 'choose', 'none'];
const DONT_SAVE = 'Don’t Save';
const CANCEL = 'Cancel';
const LOST = 'Your changes will be lost if you don’t save them.';
const SILENT = 'The window did not answer when asked to save, so its changes cannot be saved from here. They will be lost if you don’t save them.';

/** A string the page sent, trimmed and kept to a length a sheet can show;
 *  null when it is not one. */
function text(value, limit) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

/** A page's `unsaved` report as the shell keeps it: {name, save, label,
 *  detail} while closing would lose work, else null (nothing to guard). A
 *  report without a known `save` is taken as `choose`, the one that never
 *  writes anywhere the user did not pick. */
function readReport(message) {
  if (!message || message.unsaved !== true) return null;
  return {
    name: text(message.name, 255) ?? 'Untitled',
    save: SAVES.includes(message.save) ? message.save : 'choose',
    label: text(message.label, 64),
    detail: text(message.detail, 1000),
  };
}

/** The sheet for a report: `silent` when the page did not answer the
 *  quiet save in time, which leaves only Don't Save and Cancel. `actions`
 *  says what each button does, by index. Save is the default where there
 *  is one; with none, Cancel is (Return never throws work away). */
function dialogFor(entry, { silent = false } = {}) {
  const offered = !silent && entry.save !== 'none';
  const save = entry.label ?? (entry.save === 'quiet' ? 'Save' : 'Save…');
  const buttons = [...(offered ? [save] : []), DONT_SAVE, CANCEL];
  return {
    message: `Do you want to save the changes you made to “${entry.name}”?`,
    detail: silent ? SILENT : (entry.detail ?? LOST),
    buttons,
    actions: [...(offered ? ['save'] : []), 'discard', 'cancel'],
    defaultId: offered ? 0 : buttons.length - 1,
    cancelId: buttons.length - 1,
  };
}

/** One window's close, settled: 'close' (saved, or Don't Save) or 'keep'
 *  (Cancel, or a save that did not happen). `io`:
 *  - current(): the window's latest report (null: nothing unsaved now);
 *  - quietSave(): `save {reason: 'close', choose: false}` with the usual
 *    wait, → {answered, ok?, error?};
 *  - ask(spec): the sheet, → the index of the button pressed;
 *  - activate(): the page given user activation, so it may open a picker,
 *    → whether it took it (a hung page does not, and is not asked to save:
 *    a save with no wait would never be answered, and the window could
 *    then never close);
 *  - chooseSave(): `save {reason: 'close', choose: true}` with no wait
 *    (a picker may stay open), → {answered, ok?, error?};
 *  - log(line). */
async function settle(io) {
  let entry = io.current();
  if (!entry) return 'close';
  const name = `“${entry.name}”`;
  let silent = false;
  if (entry.save === 'quiet') {
    const answer = await io.quietSave();
    if (answer.answered && answer.ok) {
      io.log(`close: ${name} saved without asking`);
      return 'close';
    }
    silent = !answer.answered;
    io.log(`close: ${name} was not saved without asking (${silent ? 'no answer' : answer.error ?? 'refused'}); asking`);
    // The page may have said more since (a file found missing on the
    // write offers a place to save it).
    entry = io.current();
    if (!entry) return 'close';
  }
  const spec = dialogFor(entry, { silent });
  const action = spec.actions[await io.ask(spec)] ?? 'cancel';
  if (action === 'discard') {
    io.log(`close: ${name} closed without saving (Don’t Save)`);
    return 'close';
  }
  if (action === 'cancel') {
    io.log(`close: ${name} kept open (Cancel)`);
    return 'keep';
  }
  if (!(await io.activate())) {
    io.log(`close: ${name} kept open: the page did not answer`);
    return 'keep';
  }
  const answer = await io.chooseSave();
  if (answer.answered && answer.ok) {
    io.log(`close: ${name} saved`);
    return 'close';
  }
  io.log(`close: ${name} kept open: not saved (${answer.answered ? answer.error ?? 'refused' : 'no answer'})`);
  return 'keep';
}

/** The shell's state for every window: each one's last report, the
 *  windows let go (one close each), the settles under way (one per
 *  window), and the quit. Windows are keys only: anything will do. */
class Guard {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    /** window → its report, while closing it would lose work. */
    this.reports = new Map();
    /** Windows whose next close goes through: settled, now closing. */
    this.released = new Set();
    /** window → the settle under way, → 'close' | 'keep'. */
    this.settling = new Map();
    /** Once the quit is decided, every window closes as it is told. */
    this.quitAllowed = false;
    /** The quit under way: {relaunch, promise}. */
    this.quitRun = null;
  }

  /** A page's `unsaved` request: kept, or forgotten when nothing is
   *  unsaved any more. The kept report, or null. */
  report(window, message) {
    const entry = readReport(message);
    if (entry) this.reports.set(window, entry);
    else this.reports.delete(window);
    return entry;
  }

  /** The window closed, its page went (a crash) or navigated (a reloaded
   *  page reports again). */
  forget(window) {
    this.reports.delete(window);
    this.released.delete(window);
  }

  /** The windows that would lose work, in the order they first said so. */
  waiting() {
    return [...this.reports.keys()];
  }

  /** The window's 'close' event: 'pass' (let it close), 'hold' (prevent it
   *  and settle), or 'wait' (prevent it: a settle is already under way and
   *  will close the window if it comes to that). A release is spent by
   *  the close it was for. */
  onClose(window) {
    if (this.quitAllowed) return 'pass';
    if (this.released.delete(window)) return 'pass';
    if (this.settling.has(window)) return 'wait';
    return this.reports.has(window) ? 'hold' : 'pass';
  }

  /** The window's next close goes through. */
  release(window) {
    this.released.add(window);
  }

  /** The window's close settled (see `settle`), once at a time: a second
   *  ask while one is under way joins it. A failure keeps the window. */
  settle(window, io) {
    const running = this.settling.get(window);
    if (running) return running;
    const run = settle({ ...io, current: () => this.reports.get(window) ?? null })
      .catch((error) => {
        this.log(`close: could not settle a window: ${error?.message ?? error}`);
        return 'keep';
      })
      .finally(() => this.settling.delete(window));
    this.settling.set(window, run);
    return run;
  }

  /** The quit, or the update's relaunch: every window that would lose
   *  work settled in turn (`windows()`, asked again after each, gives the
   *  open windows in the order to ask them), the same way as a close. Any
   *  'keep' stops it all: nothing else happens, and the app goes on as it
   *  was; but a window `gone(window)` says is gone meanwhile (closed) has
   *  nothing left to lose. Otherwise every window may close, and
   *  `proceed({relaunch})` quits. One at a time: a quit asked for while one is under way joins
   *  it, and a relaunch asked for then makes it a relaunch. → whether it
   *  went on. */
  quit({ windows, ioFor, proceed, gone = () => false, relaunch = false }) {
    if (this.quitRun) {
      if (relaunch) this.quitRun.relaunch = true;
      return this.quitRun.promise;
    }
    const run = { relaunch, promise: null };
    this.quitRun = run;
    run.promise = (async () => {
      // Never inside the caller's own frame (app.quit() from before-quit).
      await null;
      try {
        const done = new Set();
        for (;;) {
          const next = windows().find((window) => this.reports.has(window) && !done.has(window));
          if (!next) break;
          const name = this.reports.get(next).name;
          if ((await this.settle(next, ioFor(next))) !== 'close' && !gone(next)) {
            this.log(`quit: stopped, “${name}” kept open`);
            return false;
          }
          done.add(next);
        }
        this.quitAllowed = true;
      } finally {
        this.quitRun = null;
      }
      proceed({ relaunch: run.relaunch });
      return true;
    })();
    return run.promise;
  }
}

module.exports = { Guard, settle, readReport, dialogFor, SAVES, DONT_SAVE, CANCEL, LOST, SILENT };
