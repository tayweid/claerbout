// The autosave module against real git in temporary repositories: a
// folder with no repository, a repository with a clean branch and a dirty
// index (both untouched by the record), the skips (index.lock, a merge in
// progress, an unchanged tree), the secrets kept out, the untracked/
// manifest and its hash cache, the identity, the sessions and the timer.
// The user's git configuration is kept out (GIT_CONFIG_GLOBAL points at an
// empty file), so the fallback identity is what a bare machine gets.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claerbout-autosave-'));
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');

const { Autosave, Project, repositoryOf, writeManifest, BRANCH, IDENTITY, MANIFEST, findGit } = require('../autosave.js');
const binary = findGit();
assert.ok(binary, 'git is needed for these tests');

const lines = [];
const log = (line) => lines.push(line);
let counter = 0;
const folder = (name) => {
  const dir = path.join(work, `${name}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const sh = (cwd, ...args) => execFileSync(binary, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const subjects = (cwd) => sh(cwd, 'log', '--format=%s', BRANCH).split('\n').filter(Boolean);
const tree = (cwd) => sh(cwd, 'ls-tree', '-r', '--name-only', BRANCH).split('\n').filter(Boolean);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A project on a folder, without the sessions: commits on request. */
async function projectAt(dir, appName = 'fixture') {
  let found = await repositoryOf(binary, dir);
  if (found === null) {
    sh(dir, 'init', '-q', '--initial-branch=main', '.');
    found = await repositoryOf(binary, dir);
  }
  return new Project({ binary, root: found.root, gitDir: found.gitDir, appName, stateDir: folder('state'), log });
}

before(() => {
  lines.length = 0;
});

after(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

test('a folder with no repository gets one, and the first commit holds the document', async () => {
  const dir = folder('fresh');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello\n');
  const autosave = new Autosave({ appName: 'Fixture', stateDir: folder('state'), log, interval: 60_000, binary });
  const window = { id: 1 };
  await autosave.setDocument(window, path.join(dir, 'note.txt'));
  const project = autosave.project(window);
  assert.ok(project, 'the window is on a project');
  await project.queue;
  assert.ok(fs.existsSync(path.join(dir, '.git')), 'a repository was initialised');
  assert.deepEqual(subjects(dir), ['fixture: session open']);
  assert.ok(tree(dir).includes('note.txt'));
  assert.ok(tree(dir).includes('.claerbout/untracked.json'), 'the manifest is in the track');
  assert.ok(fs.existsSync(path.join(dir, 'untracked')), 'untracked/ exists');
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^untracked\/$/m);
  assert.ok(!tree(dir).some((entry) => entry.startsWith('untracked/')), 'untracked/ is ignored');
  // The user's side is untouched: HEAD is still unborn, the index empty.
  assert.throws(() => sh(dir, 'rev-parse', '--verify', '-q', 'HEAD'));
  assert.equal(sh(dir, 'ls-files'), '');
  assert.ok(lines.some((line) => line.includes('initialised a repository')));
  await autosave.closed(window);
  await project.queue;
});

test('a repository with a clean branch and a dirty index: the record sees the working tree, the user sees no change', async () => {
  const dir = folder('dirty');
  sh(dir, 'init', '-q', '--initial-branch=main', '.');
  sh(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'start');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', 'a.txt');
  sh(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'a');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n'); // modified, unstaged
  fs.writeFileSync(path.join(dir, 'b.txt'), 'staged\n');
  sh(dir, 'add', 'b.txt'); // staged, uncommitted
  const head = sh(dir, 'rev-parse', 'HEAD');
  const staged = sh(dir, 'diff', '--cached', '--name-only');
  const project = await projectAt(dir);
  const result = await project.commit('cell run [4]');
  assert.equal(result.committed, true);
  assert.equal(result.message, 'fixture: cell run [4]');
  assert.deepEqual(subjects(dir), ['fixture: cell run [4]']);
  assert.equal(sh(dir, 'show', `${BRANCH}:a.txt`), 'two');
  assert.equal(sh(dir, 'show', `${BRANCH}:b.txt`), 'staged');
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), head, 'HEAD did not move');
  assert.equal(sh(dir, 'symbolic-ref', 'HEAD'), 'refs/heads/main', 'the branch is the same');
  assert.equal(sh(dir, 'diff', '--cached', '--name-only'), staged, 'the index is as it was');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'two\n');
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'index.lock')));
});

test('nothing changed: no commit', async () => {
  const dir = folder('same');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const project = await projectAt(dir);
  assert.equal((await project.commit('timer')).committed, true);
  const again = await project.commit('timer');
  assert.equal(again.skipped, 'unchanged');
  assert.equal(subjects(dir).length, 1);
  fs.writeFileSync(path.join(dir, 'x.txt'), 'y\n');
  assert.equal((await project.commit('timer')).committed, true);
  assert.equal(subjects(dir).length, 2);
});

test('index.lock present: skipped', async () => {
  const dir = folder('locked');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const project = await projectAt(dir);
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');
  assert.equal((await project.commit('timer')).skipped, 'index.lock exists');
  assert.throws(() => sh(dir, 'rev-parse', '--verify', '-q', BRANCH), 'no branch was made');
  fs.rmSync(path.join(dir, '.git', 'index.lock'));
  assert.equal((await project.commit('timer')).committed, true);
});

test('a merge in progress: skipped', async () => {
  const dir = folder('merging');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const project = await projectAt(dir);
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), '0'.repeat(40));
  assert.equal((await project.commit('timer')).skipped, 'merge in progress');
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'));
  fs.mkdirSync(path.join(dir, '.git', 'rebase-merge'));
  assert.equal((await project.commit('timer')).skipped, 'rebase merge in progress');
  fs.rmSync(path.join(dir, '.git', 'rebase-merge'), { recursive: true });
  assert.equal((await project.commit('timer')).committed, true);
});

test('secret files stay out of the record, at the top and in any folder', async () => {
  const dir = folder('secrets');
  fs.mkdirSync(path.join(dir, 'sub', 'deeper'), { recursive: true });
  const secrets = ['.env', '.env.local', 'key.pem', 'server.key', 'id_rsa', 'id_rsa.pub', 'cert.p12', 'credentials.json', '.npmrc', '.netrc'];
  for (const name of secrets) {
    fs.writeFileSync(path.join(dir, name), 'secret\n');
    fs.writeFileSync(path.join(dir, 'sub', 'deeper', name), 'secret\n');
  }
  fs.writeFileSync(path.join(dir, 'analysis.py'), 'print(1)\n');
  fs.writeFileSync(path.join(dir, 'sub', 'notes.md'), '# notes\n');
  fs.writeFileSync(path.join(dir, 'sub', 'environment.yml'), 'name: x\n'); // not a secret
  const project = await projectAt(dir);
  assert.equal((await project.commit('timer')).committed, true);
  const recorded = tree(dir);
  for (const name of secrets) {
    assert.ok(!recorded.includes(name), `${name} is out`);
    assert.ok(!recorded.includes(`sub/deeper/${name}`), `sub/deeper/${name} is out`);
  }
  assert.ok(recorded.includes('analysis.py'));
  assert.ok(recorded.includes('sub/notes.md'));
  assert.ok(recorded.includes('sub/environment.yml'));
});

test('the untracked/ manifest: path, size, mtime, sha256; rehashed only when size or mtime changed', async () => {
  const dir = folder('manifest');
  const project = await projectAt(dir);
  await project.prepare();
  fs.mkdirSync(path.join(dir, 'untracked', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'untracked', 'data', 'big.csv'), 'a,b\n1,2\n');
  fs.writeFileSync(path.join(dir, 'untracked', 'cache.bin'), 'cache');
  assert.equal((await project.commit('timer')).committed, true);
  const manifest = JSON.parse(sh(dir, 'show', `${BRANCH}:${MANIFEST.split(path.sep).join('/')}`));
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    ['untracked/cache.bin', 'untracked/data/big.csv'],
  );
  const big = manifest.files.find((entry) => entry.path === 'untracked/data/big.csv');
  assert.equal(big.size, 8);
  assert.equal(big.sha256, sha256('a,b\n1,2\n'));
  assert.match(big.mtime, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!tree(dir).some((entry) => entry.startsWith('untracked/')), 'the data itself is not recorded');
  // The cache: a file with the same size and mtime is not hashed again
  // (its cached hash, tampered here, is what the manifest carries).
  const cacheFile = path.join(project.stateDir, 'hashes.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  cache['untracked/cache.bin'].sha256 = 'cached-not-rehashed';
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const entries = await writeManifest(dir, cacheFile);
  assert.equal(entries.find((entry) => entry.path === 'untracked/cache.bin').sha256, 'cached-not-rehashed');
  // A change in size: hashed again.
  fs.writeFileSync(path.join(dir, 'untracked', 'cache.bin'), 'cache2');
  const after = await writeManifest(dir, cacheFile);
  assert.equal(after.find((entry) => entry.path === 'untracked/cache.bin').sha256, sha256('cache2'));
  // A gone file leaves the manifest.
  fs.rmSync(path.join(dir, 'untracked', 'data'), { recursive: true });
  const gone = await writeManifest(dir, cacheFile);
  assert.deepEqual(gone.map((entry) => entry.path), ['untracked/cache.bin']);
});

test('the identity: the repository\'s own when set, else the autosave\'s', async () => {
  const dir = folder('identity');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const project = await projectAt(dir);
  assert.equal((await project.commit('session open')).committed, true);
  assert.equal(sh(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', BRANCH), `${IDENTITY.name} <${IDENTITY.email}>|${IDENTITY.name} <${IDENTITY.email}>`);
  sh(dir, 'config', 'user.name', 'Ada');
  sh(dir, 'config', 'user.email', 'ada@example.invalid');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'y\n');
  assert.equal((await project.commit('timer')).committed, true);
  assert.equal(sh(dir, 'log', '-1', '--format=%an <%ae>', BRANCH), 'Ada <ada@example.invalid>');
});

test('an existing .gitignore is appended, not replaced, and one that already ignores untracked/ is left alone', async () => {
  const dir = folder('ignore');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/'); // no trailing newline
  const project = await projectAt(dir);
  await project.prepare();
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n')[0], 'node_modules/');
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\nuntracked\/\n$/);
  const other = folder('ignored');
  fs.writeFileSync(path.join(other, '.gitignore'), 'untracked/\n');
  const second = await projectAt(other);
  await second.prepare();
  assert.equal(fs.readFileSync(path.join(other, '.gitignore'), 'utf8'), 'untracked/\n');
});

test('the message: "<app>: <trigger>", one line, bounded', async () => {
  const dir = folder('message');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const project = await projectAt(dir, 'plass');
  const result = await project.commit('cell\nrun\t[2]');
  assert.equal(result.message, 'plass: cell run [2]');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'y\n');
  assert.equal((await project.commit('')).message, 'plass: notice');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'z\n');
  assert.equal((await project.commit('a'.repeat(300))).message.length, 'plass: '.length + 120);
});

test('two apps on one project: both land on the one branch, chained', async () => {
  const dir = folder('shared');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const knuth = await projectAt(dir, 'knuth');
  const plass = await projectAt(dir, 'plass');
  assert.equal((await knuth.commit('session open')).committed, true);
  fs.writeFileSync(path.join(dir, 'x.txt'), 'y\n');
  const [a, b] = await Promise.all([knuth.commit('cell run [1]'), plass.commit('timer')]);
  assert.ok(a.committed || a.skipped === 'unchanged');
  assert.ok(b.committed || b.skipped === 'unchanged');
  assert.ok(a.committed || b.committed, 'one of them recorded the change');
  const log = subjects(dir);
  assert.equal(log.at(-1), 'knuth: session open');
  assert.equal(log.length, 1 + (a.committed ? 1 : 0) + (b.committed ? 1 : 0));
  assert.equal(sh(dir, 'show', `${BRANCH}:x.txt`), 'y');
});

test('sessions: the first window opens one, the last closes it; a notice commits; the timer commits', async () => {
  const dir = folder('session');
  fs.writeFileSync(path.join(dir, 'doc.py'), '# %%\n');
  const autosave = new Autosave({ appName: 'Knuth', stateDir: folder('state'), log, interval: 300, binary });
  const first = { id: 'w1' };
  const second = { id: 'w2' };
  await autosave.setDocument(first, path.join(dir, 'doc.py'));
  await autosave.setDocument(second, path.join(dir, 'doc.py'));
  const project = autosave.project(first);
  assert.equal(project, autosave.project(second), 'one project for both windows');
  await project.queue;
  assert.deepEqual(subjects(dir), ['knuth: session open']);
  // A notice from a page on the project.
  fs.writeFileSync(path.join(dir, 'doc.py'), '# %%\nanswer = 42\n');
  const noticed = await autosave.notice(first, 'cell run [1]');
  assert.equal(noticed.committed, true);
  assert.equal(subjects(dir)[0], 'knuth: cell run [1]');
  // The timer, while a window is open.
  fs.writeFileSync(path.join(dir, 'doc.py'), '# %%\nanswer = 43\n');
  for (let i = 0; i < 40 && subjects(dir)[0] !== 'knuth: timer'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(subjects(dir)[0], 'knuth: timer');
  // One window closing is not the session's end.
  await autosave.closed(first);
  await project.queue;
  assert.ok(!subjects(dir).includes('knuth: session close'));
  // The last one is.
  fs.writeFileSync(path.join(dir, 'doc.py'), '# %%\nanswer = 44\n');
  await autosave.closed(second);
  await project.queue;
  assert.equal(subjects(dir)[0], 'knuth: session close');
  assert.equal(project.timer, null, 'the timer stopped');
  // Nothing from a window on no project.
  assert.equal(await autosave.notice({ id: 'w3' }, 'cell run [1]'), null);
  assert.ok(lines.some((line) => /autosave: knuth: cell run \[1\] → [0-9a-f]{10}/.test(line)), 'the log has the commit');
});

test('a window moving between documents moves between projects; a document without a path leaves', async () => {
  const one = folder('one');
  const two = folder('two');
  fs.writeFileSync(path.join(one, 'a.typ'), '= A\n');
  fs.writeFileSync(path.join(two, 'b.typ'), '= B\n');
  const autosave = new Autosave({ appName: 'Plass', stateDir: folder('state'), log, interval: 60_000, binary });
  const window = { id: 'w' };
  await autosave.setDocument(window, path.join(one, 'a.typ'));
  const first = autosave.project(window);
  await autosave.setDocument(window, path.join(two, 'b.typ'));
  const second = autosave.project(window);
  await first.queue;
  await second.queue;
  assert.deepEqual(subjects(one), ['plass: session open']);
  assert.deepEqual(subjects(two), ['plass: session open']);
  assert.equal(first.windows.size, 0);
  assert.equal(second.windows.size, 1);
  fs.writeFileSync(path.join(two, 'b.typ'), '= B!\n');
  await autosave.setDocument(window, null);
  await second.queue;
  assert.equal(subjects(two)[0], 'plass: session close');
  assert.equal(autosave.project(window), null);
});

test('quit: every open session closes, and nothing starts after', async () => {
  const dir = folder('quit');
  fs.writeFileSync(path.join(dir, 'doc.py'), '# %%\n');
  const autosave = new Autosave({ appName: 'Knuth', stateDir: folder('state'), log, interval: 60_000, binary });
  const window = { id: 'w' };
  await autosave.setDocument(window, path.join(dir, 'doc.py'));
  const project = autosave.project(window);
  await project.queue;
  fs.writeFileSync(path.join(dir, 'doc.py'), '# %%\nx = 1\n');
  await autosave.quit();
  assert.deepEqual(subjects(dir), ['knuth: session close', 'knuth: session open']);
  assert.equal(project.timer, null);
  fs.writeFileSync(path.join(dir, 'doc.py'), '# %%\nx = 2\n');
  assert.equal(await autosave.notice(window, 'cell run [1]'), null);
  await autosave.closed(window);
  await project.queue;
  assert.equal(subjects(dir).length, 2);
});

test('inside a .git folder or a bare repository: no record, said once', async () => {
  const dir = folder('bare');
  sh(dir, 'init', '-q', '--bare', '.');
  const autosave = new Autosave({ appName: 'Knuth', stateDir: folder('state'), log, interval: 60_000, binary });
  const window = { id: 'w' };
  await autosave.setDocument(window, path.join(dir, 'doc.py'));
  assert.equal(autosave.project(window), null);
  assert.ok(lines.some((line) => line.includes(`no record for ${dir}`)));
  assert.equal(await repositoryOf(binary, dir), 'unusable');
});

test('disabled by config or environment: an object that does nothing', () => {
  const { attach } = require('../autosave.js');
  const off = attach({ config: { name: 'Knuth' }, env: () => '', log, stateDir: folder('state') });
  assert.equal(off.enabled, false);
  const byEnv = attach({ config: { name: 'Knuth', autosave: true }, env: (key) => (key === 'AUTOSAVE' ? '0' : ''), log, stateDir: folder('state') });
  assert.equal(byEnv.enabled, false);
  const on = attach({ config: { name: 'Knuth', autosave: true }, env: (key) => (key === 'AUTOSAVE_INTERVAL' ? '5' : ''), log, stateDir: folder('state') });
  assert.equal(on.enabled, true);
  assert.equal(on.interval, 5000);
  assert.ok(lines.some((line) => line.includes('autosave: on, claerbout-autosave every 5 s')));
});
