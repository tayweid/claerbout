// Make <Name> the Default Editor… (default-for.js): the config's
// `defaultFor` as read (dots, case, repeats and junk dropped; absent or
// empty is no item), when the app menu has the item (a packaged Mac app
// whose config asks, and nothing else), the ask before anything changes
// (how many kinds of file, which other app opens which, Cancel the
// default; OK alone when there is nothing to change) and what is said
// after; then the bundle's executable (launcher.swift) compiled into a
// bundle of its own and asked with --check about made-up extensions only.
// The change itself is never run here: since macOS 26.4 each one is a
// prompt the user must answer, and this is a real Mac.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileLauncher } from '../launcher.mjs';

const require = createRequire(import.meta.url);
const DefaultFor = require('../default-for.js');
const here = path.dirname(fileURLToPath(import.meta.url));

test('the config: extensions without dots, lowercased, each once', () => {
  assert.deepEqual(DefaultFor.read({ defaultFor: { name: ' code ', extensions: ['.PY', ' js ', 'py', '..ts', 7, '', 'a b', 'x/y', 'c++'] } }), {
    name: 'code',
    extensions: ['py', 'js', 'ts', 'c++'],
  });
  assert.deepEqual(DefaultFor.read({ defaultFor: { extensions: ['rs'] } }), { name: null, extensions: ['rs'] });
  assert.deepEqual(DefaultFor.read({ defaultFor: { name: '', extensions: ['rs'] } }), { name: null, extensions: ['rs'] });
});

test('the config: absent, malformed or empty is no defaultFor', () => {
  for (const config of [{}, null, { defaultFor: null }, { defaultFor: 'code' }, { defaultFor: ['py'] }, { defaultFor: { name: 'code' } }, { defaultFor: { extensions: [] } }, { defaultFor: { extensions: ['', '.', 3] } }]) {
    assert.equal(DefaultFor.read(config), null, JSON.stringify(config));
  }
});

test('the fixture asks for a made-up extension', () => {
  const config = JSON.parse(fs.readFileSync(path.join(here, 'fixture', 'app.json'), 'utf8'));
  assert.deepEqual(DefaultFor.read(config), { name: 'probe files', extensions: ['claerboutprobe'] });
});

test('the menu item: a packaged Mac app whose config asks', () => {
  const defaultFor = { name: 'code', extensions: ['py'] };
  assert.equal(DefaultFor.offered({ defaultFor, isPackaged: true, isMac: true }), true);
  assert.equal(DefaultFor.offered({ defaultFor, isPackaged: false, isMac: true }), false);
  assert.equal(DefaultFor.offered({ defaultFor, isPackaged: true, isMac: false }), false);
  assert.equal(DefaultFor.offered({ defaultFor: null, isPackaged: true, isMac: true }), false);
  assert.equal(DefaultFor.offered({ defaultFor: DefaultFor.read({}), isPackaged: true, isMac: true }), false);
  assert.equal(DefaultFor.label('Knuth'), 'Make Knuth the Default Editor…');
  assert.equal(DefaultFor.launcherOf('/Applications/Knuth.app/Contents/MacOS/Knuth Electron', 'Knuth'), '/Applications/Knuth.app/Contents/MacOS/Knuth');
});

const own = { name: 'Knuth', path: '/Applications/Knuth.app', id: 'io.tayweid.knuth', own: true };
const xcode = { name: 'Xcode', path: '/Applications/Xcode.app', id: 'com.apple.dt.Xcode', own: false };
const code = { name: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app', id: 'com.microsoft.VSCode', own: false };
const kind = (extension, holder, type = `public.${extension}`) => ({ extension, type, holder });

test('the ask: how many, which app opens which, Cancel the default', () => {
  const defaultFor = { name: 'code', extensions: ['c', 'rs', 'js', 'h', 'mjs', 'go', 'qq', 'zz'] };
  const report = {
    kinds: [kind('c', xcode), kind('rs', own), kind('js', code), kind('h', xcode), kind('mjs', code), kind('go', own), kind('qq', null, null), kind('zz', null)],
  };
  const { change, options } = DefaultFor.confirmation('Knuth', defaultFor, report);
  assert.deepEqual(change, ['c', 'js', 'h', 'mjs', 'zz']);
  assert.equal(options.message, 'Make Knuth the default editor for code?');
  assert.equal(
    options.detail,
    'That is 8 kinds of file. 4 of them open in another app now: .c and .h in Xcode; .js and .mjs in Visual Studio Code. No app opens .zz now. macOS asks you to confirm each change. macOS knows no kind of file by .qq.',
  );
  assert.deepEqual(options.buttons, ['Cancel', 'Make Default']);
  assert.equal(options.buttons[options.defaultId], 'Cancel');
  assert.equal(options.buttons[options.cancelId], 'Cancel');
});

test('the ask: no name, every one elsewhere, only one elsewhere, none opening it, a single kind', () => {
  const all = DefaultFor.confirmation('Knuth', { name: null, extensions: ['c', 'h'] }, { kinds: [kind('c', xcode), kind('h', xcode)] });
  assert.equal(all.options.message, 'Make Knuth the default editor for 2 kinds of file?');
  assert.equal(all.options.detail, 'All of them open in another app now: .c and .h in Xcode. macOS asks you to confirm each change.');
  const one = DefaultFor.confirmation('Knuth', { name: 'code', extensions: ['c', 'rs', 'go'] }, { kinds: [kind('c', xcode), kind('rs', own), kind('go', own)] });
  assert.equal(one.options.detail, 'That is 3 kinds of file. One of them opens in another app now: .c in Xcode. macOS asks you to confirm each change.');
  const only = DefaultFor.confirmation('Fixture', { name: 'probe files', extensions: ['claerboutprobe'] }, { kinds: [kind('claerboutprobe', null)] });
  assert.deepEqual(only.change, ['claerboutprobe']);
  assert.equal(only.options.detail, 'That is one kind of file. No app opens .claerboutprobe now. macOS asks you to confirm each change.');
  const single = DefaultFor.confirmation('Knuth', { name: null, extensions: ['c'] }, { kinds: [kind('c', xcode)] });
  assert.equal(single.options.message, 'Make Knuth the default editor for one kind of file?');
  assert.equal(single.options.detail, 'It opens in another app now: .c in Xcode. macOS asks you to confirm each change.');
});

test('the ask: nothing to change is OK alone', () => {
  const { change, options } = DefaultFor.confirmation('Knuth', { name: 'code', extensions: ['rs', 'go', 'qq'] }, { kinds: [kind('rs', own), kind('go', own), kind('qq', null, null)] });
  assert.deepEqual(change, []);
  assert.equal(options.message, 'Knuth is the default editor for code already');
  assert.equal(options.detail, 'It opens all 2 kinds of file it is for. macOS knows no kind of file by .qq.');
  assert.deepEqual(options.buttons, ['OK']);
});

test('after the change: quiet when all of them are the app’s, else which were left', () => {
  assert.equal(DefaultFor.outcome('Knuth', { kinds: [kind('c', own), kind('h', own)] }), null);
  const left = DefaultFor.outcome('Knuth', { kinds: [kind('c', own), { ...kind('h', xcode), error: 'The file couldn’t be opened. (NSCocoaErrorDomain 256)' }] });
  assert.equal(left.message, 'One kind of file was left as it was');
  assert.equal(left.detail, ".h in Xcode. Knuth can be made the default for them from this menu again, or one at a time from the Finder's Get Info.");
  assert.deepEqual(left.buttons, ['OK']);
});

test('the bundle’s executable, asked about made-up extensions', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claerbout-default-for-'));
  try {
    const bundle = path.join(work, 'Probe.app');
    const launcher = path.join(bundle, 'Contents', 'MacOS', 'Probe');
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(
      path.join(bundle, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.tayweid.claerbout.probe</string>
<key>CFBundleName</key><string>Probe</string>
<key>CFBundleExecutable</key><string>Probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
    );
    compileLauncher({ arch: process.arch, out: launcher, scratch: work });

    const report = await DefaultFor.ask(launcher, ['claerboutprobe', 'claerboutprobe-two']);
    assert.equal(fs.realpathSync(report.app), fs.realpathSync(bundle));
    assert.equal(report.id, 'io.tayweid.claerbout.probe');
    assert.deepEqual(report.kinds.map((each) => each.extension), ['claerboutprobe', 'claerboutprobe-two']);
    for (const each of report.kinds) {
      // A made-up extension is a dynamic type; nothing here makes this
      // bundle its app, so whatever opens it is not this one.
      assert.match(each.type, /^dyn\./);
      assert.equal(each.error, undefined);
      assert.ok(!each.holder?.own, JSON.stringify(each.holder));
    }

    // No extension: the usage, and no report.
    await assert.rejects(DefaultFor.ask(launcher, []), /--claerbout-default-for \[--check\] <extension>/);
    assert.throws(() => execFileSync(launcher, [DefaultFor.FLAG], { stdio: 'ignore' }), (error) => error.status === 2);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
