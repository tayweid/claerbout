// The app menu's "Make <Name> the Default Editor…": the app made the
// default for the file types its config's `defaultFor` lists, so nobody
// goes through the Finder's Get Info › Open with › Change All once per
// extension. An app never takes a type on install (package.mjs ranks
// every document type Alternate); this is the user promoting it.
//
// The work is the bundle's executable's (launcher.swift,
// --claerbout-default-for): Launch Services has no setter a script can
// reach. It reports, for each extension, its type and the app that opens
// it now; the shell asks the user, then has it change only the types
// another app opens. Since macOS 26.4 the system confirms every such
// change with a prompt of its own, one per type, so the ask says they
// are coming. Everything but running the executable is decisions,
// tested under node --test (test/default-for.test.mjs).

'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');

const FLAG = '--claerbout-default-for';

/** The config's `defaultFor` as the shell uses it: {name, extensions},
 *  the extensions without their dots, lowercased, each once; null when
 *  the key is absent or lists no extension. */
function read(config) {
  const entry = config?.defaultFor;
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.extensions)) return null;
  const extensions = [];
  for (const value of entry.extensions) {
    if (typeof value !== 'string') continue;
    const extension = value.trim().replace(/^\.+/, '').toLowerCase();
    if (extension && !/[\s/]/.test(extension) && !extensions.includes(extension)) extensions.push(extension);
  }
  if (extensions.length === 0) return null;
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null;
  return { name, extensions };
}

/** Whether the app menu has the item: a config that asks, in an app built
 *  for the Mac (a checkout has no bundle to make the default). */
function offered({ defaultFor, isPackaged, isMac }) {
  return Boolean(defaultFor) && isPackaged && isMac;
}

const label = (appName) => `Make ${appName} the Default Editor…`;

/** The bundle's executable, beside Electron's own ("<Name> Electron"). */
const launcherOf = (execPath, appName) => path.join(path.dirname(execPath), appName);

/** The executable's report: {app, id, kinds: [{extension, type, holder:
 *  {name, path, id, own} | null, error}]}. With `set`, after making the
 *  app the default for each extension's type; else only a look. No time
 *  limit when setting: the user answers the system's prompts. */
function ask(launcher, extensions, { set = false } = {}) {
  const args = [FLAG, ...(set ? [] : ['--check']), ...extensions];
  return new Promise((resolve, reject) => {
    execFile(launcher, args, { timeout: set ? 0 : 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      try {
        const report = JSON.parse(stdout);
        if (Array.isArray(report.kinds)) {
          resolve(report);
          return;
        }
      } catch {
        // No report: say why below.
      }
      const said = `${stderr ?? ''}`.trim().split('\n').pop();
      reject(new Error(said || error?.message || `${path.basename(launcher)} gave no report`));
    });
  });
}

/** What a report means for the user: the extensions to change, those
 *  another app opens now (`app`, its name) or none does (`app` null), and
 *  those the system has no type for. What this app opens already is left. */
function sort(report) {
  const change = [];
  const unknown = [];
  for (const kind of report.kinds) {
    if (!kind.type) unknown.push(kind.extension);
    else if (!kind.holder?.own) change.push({ extension: kind.extension, app: kind.holder?.name ?? null });
  }
  return { change, unknown };
}

/** ".a", ".a and .b", ".a, .b and .c" */
function list(extensions) {
  const dotted = extensions.map((extension) => `.${extension}`);
  return dotted.length < 2 ? dotted.join('') : `${dotted.slice(0, -1).join(', ')} and ${dotted.at(-1)}`;
}

/** ".c and .h in Xcode; .js in Visual Studio Code": the extensions by
 *  the app that opens them, the apps in the order they first come. */
function byApp(change) {
  const apps = new Map();
  for (const { extension, app } of change) apps.set(app, [...(apps.get(app) ?? []), extension]);
  return [...apps].map(([app, extensions]) => `${list(extensions)} ${app ? `in ${app}` : 'in no app'}`).join('; ');
}

const kinds = (count) => (count === 1 ? 'one kind of file' : `${count} kinds of file`);

/** The ask before anything changes: a message box's options, Cancel the
 *  default, and the extensions the second button changes. With none to
 *  change, it says so with OK alone. */
function confirmation(appName, defaultFor, report) {
  const { change, unknown } = sort(report);
  const total = defaultFor.extensions.length;
  const noType = unknown.length ? ` macOS knows no kind of file by ${list(unknown)}.` : '';
  if (change.length === 0) {
    return {
      change: [],
      options: {
        type: 'info',
        message: `${appName} is the default editor${defaultFor.name ? ` for ${defaultFor.name}` : ''} already`,
        detail: `It opens ${total - unknown.length === 1 ? 'the one kind of file' : `all ${kinds(total - unknown.length)}`} it is for.${noType}`,
        buttons: ['OK'],
        defaultId: 0,
        cancelId: 0,
      },
    };
  }
  const held = change.filter(({ app }) => app);
  const free = change.filter(({ app }) => !app).map(({ extension }) => extension);
  const which =
    total === 1 ? 'It opens' : held.length === total ? 'All of them open' : held.length === 1 ? 'One of them opens' : `${held.length} of them open`;
  const detail = [
    defaultFor.name ? `That is ${kinds(total)}.` : '',
    held.length ? `${which} in another app now: ${byApp(held)}.` : '',
    free.length ? `No app opens ${list(free)} now.` : '',
    'macOS asks you to confirm each change.',
  ];
  return {
    change: change.map(({ extension }) => extension),
    options: {
      type: 'question',
      message: `Make ${appName} the default editor for ${defaultFor.name ?? kinds(total)}?`,
      detail: `${detail.filter(Boolean).join(' ')}${noType}`,
      buttons: ['Cancel', 'Make Default'],
      defaultId: 0,
      cancelId: 0,
    },
  };
}

/** After the change: null when this app opens every extension asked
 *  about, else a message box's options naming those that stayed (a
 *  prompt declined, or the change refused). */
function outcome(appName, report) {
  const { change } = sort(report);
  if (change.length === 0) return null;
  return {
    type: 'info',
    message: change.length === 1 ? `One kind of file was left as it was` : `${kinds(change.length)} were left as they were`,
    detail: `${byApp(change)}. ${appName} can be made the default for them from this menu again, or one at a time from the Finder's Get Info.`,
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
  };
}

module.exports = { FLAG, read, offered, label, launcherOf, ask, sort, confirmation, outcome };
