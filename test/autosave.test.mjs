// The autosave module against real git in temporary repositories: a
// folder with no repository, a repository with a clean branch and a dirty
// index (both untouched by the record), the skips (index.lock, a merge in
// progress, an unchanged tree, the record's branch checked out), where a
// repository may be started, linked worktrees, what git add cannot read or
// must leave out (an unreadable file, a nested repository without a
// commit), the secrets kept out, the untracked/ manifest (forced in, and
// its hash cache), nothing written into the user's .git, the identity, the
// sessions, the timer (never piling up) and quit (waiting, bounded); and
// from the second review: the guards again just before the ref moves, a
// rebase of the record in a linked worktree, a symbolic ref at the
// record's name, hidden folders of the home folder, a repository at the
// home folder, symbolic links at the record's names, secrets whatever their
// case (and in untracked/), a sparse checkout, git's PATH, a clean filter
// that cannot run, and a failure every tick said once; and from the third:
// a document path in another letter case or in its firmlink form is judged
// as the folder it opens, and the .gitignore line is anchored, so a folder
// named untracked deeper down stays the user's.
// Everything lives under os.tmpdir(); the user's git configuration is kept
// out (GIT_CONFIG_GLOBAL points at an empty file), so the fallback
// identity is what a bare machine gets.
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

const {
  Autosave,
  Project,
  repositoryOf,
  writeManifest,
  branchFor,
  notProjectFolder,
  secretPlace,
  isSecret,
  errorLine,
  filterFailure,
  gitEnvironment,
  BRANCH,
  BRANCH_NAME,
  SECRETS,
  IDENTITY,
  MANIFEST,
  findGit,
} = require('../autosave.js');
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
const subjects = (cwd, ref = BRANCH) => sh(cwd, 'log', '--format=%s', ref).split('\n').filter(Boolean);
const tree = (cwd, ref = BRANCH) => sh(cwd, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean);
const as = ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid'];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A git that sleeps before every `add`, and notes it: a slow working tree. */
function slowGit(seconds) {
  const script = path.join(work, `slow-git-${counter++}`);
  const notes = `${script}.adds`;
  fs.writeFileSync(
    script,
    `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = add ]; then echo "$*" >> '${notes}'; sleep ${seconds}; break; fi\ndone\nexec '${binary}' "$@"\n`,
  );
  fs.chmodSync(script, 0o755);
  return { binary: script, adds: () => (fs.existsSync(notes) ? fs.readFileSync(notes, 'utf8').split('\n').filter((line) => / -A /.test(line)).length : 0) };
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A project on a folder, without the sessions: commits on request. */
async function projectAt(dir, appName = 'fixture') {
  let found = await repositoryOf(binary, dir);
  if (found === null) {
    sh(dir, 'init', '-q', '--initial-branch=main', '.');
    found = await repositoryOf(binary, dir);
  }
  return new Project({ binary, root: found.root, gitDir: found.gitDir, commonDir: found.commonDir, appName, stateDir: folder('state'), log });
}
/** A git that fails one subcommand while a flag file exists. */
function failingGit(subcommand, line) {
  const script = path.join(work, `failing-git-${counter++}`);
  const flag = `${script}.fail`;
  fs.writeFileSync(
    script,
    `#!/bin/sh\nif [ -e '${flag}' ]; then\n  for arg in "$@"; do\n    if [ "$arg" = ${subcommand} ]; then echo '${line}' >&2; exit 128; fi\n  done\nfi\nexec '${binary}' "$@"\n`,
  );
  fs.chmodSync(script, 0o755);
  fs.writeFileSync(flag, '');
  return { binary: script, heal: () => fs.rmSync(flag, { force: true }), break: () => fs.writeFileSync(flag, '') };
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
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\/untracked\/$/m);
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

test('secret files stay out of the record, at the top and in any folder, and the README lists every pattern', async () => {
  const dir = folder('secrets');
  fs.mkdirSync(path.join(dir, 'sub', 'deeper'), { recursive: true });
  const secrets = [
    '.env', '.env.local', 'key.pem', 'server.key', 'id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub', 'id_ecdsa',
    'id_dsa', 'cert.p12', 'cert.pfx', 'store.jks', 'release.keystore', 'backup.gpg', 'key.asc', 'credentials.json',
    'service-account-prod.json', '.git-credentials', '.pypirc', '.npmrc', '.netrc', 'token', 'token.txt', 'api.token',
  ];
  const inFolders = ['.aws/credentials', '.aws/config', '.ssh/id_ed25519', '.ssh/config', '.gnupg/pubring.kbx', 'venv/.env/pip.conf'];
  for (const base of [dir, path.join(dir, 'sub', 'deeper')]) {
    for (const name of [...secrets, ...inFolders]) {
      fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true });
      fs.writeFileSync(path.join(base, name), 'secret\n');
    }
  }
  fs.writeFileSync(path.join(dir, 'analysis.py'), 'print(1)\n');
  fs.writeFileSync(path.join(dir, 'sub', 'notes.md'), '# notes\n');
  fs.writeFileSync(path.join(dir, 'sub', 'environment.yml'), 'name: x\n'); // not a secret
  fs.mkdirSync(path.join(dir, 'tokens'));
  fs.writeFileSync(path.join(dir, 'tokens', 'vocab.txt'), 'a\n'); // a folder's name is not a file's
  const project = await projectAt(dir);
  lines.length = 0;
  assert.equal((await project.commit('timer')).committed, true);
  const recorded = tree(dir);
  for (const name of [...secrets, ...inFolders]) {
    assert.ok(!recorded.includes(name), `${name} is out`);
    assert.ok(!recorded.includes(`sub/deeper/${name}`), `sub/deeper/${name} is out`);
  }
  assert.ok(recorded.includes('analysis.py'));
  assert.ok(recorded.includes('sub/notes.md'));
  assert.ok(recorded.includes('sub/environment.yml'));
  assert.ok(recorded.includes('tokens/vocab.txt'));
  // Said once per launch, so a name caught by mistake is seen.
  assert.ok(lines.some((line) => line.includes('kept out of the record as possible secrets: ')));
  fs.writeFileSync(path.join(dir, 'analysis.py'), 'print(2)\n');
  assert.equal((await project.commit('timer')).committed, true);
  assert.equal(lines.filter((line) => line.includes('possible secrets')).length, 1);
  // The list is documented: every pattern is in the README.
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const pattern of SECRETS) assert.ok(readme.includes(`\`${pattern}\``), `the README lists ${pattern}`);
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
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\n\/untracked\/\n$/);
  // Once there, never twice.
  await (await projectAt(dir)).prepare();
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').match(/^\/untracked\/$/gm).length, 1);
  // An unanchored line, as an earlier build wrote, is left as it is.
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

test('the record checked out, in the main worktree or a linked one: skipped, and HEAD stays where it is', async () => {
  const dir = folder('checked-out');
  sh(dir, 'init', '-q', '--initial-branch=main', '.');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', 'a.txt');
  sh(dir, ...as, 'commit', '-q', '-m', 'a');
  const project = await projectAt(dir);
  assert.equal((await project.commit('timer')).committed, true);
  // Someone looks at the record by checking it out.
  sh(dir, 'checkout', '-q', '-f', BRANCH_NAME);
  const head = sh(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  lines.length = 0;
  const skipped = await project.commit('timer');
  assert.match(skipped.skipped, /claerbout-autosave is checked out/);
  assert.equal((await project.commit('timer')).skipped, skipped.skipped);
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), head, 'HEAD did not move');
  assert.equal(sh(dir, 'diff', '--cached', '--name-only'), '', 'nothing staged under the user');
  assert.equal(lines.filter((line) => line.includes('not recorded while claerbout-autosave is checked out')).length, 1, 'said once');
  // Back on main: recorded again.
  sh(dir, 'checkout', '-q', '-f', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
  assert.equal((await project.commit('timer')).committed, true);
  // Checked out in a linked worktree instead.
  const look = path.join(work, `look-${counter++}`);
  sh(dir, 'worktree', 'add', '-q', look, BRANCH_NAME);
  const lookHead = sh(look, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'four\n');
  assert.match((await project.commit('timer')).skipped, /checked out/);
  assert.equal(sh(look, 'rev-parse', 'HEAD'), lookHead, "the linked worktree's HEAD did not move");
  assert.equal(sh(look, 'status', '--porcelain', '--untracked-files=no'), '', 'and nothing changed under it');
});

test('where a repository may be started: not the home folder, its standard folders, a cloud root, a temporary folder or a volume root', async () => {
  const home = folder('home');
  const temp = folder('temp');
  const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  for (const dir of [path.join(home, 'Desktop', 'week-3'), icloud, path.join(home, 'Projects', 'foo')]) fs.mkdirSync(dir, { recursive: true });
  const autosave = new Autosave({ appName: 'Plass', stateDir: folder('state'), log, interval: 60_000, binary, home, temporary: [temp] });
  const window = { id: 'w' };
  lines.length = 0;
  for (const [dir, reason] of [
    [home, 'the home folder'],
    [path.join(home, 'Desktop'), 'the Desktop folder itself'],
    [temp, 'a temporary folder'],
    [icloud, 'a cloud-synced root'],
  ]) {
    const doc = path.join(dir, 'note.typ');
    fs.writeFileSync(doc, '= Note\n');
    await autosave.setDocument(window, doc);
    assert.equal(autosave.project(window), null, `no record for a document in ${dir}`);
    assert.ok(!fs.existsSync(path.join(dir, '.git')), `no repository at ${dir}`);
    assert.ok(!fs.existsSync(path.join(dir, 'untracked')), `nothing written at ${dir}`);
    assert.ok(lines.some((line) => line.includes(`no record for ${dir}: ${reason} is not a project's folder`)), reason);
  }
  // Said once per folder per launch.
  await autosave.setDocument(window, path.join(home, 'Desktop', 'note.typ'));
  await autosave.setDocument(window, path.join(home, 'note.typ'));
  assert.equal(lines.filter((line) => line.includes(`no record for ${home}:`)).length, 1);
  // A folder below one of those is a project's.
  for (const dir of [path.join(home, 'Desktop', 'week-3'), path.join(home, 'Projects', 'foo')]) {
    const doc = path.join(dir, 'paper.typ');
    fs.writeFileSync(doc, '= Paper\n');
    await autosave.setDocument(window, doc);
    const project = autosave.project(window);
    assert.ok(project, `a record for ${dir}`);
    await project.queue;
    assert.ok(fs.existsSync(path.join(dir, '.git')), `a repository at ${dir}`);
    assert.deepEqual(subjects(dir), ['plass: session open']);
  }
  await autosave.setDocument(window, null);
  await autosave.quit();
  // The rule itself, with this machine's folders.
  assert.equal(notProjectFolder('/'), 'a volume root');
  assert.equal(notProjectFolder('/Volumes/Data'), 'a volume root');
  assert.equal(notProjectFolder(os.homedir()), 'the home folder');
  assert.equal(notProjectFolder(path.dirname(os.homedir())), 'a folder the home folder is in');
  assert.equal(notProjectFolder(path.join(os.homedir(), 'Downloads')), 'the Downloads folder itself');
  assert.equal(notProjectFolder(os.tmpdir()), 'a temporary folder');
  assert.equal(notProjectFolder('/tmp'), 'a temporary folder');
  assert.equal(notProjectFolder(path.join(os.homedir(), 'Library', 'CloudStorage', 'Dropbox')), 'a cloud-synced root');
  assert.equal(notProjectFolder(path.join(os.homedir(), 'Library', 'CloudStorage', 'GoogleDrive-a@b.c', 'My Drive')), 'a cloud-synced root');
  assert.equal(notProjectFolder(path.join(os.homedir(), 'Dropbox')), 'a cloud-synced root');
  assert.equal(notProjectFolder(path.join(os.tmpdir(), 'x')), null);
  assert.equal(notProjectFolder(path.join(os.homedir(), 'Projects')), null);
  assert.equal(notProjectFolder(path.join(os.homedir(), 'Desktop', 'week-3')), null);
  assert.equal(notProjectFolder(path.join(os.homedir(), 'Dropbox', 'thesis')), null);
});

test('a repository whose root is the home folder is not used: no record under it, said once', async () => {
  const home = folder('dotfiles-home');
  fs.mkdirSync(path.join(home, 'Desktop'));
  fs.mkdirSync(path.join(home, 'Projects', 'plan'), { recursive: true });
  sh(home, 'init', '-q', '--initial-branch=main', '.');
  fs.writeFileSync(path.join(home, 'Desktop', 'note.typ'), '= Note\n');
  fs.writeFileSync(path.join(home, 'Projects', 'plan', 'plan.typ'), '= Plan\n');
  fs.writeFileSync(path.join(home, '.zsh_history'), 'secret command\n');
  const autosave = new Autosave({ appName: 'Plass', stateDir: folder('state'), log, interval: 60_000, binary, home });
  const window = { id: 'w' };
  lines.length = 0;
  await autosave.setDocument(window, path.join(home, 'Desktop', 'note.typ'));
  assert.equal(autosave.project(window), null);
  await autosave.setDocument(window, path.join(home, 'Projects', 'plan', 'plan.typ'));
  assert.equal(autosave.project(window), null);
  assert.equal(lines.filter((line) => line.includes(`no record for the repository at ${fs.realpathSync(home)}: it is the home folder`)).length, 1, 'said once');
  assert.throws(() => sh(home, 'rev-parse', '--verify', '-q', BRANCH), 'no record branch');
  assert.ok(!fs.existsSync(path.join(home, 'untracked')), 'nothing written under home');
  assert.ok(!fs.existsSync(path.join(home, 'Projects', 'plan', '.git')), 'and no repository of its own below it');
  // A repository of its own below home is a project as ever.
  const own = path.join(home, 'Projects', 'own');
  fs.mkdirSync(own);
  sh(own, 'init', '-q', '--initial-branch=main', '.');
  fs.writeFileSync(path.join(own, 'paper.typ'), '= Paper\n');
  await autosave.setDocument(window, path.join(own, 'paper.typ'));
  const project = autosave.project(window);
  assert.equal(project?.root, fs.realpathSync(own));
  await autosave.setDocument(window, null);
  await project.queue;
  assert.deepEqual(subjects(own), ['plass: session close', 'plass: session open'].slice(-subjects(own).length));
});

test('a hidden folder of the home folder, or a secret-named folder: no record, repository or not', async () => {
  const home = folder('hidden-home');
  const files = {
    aws: path.join(home, '.aws', 'config'),
    gh: path.join(home, '.config', 'gh', 'hosts.yml'),
    nvim: path.join(home, '.config', 'nvim', 'init.lua'),
    ssh: path.join(home, 'Projects', 'proj', '.ssh', 'config'),
  };
  for (const file of Object.values(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'secret\n');
  }
  sh(path.dirname(files.nvim), 'init', '-q', '--initial-branch=main', '.'); // a dotfiles repository in ~/.config/nvim
  sh(path.join(home, 'Projects', 'proj'), 'init', '-q', '--initial-branch=main', '.');
  const autosave = new Autosave({ appName: 'Knuth', stateDir: folder('state'), log, interval: 60_000, binary, home });
  const window = { id: 'w' };
  lines.length = 0;
  for (const [key, file] of Object.entries(files)) {
    await autosave.setDocument(window, file);
    assert.equal(autosave.project(window), null, `no record for ${key}`);
    const reason = key === 'ssh' ? 'a .ssh folder' : 'a hidden folder of the home folder';
    assert.ok(lines.some((line) => line.includes(`no record for ${path.dirname(file)}: it is in ${reason}`)), `${key}: ${reason}`);
  }
  assert.ok(!fs.existsSync(path.join(home, '.aws', '.git')), 'no repository in ~/.aws');
  assert.ok(!fs.existsSync(path.join(home, '.aws', 'untracked')), 'nothing written in ~/.aws');
  assert.ok(!fs.existsSync(path.join(home, '.config', 'gh', '.git')), 'no repository in ~/.config/gh');
  assert.throws(() => sh(path.dirname(files.nvim), 'rev-parse', '--verify', '-q', BRANCH), 'no record in ~/.config/nvim');
  // The rules themselves.
  assert.equal(notProjectFolder(path.join(home, '.ssh'), { home }), 'a hidden folder of the home folder');
  assert.equal(notProjectFolder(path.join(home, '.config', 'gh'), { home }), 'a hidden folder of the home folder');
  assert.equal(notProjectFolder(path.join(home, 'Projects', '.archive', 'x'), { home }), null, 'only folders directly under home');
  assert.equal(secretPlace(path.join(os.homedir(), '.kube')), 'a hidden folder of the home folder');
  assert.equal(secretPlace(path.join(home, 'Projects', 'proj', '.GnuPG')), 'a .GnuPG folder');
  assert.equal(secretPlace(path.join(home, 'Projects', 'proj')), null);
});

test('the guards again just before the ref moves: the branch checked out during a slow commit is not moved', async () => {
  const dir = folder('late-guard');
  sh(dir, 'init', '-q', '--initial-branch=main', '.');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', 'a.txt');
  sh(dir, ...as, 'commit', '-q', '-m', 'a');
  const found = await repositoryOf(binary, dir);
  const slow = slowGit(1);
  const project = new Project({ binary: slow.binary, root: found.root, gitDir: found.gitDir, appName: 'fixture', stateDir: folder('state'), log });
  assert.equal((await project.commit('timer')).committed, true);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  const pending = project.commit('timer');
  for (let i = 0; i < 100 && slow.adds() < 2; i++) await pause(20);
  // While git add sleeps: the user looks at the record, and edits.
  sh(dir, 'checkout', '-q', '-f', BRANCH_NAME);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
  const head = sh(dir, 'rev-parse', 'HEAD');
  const status = sh(dir, 'status', '--porcelain', '--untracked-files=no');
  const result = await pending;
  assert.match(result.skipped ?? '', /checked out/);
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), head, 'HEAD did not move');
  assert.equal(sh(dir, 'rev-parse', BRANCH), head, 'nor the branch');
  assert.equal(sh(dir, 'status', '--porcelain', '--untracked-files=no'), status, 'nothing changed under the user');
});

test('the record being rebased in a linked worktree: skipped, and the rebase continues', async () => {
  const dir = folder('rebased');
  sh(dir, 'init', '-q', '--initial-branch=main', '.');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', 'a.txt');
  sh(dir, ...as, 'commit', '-q', '-m', 'a');
  const project = await projectAt(dir);
  assert.equal((await project.commit('timer')).committed, true);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  assert.equal((await project.commit('timer')).committed, true);
  const look = path.join(work, `rebase-look-${counter++}`);
  sh(dir, 'worktree', 'add', '-q', look, BRANCH_NAME);
  sh(look, ...as, '-c', 'sequence.editor=sed -i.bak s/^pick/edit/', 'rebase', '-q', '-i', 'HEAD~1');
  assert.match(sh(dir, 'worktree', 'list', '--porcelain'), /detached/, 'the worktree is detached while it rebases');
  const tip = sh(dir, 'rev-parse', BRANCH);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
  lines.length = 0;
  const result = await project.commit('timer');
  assert.equal(result.skipped, `${BRANCH_NAME} is being rebased`);
  assert.equal(sh(dir, 'rev-parse', BRANCH), tip, 'the branch did not move');
  assert.ok(lines.some((line) => line.includes(`not recorded while ${BRANCH_NAME} is being rebased`)));
  sh(look, ...as, 'rebase', '--continue');
  assert.equal(sh(look, 'symbolic-ref', 'HEAD'), BRANCH, 'the rebase finished on the branch');
});

test("a symbolic ref at the record's name: skipped, and the branch it points at does not move", async () => {
  const dir = folder('symref');
  sh(dir, 'init', '-q', '--initial-branch=main', '.');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', 'a.txt');
  sh(dir, ...as, 'commit', '-q', '-m', 'a');
  sh(dir, 'symbolic-ref', BRANCH, 'refs/heads/main');
  const main = sh(dir, 'rev-parse', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  const project = await projectAt(dir);
  const result = await project.commit('timer');
  assert.equal(result.skipped, `${BRANCH_NAME} is a symbolic ref`);
  assert.equal(sh(dir, 'rev-parse', 'main'), main, 'main did not move');
  assert.equal(sh(dir, 'status', '--porcelain', '--untracked-files=no'), 'M a.txt');
});

test('symbolic links at untracked/, .claerbout/, the manifest or .gitignore are never followed', async () => {
  const outside = folder('outside');
  const target = path.join(outside, 'zshrc');
  fs.writeFileSync(target, 'export KEEP=1\n');
  const data = path.join(outside, 'home');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'private.txt'), 'private\n');
  const cases = [
    ['manifest', (dir) => {
      fs.mkdirSync(path.join(dir, '.claerbout'));
      fs.symlinkSync(target, path.join(dir, '.claerbout', 'untracked.json'));
    }, '.claerbout/untracked.json or its folder is a symbolic link'],
    ['gitignore', (dir) => fs.symlinkSync(target, path.join(dir, '.gitignore')), '.gitignore is a symbolic link'],
    ['untracked', (dir) => fs.symlinkSync(data, path.join(dir, 'untracked')), 'untracked is a symbolic link'],
    ['claerbout', (dir) => fs.symlinkSync(data, path.join(dir, '.claerbout')), '.claerbout is a symbolic link'],
  ];
  for (const [name, link, said] of cases) {
    const dir = folder(`link-${name}`);
    fs.writeFileSync(path.join(dir, 'doc.py'), 'x = 1\n');
    link(dir);
    const project = await projectAt(dir);
    lines.length = 0;
    assert.equal((await project.commit('timer')).committed, true, `${name}: the rest is recorded`);
    fs.writeFileSync(path.join(dir, 'doc.py'), 'x = 2\n');
    assert.equal((await project.commit('timer')).committed, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'export KEEP=1\n', `${name}: the file outside is byte for byte the same`);
    assert.deepEqual(fs.readdirSync(data), ['private.txt'], `${name}: nothing written in the folder outside`);
    assert.equal(lines.filter((line) => line.includes(said)).length, 1, `${name}: said once`);
    assert.ok(!project.manifest, `${name}: no manifest for this project`);
    const cache = path.join(project.stateDir, 'hashes.json');
    assert.ok(!fs.existsSync(cache) || !fs.readFileSync(cache, 'utf8').includes('private'), `${name}: nothing outside was hashed`);
    assert.ok(!tree(dir).some((entry) => entry.includes('private')), `${name}: nothing outside was recorded`);
  }
});

test('secrets whatever the case, the longer list, tokenizer.py kept; secret files in untracked/ are left out of the manifest', async () => {
  const dir = folder('secrets-case');
  const secrets = [
    'Server.PEM', 'ID_RSA', '.ENV', 'Cert.PFX', 'AuthKey_ABC123.p8', 'login.keychain', 'login.keychain-db', '.htpasswd',
    'id_github', '.token', 'gh.TOKEN', 'CLIENT_SECRET_123.json', 'kaggle.json', 'secrets.toml', '.Renviron', 'putty.ppk', 'vault.kdbx',
  ];
  const kept = ['tokenizer.py', 'tokens.json', 'token_utils.py', 'notes.md', 'keys.md'];
  fs.mkdirSync(path.join(dir, 'sub'));
  for (const name of [...secrets, ...kept]) {
    fs.writeFileSync(path.join(dir, name), 'x\n');
    fs.writeFileSync(path.join(dir, 'sub', name), 'x\n');
  }
  fs.mkdirSync(path.join(dir, 'Deep', '.SSH'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Deep', '.SSH', 'config'), 'Host x\n');
  const project = await projectAt(dir);
  await project.prepare();
  fs.mkdirSync(path.join(dir, 'untracked', 'keys'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'untracked', '.env'), 'PASSWORD=hunter2');
  fs.writeFileSync(path.join(dir, 'untracked', 'keys', 'AuthKey_X.P8'), 'key');
  fs.writeFileSync(path.join(dir, 'untracked', 'data.csv'), 'a,b\n');
  lines.length = 0;
  assert.equal((await project.commit('timer')).committed, true);
  const recorded = tree(dir);
  for (const name of secrets) {
    assert.ok(!recorded.includes(name), `${name} is out`);
    assert.ok(!recorded.includes(`sub/${name}`), `sub/${name} is out`);
  }
  assert.ok(!recorded.includes('Deep/.SSH/config'), 'a secret folder in another case is out');
  for (const name of kept) {
    assert.ok(recorded.includes(name), `${name} is in`);
    assert.ok(recorded.includes(`sub/${name}`), `sub/${name} is in`);
  }
  const manifestText = sh(dir, 'show', `${BRANCH}:.claerbout/untracked.json`);
  assert.deepEqual(JSON.parse(manifestText).files.map((entry) => entry.path), ['untracked/data.csv']);
  assert.ok(!manifestText.includes(sha256('PASSWORD=hunter2')), 'no hash of a secret');
  assert.ok(!manifestText.includes('.env') && !manifestText.includes('AuthKey'), 'nor its name');
  assert.ok(!fs.readFileSync(path.join(project.stateDir, 'hashes.json'), 'utf8').includes('.env'), 'nor in the hash cache');
  assert.equal(lines.filter((line) => line.includes('possible secrets') && line.includes('2 files in untracked/, left out of its manifest')).length, 1);
  // A secret the kept index already holds under another case leaves it.
  assert.equal(isSecret('a/B/SERVER.pem'), true);
  assert.equal(isSecret('untracked/.Aws/config'), true);
  assert.equal(isSecret('tokenizer.py'), false);
});

test('a sparse checkout is recorded: the manifest and new files outside the cone go in, the checkout is as it was', async () => {
  const source = folder('sparse-source');
  sh(source, 'init', '-q', '--initial-branch=main', '.');
  for (const file of ['a/x.txt', 'b/y.txt', 'top.txt']) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), `${file}\n`);
  }
  sh(source, 'add', '.');
  sh(source, ...as, 'commit', '-q', '-m', 'files');
  const dir = path.join(work, `sparse-${counter++}`);
  sh(work, 'clone', '-q', '--sparse', source, dir);
  sh(dir, 'sparse-checkout', 'set', 'a');
  fs.mkdirSync(path.join(dir, 'c'));
  fs.writeFileSync(path.join(dir, 'c', 'z.txt'), 'new, outside the cone\n');
  const cone = sh(dir, 'sparse-checkout', 'list');
  const userIndex = fs.readFileSync(path.join(dir, '.git', 'index'));
  const project = await projectAt(dir);
  lines.length = 0;
  assert.equal((await project.commit('timer')).committed, true);
  const recorded = tree(dir);
  for (const file of ['.claerbout/untracked.json', '.gitignore', 'a/x.txt', 'c/z.txt', 'top.txt']) assert.ok(recorded.includes(file), `${file} is in`);
  assert.ok(!recorded.includes('b/y.txt'), 'what the checkout does not hold is not in the working tree, so not in the record');
  assert.equal(sh(dir, 'sparse-checkout', 'list'), cone, 'the cone is as it was');
  assert.ok(!fs.existsSync(path.join(dir, 'b')), 'nothing outside it was checked out');
  assert.ok(userIndex.equals(fs.readFileSync(path.join(dir, '.git', 'index'))), "the user's index is byte for byte the same");
  assert.ok(!lines.some((line) => /outside of your sparse-checkout|git add/.test(line)), `and nothing to say (${lines.join(' | ')})`);
});

test("git's PATH: the app's own first, then Homebrew's, the system's defaults and the standard folders", () => {
  const saved = process.env.PATH;
  try {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'; // launchd's, a Finder launch
    const dirs = gitEnvironment().PATH.split(path.delimiter);
    assert.deepEqual(dirs.slice(0, 4), ['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) assert.ok(dirs.includes(dir), `${dir} is on it`);
    assert.equal(new Set(dirs).size, dirs.length, 'each folder once');
    process.env.PATH = '/somewhere/own:/usr/bin';
    assert.equal(gitEnvironment().PATH.split(path.delimiter)[0], '/somewhere/own');
    assert.equal(gitEnvironment().GIT_NO_LAZY_FETCH, '1');
  } finally {
    process.env.PATH = saved;
  }
});

test('a required clean filter that cannot run: the commit is skipped, said once, naming the command', async () => {
  for (const [kind, value] of [['process', 'claerbout-no-such-filter filter-process'], ['clean', 'claerbout-no-such-filter clean -- %f']]) {
    const dir = folder(`filter-${kind}`);
    sh(dir, 'init', '-q', '--initial-branch=main', '.');
    sh(dir, 'config', `filter.lfs.${kind}`, value);
    sh(dir, 'config', 'filter.lfs.required', 'true');
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'untracked/\n');
    fs.writeFileSync(path.join(dir, 'data.bin'), 'large\n');
    const project = await projectAt(dir);
    lines.length = 0;
    for (let round = 0; round < 3; round++) {
      fs.writeFileSync(path.join(dir, 'data.bin'), `large ${round}\n`);
      const result = await project.autosave('timer');
      assert.match(result?.skipped ?? '', /clean filter cannot run/, `${kind}: skipped, not an error`);
    }
    const said = lines.filter((line) => line.includes('autosave:'));
    assert.equal(said.length, 1, `${kind}: one line in three rounds (${said.join(' | ')})`);
    assert.match(said[0], /claerbout-no-such-filter/, `${kind}: the line names the command`);
    assert.throws(() => sh(dir, 'rev-parse', '--verify', '-q', BRANCH), 'no record without the filter');
  }
});

test('a failure every tick is said once, until a commit lands again', async () => {
  const dir = folder('failing');
  fs.writeFileSync(path.join(dir, 'doc.py'), 'x = 1\n');
  const found = await repositoryOf(binary, (sh(dir, 'init', '-q', '--initial-branch=main', '.'), dir));
  const failing = failingGit('write-tree', 'fatal: the disk is on fire');
  const project = new Project({ binary: failing.binary, root: found.root, gitDir: found.gitDir, appName: 'fixture', stateDir: folder('state'), log });
  lines.length = 0;
  for (let round = 0; round < 3; round++) assert.equal(await project.autosave('timer'), null);
  assert.equal(lines.filter((line) => line.includes('the disk is on fire')).length, 1, 'said once');
  failing.heal();
  assert.equal((await project.autosave('timer')).committed, true);
  failing.break();
  fs.writeFileSync(path.join(dir, 'doc.py'), 'x = 2\n');
  assert.equal(await project.autosave('timer'), null);
  assert.equal(lines.filter((line) => line.includes('the disk is on fire')).length, 2, 'said again after a commit landed');
});

test('linked worktrees: one branch each, so two open at once never flap; the branch name is git-safe', async () => {
  const main = folder('wt-main');
  sh(main, 'init', '-q', '--initial-branch=main', '.');
  fs.writeFileSync(path.join(main, 'doc.py'), '# %%\n');
  sh(main, 'add', 'doc.py');
  sh(main, ...as, 'commit', '-q', '-m', 'doc');
  const linked = path.join(work, `wt-linked-${counter++}`);
  sh(main, 'worktree', 'add', '-q', linked, '-b', 'feature');
  const linkedBranch = `refs/heads/${BRANCH_NAME}-${path.basename(linked)}`;
  const autosave = new Autosave({ appName: 'Knuth', stateDir: folder('state'), log, interval: 60_000, binary });
  const one = { id: 'main' };
  const two = { id: 'linked' };
  await autosave.setDocument(one, path.join(main, 'doc.py'));
  await autosave.setDocument(two, path.join(linked, 'doc.py'));
  const first = autosave.project(one);
  const second = autosave.project(two);
  assert.notEqual(first, second, 'a project per working tree');
  assert.equal(first.ref, BRANCH);
  assert.equal(second.ref, linkedBranch);
  await first.queue;
  await second.queue;
  assert.deepEqual(subjects(main), ['knuth: session open']);
  assert.deepEqual(subjects(main, linkedBranch), ['knuth: session open']);
  // Nothing changes: no commits, round after round.
  for (let round = 0; round < 3; round++) {
    assert.equal((await first.autosave('timer')).skipped, 'unchanged');
    assert.equal((await second.autosave('timer')).skipped, 'unchanged');
  }
  fs.writeFileSync(path.join(linked, 'doc.py'), '# %%\nx = 1\n');
  assert.equal((await second.autosave('timer')).committed, true);
  assert.equal((await first.autosave('timer')).skipped, 'unchanged', "the linked worktree's edit is not the main one's");
  assert.equal(sh(main, 'show', `${linkedBranch}:doc.py`), '# %%\nx = 1');
  await autosave.quit();
  assert.equal(branchFor({ gitDir: '/r/.git/worktrees/my wt', linked: true }), `${BRANCH_NAME}-my-wt`);
  assert.equal(branchFor({ gitDir: '/r/.git/worktrees/..x.lock', linked: true }), `${BRANCH_NAME}-x-lock`);
  assert.equal(branchFor({ gitDir: '/r/.git', linked: false }), BRANCH_NAME);
  for (const name of ['my wt', '..x.lock', 'a~b^c:d']) {
    sh(main, 'check-ref-format', `refs/heads/${branchFor({ gitDir: `/r/.git/worktrees/${name}`, linked: true })}`);
  }
});

test('an unreadable file is left out, said once, and the rest is recorded', { skip: process.getuid?.() === 0 && 'root reads everything' }, async () => {
  const dir = folder('unreadable');
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'ok\n');
  fs.writeFileSync(path.join(dir, 'locked.txt'), 'locked\n');
  fs.chmodSync(path.join(dir, 'locked.txt'), 0o000);
  try {
    const project = await projectAt(dir);
    lines.length = 0;
    assert.equal((await project.commit('timer')).committed, true);
    assert.ok(tree(dir).includes('ok.txt'));
    assert.ok(!tree(dir).includes('locked.txt'));
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'ok again\n');
    assert.equal((await project.commit('timer')).committed, true);
    assert.equal(lines.filter((line) => line.includes('left out of the record, unreadable: locked.txt')).length, 1);
  } finally {
    fs.chmodSync(path.join(dir, 'locked.txt'), 0o644);
  }
});

test('a nested repository without a commit is left out (said once); with one, it is a gitlink', async () => {
  const dir = folder('nested');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const inner = path.join(dir, 'inner');
  fs.mkdirSync(inner);
  sh(inner, 'init', '-q', '--initial-branch=main', '.');
  fs.writeFileSync(path.join(inner, 'f.txt'), 'f\n');
  const project = await projectAt(dir);
  lines.length = 0;
  assert.equal((await project.commit('timer')).committed, true);
  assert.deepEqual(tree(dir).filter((entry) => entry.startsWith('inner')), []);
  assert.ok(tree(dir).includes('x.txt'));
  fs.writeFileSync(path.join(dir, 'x.txt'), 'y\n');
  assert.equal((await project.commit('timer')).committed, true);
  assert.equal(lines.filter((line) => line.includes('inner/ is a repository without a commit')).length, 1);
  sh(inner, 'add', 'f.txt');
  sh(inner, ...as, 'commit', '-q', '-m', 'f');
  assert.equal((await project.commit('timer')).committed, true);
  assert.match(sh(dir, 'ls-tree', BRANCH, 'inner'), /^160000 commit [0-9a-f]+\tinner$/);
});

test('the manifest and .gitignore are recorded whatever the ignore rules say', async () => {
  const dir = folder('forced');
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.json\n.claerbout/\n.gitignore\n');
  fs.writeFileSync(path.join(dir, 'doc.py'), 'x = 1\n');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}\n');
  const project = await projectAt(dir);
  await project.prepare();
  fs.writeFileSync(path.join(dir, 'untracked', 'data.bin'), 'data');
  assert.equal((await project.commit('timer')).committed, true);
  const recorded = tree(dir);
  assert.ok(recorded.includes('.claerbout/untracked.json'), 'the manifest is in the track');
  assert.ok(recorded.includes('.gitignore'));
  assert.ok(!recorded.includes('settings.json'), 'the rules still apply to everything else');
  assert.ok(!recorded.some((entry) => entry.startsWith('untracked/')));
  const manifest = JSON.parse(sh(dir, 'show', `${BRANCH}:.claerbout/untracked.json`));
  assert.deepEqual(manifest.files.map((entry) => entry.path), ['untracked/data.bin']);
});

test('the kept index: kept between commits, and a file the ignore rules now match leaves the record', async () => {
  const dir = folder('kept');
  fs.writeFileSync(path.join(dir, 'doc.py'), 'x = 1\n');
  fs.writeFileSync(path.join(dir, 'big.csv'), 'a,b\n');
  const project = await projectAt(dir);
  assert.equal((await project.commit('timer')).committed, true);
  assert.ok(tree(dir).includes('big.csv'));
  assert.ok(fs.existsSync(project.index), 'the temporary index is kept');
  fs.appendFileSync(path.join(dir, '.gitignore'), '*.csv\n');
  assert.equal((await project.commit('timer')).committed, true);
  assert.ok(!tree(dir).includes('big.csv'), 'ignored now, so out');
  assert.ok(tree(dir).includes('doc.py'));
  fs.rmSync(path.join(dir, 'doc.py'));
  assert.equal((await project.commit('timer')).committed, true);
  assert.ok(!tree(dir).includes('doc.py'), 'a deleted file leaves the record');
});

test("nothing is written into the user's .git but objects and the record's branch, even with core.splitIndex", async () => {
  const dir = folder('split');
  sh(dir, 'init', '-q', '--initial-branch=main', '.');
  sh(dir, 'config', 'core.splitIndex', 'true');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  sh(dir, 'add', 'a.txt');
  sh(dir, ...as, 'commit', '-q', '-m', 'a');
  const gitDir = path.join(dir, '.git');
  const listing = () =>
    fs
      .readdirSync(gitDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(gitDir, path.join(entry.parentPath ?? entry.path, entry.name)))
      .filter((file) => !file.startsWith(`objects${path.sep}`));
  const before = new Set(listing());
  const userIndex = fs.readFileSync(path.join(gitDir, 'index'));
  const project = await projectAt(dir);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  assert.equal((await project.commit('timer')).committed, true);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'c\n');
  assert.equal((await project.commit('timer')).committed, true);
  const added = listing().filter((file) => !before.has(file));
  assert.deepEqual(added.sort(), [path.join('logs', 'refs', 'heads', BRANCH_NAME), path.join('refs', 'heads', BRANCH_NAME)].sort());
  assert.ok(userIndex.equals(fs.readFileSync(path.join(gitDir, 'index'))), "the user's index is byte for byte the same");
});

test('a file named untracked: no untracked/ handling for that project, said once, and the rest recorded', async () => {
  const dir = folder('untracked-file');
  fs.writeFileSync(path.join(dir, 'untracked'), 'a file, not a folder\n');
  fs.writeFileSync(path.join(dir, 'doc.py'), 'x = 1\n');
  const project = await projectAt(dir);
  lines.length = 0;
  assert.equal((await project.commit('timer')).committed, true);
  fs.writeFileSync(path.join(dir, 'doc.py'), 'x = 2\n');
  assert.equal((await project.commit('timer')).committed, true);
  assert.deepEqual(tree(dir).sort(), ['doc.py', 'untracked']);
  assert.ok(!fs.existsSync(path.join(dir, '.gitignore')), 'no .gitignore line');
  assert.equal(lines.filter((line) => line.includes('untracked exists and is not a folder')).length, 1);
});

test('the timer never piles up: a tick while a commit runs is dropped, not queued', async () => {
  const dir = folder('slow');
  fs.writeFileSync(path.join(dir, 'doc.py'), '# %%\n');
  const slow = slowGit(0.3);
  const autosave = new Autosave({ appName: 'Knuth', stateDir: folder('state'), log, interval: 40, binary: slow.binary });
  const window = { id: 'w' };
  await autosave.setDocument(window, path.join(dir, 'doc.py'));
  const project = autosave.project(window);
  let most = 0;
  for (let i = 0; i < 80; i++) {
    most = Math.max(most, project.pending);
    await pause(25);
  }
  assert.equal(most, 1, 'one job at a time, never a queue of ticks');
  assert.ok(slow.adds() <= 5, `a commit at a time (${slow.adds()} in 2 s; ~50 ticks)`);
  assert.equal(subjects(dir).at(-1), 'knuth: session open');
  await autosave.quit();
});

test('quit waits for a session close already queued and the job under way, and is bounded', async () => {
  const dir = folder('quit-wait');
  fs.writeFileSync(path.join(dir, 'doc.py'), '# %%\n');
  const slow = slowGit(0.3);
  const autosave = new Autosave({ appName: 'Knuth', stateDir: folder('state'), log, interval: 60_000, binary: slow.binary });
  const window = { id: 'w' };
  await autosave.setDocument(window, path.join(dir, 'doc.py'));
  const project = autosave.project(window);
  await project.queue;
  fs.writeFileSync(path.join(dir, 'doc.py'), '# %%\nx = 1\n');
  // The last window closes (its session close queued), and the app quits
  // at once, as window-all-closed does.
  void autosave.closed(window);
  await autosave.quit();
  assert.deepEqual(subjects(dir), ['knuth: session close', 'knuth: session open']);
  assert.ok(!fs.existsSync(project.index), 'the kept index goes at quit');
  // Bounded: a git slower than the limit does not hold the quit.
  const other = folder('quit-bound');
  fs.writeFileSync(path.join(other, 'doc.py'), '# %%\n');
  const slower = slowGit(1.5);
  const bounded = new Autosave({ appName: 'Knuth', stateDir: folder('state'), log, interval: 60_000, binary: slower.binary });
  await bounded.setDocument(window, path.join(other, 'doc.py'));
  const started = Date.now();
  lines.length = 0;
  await bounded.quit(200);
  assert.ok(Date.now() - started < 1000, `quit returned in ${Date.now() - started} ms`);
  assert.ok(lines.some((line) => line.includes('quit before the record was done')));
  await bounded.project(window)?.queue;
  for (const project of bounded.projects.values()) await project.queue;
});

test('the .gitignore line is anchored: a folder named untracked deeper down stays in the user\'s status and in the record', async () => {
  const dir = folder('nested-untracked');
  sh(dir, 'init', '-q', '--initial-branch=main', '.');
  fs.mkdirSync(path.join(dir, 'tests', 'untracked'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'untracked', 'old.txt'), 'old\n');
  sh(dir, 'add', '.');
  sh(dir, ...as, 'commit', '-q', '-m', 'a');
  fs.writeFileSync(path.join(dir, 'tests', 'untracked', 'new.txt'), 'new\n');
  const project = await projectAt(dir);
  assert.equal((await project.commit('timer')).committed, true);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\/untracked\/$/m);
  assert.ok(!/^untracked\/$/m.test(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')), 'no unanchored line');
  const status = sh(dir, 'status', '--porcelain').split('\n');
  assert.ok(status.includes('?? tests/untracked/new.txt'), `the user's git still sees it (${status.join(' | ')})`);
  const recorded = tree(dir);
  assert.ok(recorded.includes('tests/untracked/old.txt'), 'the tracked file is in the record');
  assert.ok(recorded.includes('tests/untracked/new.txt'), 'and the new one');
  // The top-level untracked/ is still ignored, and pinned by the manifest.
  fs.writeFileSync(path.join(dir, 'untracked', 'data.bin'), 'data');
  assert.equal((await project.commit('timer')).committed, true);
  assert.ok(!tree(dir).some((entry) => entry.startsWith('untracked/')));
  assert.deepEqual(JSON.parse(sh(dir, 'show', `${BRANCH}:.claerbout/untracked.json`)).files.map((entry) => entry.path), ['untracked/data.bin']);
});

/** Whether the volume the tests run on ignores letter case (a Mac's, as a rule). */
const ignoresCase = fs.existsSync(path.join(path.dirname(work), path.basename(work).toUpperCase()));

test('a document path in another letter case is judged as the folder it opens: no repository at home, ~/Desktop or ~/.config/gh', { skip: !ignoresCase && 'a case-sensitive volume' }, async () => {
  const home = folder('case-home');
  const files = ['.config/gh/hosts.yml', 'Desktop/note.txt', 'Desktop/Screenshot.png', 'notes.txt', 'Projects/plan/plan.typ'];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    fs.writeFileSync(path.join(home, file), file.includes('hosts') ? 'github.com:\n  oauth_token: gho_SECRET\n' : `${file}\n`);
  }
  // The home folder opened through its upper-cased name: the case a second
  // launch from a terminal, or a page's `document` request, may carry.
  const upper = path.join(path.dirname(home), path.basename(home).toUpperCase());
  assert.ok(fs.existsSync(path.join(upper, '.CONFIG', 'gh', 'hosts.yml')), 'the volume opens it in any case');
  const autosave = new Autosave({ appName: 'Knuth', stateDir: folder('state'), log, interval: 60_000, binary, home });
  const window = { id: 'w' };
  lines.length = 0;
  for (const [file, reason] of [
    [path.join(upper, '.config', 'gh', 'hosts.yml'), 'it is in a hidden folder of the home folder'],
    [path.join(upper, '.CONFIG', 'gh', 'hosts.yml'), 'it is in a hidden folder of the home folder'],
    [path.join(upper, 'desktop', 'note.txt'), "the Desktop folder itself is not a project's folder"],
    [path.join(upper, 'notes.txt'), "the home folder is not a project's folder"],
  ]) {
    await autosave.setDocument(window, file);
    assert.equal(autosave.project(window), null, `no record for ${file}`);
    assert.ok(lines.some((line) => line.includes(`no record for ${path.dirname(file)}: ${reason}`)), `${file}: said with the path as given (${lines.join(' | ')})`);
  }
  const repositories = fs.readdirSync(home, { recursive: true }).filter((entry) => path.basename(entry) === '.git');
  assert.deepEqual(repositories, [], 'no .git anywhere under home');
  for (const dir of ['.config/gh', 'Desktop', '.']) assert.ok(!fs.existsSync(path.join(home, dir, 'untracked')), `nothing written in ${dir}`);
  // A project's folder in another case is a project as ever, at the folder
  // as the disk keeps it, on the main working tree's branch.
  await autosave.setDocument(window, path.join(upper, 'projects', 'PLAN', 'plan.typ'));
  const project = autosave.project(window);
  assert.equal(project?.root, fs.realpathSync.native(path.join(home, 'Projects', 'plan')));
  assert.equal(project.ref, BRANCH);
  await project.queue;
  assert.deepEqual(subjects(path.join(home, 'Projects', 'plan')), ['knuth: session open']);
  await autosave.quit();
  // repositoryOf on a path in another case: the main working tree, not a
  // linked one (its common dir is compared as the disk keeps it).
  const plain = folder('case-plain');
  sh(plain, 'init', '-q', '--initial-branch=main', '.');
  const found = await repositoryOf(binary, path.join(path.dirname(plain), path.basename(plain).toUpperCase()));
  assert.equal(found.linked, false);
  assert.equal(branchFor(found), BRANCH_NAME);
});

/** A path on a Mac's data volume as mounted (/System/Volumes/Data/…), when
 *  this machine has one and it is the same folder. */
function firmlinkForm(dir) {
  const canonical = fs.realpathSync.native(dir);
  const long = `/System/Volumes/Data${canonical}`;
  try {
    const one = fs.statSync(long);
    const two = fs.statSync(canonical);
    return one.dev === two.dev && one.ino === two.ino ? long : null;
  } catch {
    return null;
  }
}

test('a document path in its firmlink form (/System/Volumes/Data/…) is judged as the folder it opens', { skip: !firmlinkForm(work) && 'no data volume mounted at /System/Volumes/Data' }, async () => {
  const home = folder('firm-home');
  for (const file of ['.config/gh/hosts.yml', 'Desktop/note.txt', 'notes.txt', 'Projects/plan/plan.typ']) {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    fs.writeFileSync(path.join(home, file), `${file}\n`);
  }
  const long = firmlinkForm(home);
  const autosave = new Autosave({ appName: 'Plass', stateDir: folder('state'), log, interval: 60_000, binary, home });
  const window = { id: 'w' };
  lines.length = 0;
  for (const [file, reason] of [
    [path.join(long, '.config', 'gh', 'hosts.yml'), 'it is in a hidden folder of the home folder'],
    [path.join(long, 'Desktop', 'note.txt'), "the Desktop folder itself is not a project's folder"],
    [path.join(long, 'notes.txt'), "the home folder is not a project's folder"],
  ]) {
    await autosave.setDocument(window, file);
    assert.equal(autosave.project(window), null, `no record for ${file}`);
    assert.ok(lines.some((line) => line.includes(`no record for ${path.dirname(file)}: ${reason}`)), `${file} (${lines.join(' | ')})`);
  }
  const repositories = fs.readdirSync(home, { recursive: true }).filter((entry) => path.basename(entry) === '.git');
  assert.deepEqual(repositories, [], 'no .git anywhere under home');
  // The rules themselves.
  assert.equal(notProjectFolder(path.join(long, 'Desktop'), { home }), 'the Desktop folder itself');
  assert.equal(secretPlace(path.join(long, '.config', 'gh'), home), 'a hidden folder of the home folder');
  assert.equal(notProjectFolder(path.join(long, 'Projects', 'plan'), { home }), null);
  // The positive control: a project folder through the firmlink form is
  // recorded as itself, on the main record branch, not as a linked
  // worktree of its own repository.
  const plan = path.join(home, 'Projects', 'plan');
  await autosave.setDocument(window, path.join(long, 'Projects', 'plan', 'plan.typ'));
  assert.ok(autosave.project(window), 'a project folder opened through the firmlink form is recorded');
  const found = await repositoryOf(binary, path.join(long, 'Projects', 'plan'));
  assert.equal(found.linked, false, 'not a linked worktree of itself');
  assert.equal(branchFor(found), BRANCH_NAME);
  await autosave.quit();
  assert.doesNotThrow(() => sh(plan, 'rev-parse', '--verify', '-q', BRANCH), 'the record is on the main record branch');
  assert.throws(() => sh(plan, 'rev-parse', '--verify', '-q', `${BRANCH}-git`), 'and not on a worktree branch');
});

test('a repository whose root git reports in a hidden folder of the home folder is refused, whatever folder led to it', async () => {
  const home = folder('redirect-home');
  const hidden = path.join(home, '.config', 'nvim');
  const elsewhere = path.join(home, 'Projects', 'd');
  const store = folder('redirect-store');
  for (const dir of [hidden, elsewhere]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(hidden, 'init.lua'), 'secret\n');
  fs.writeFileSync(path.join(elsewhere, 'doc.typ'), '= Doc\n');
  // A folder whose .git points at a repository with its working tree in
  // ~/.config/nvim: the folder passes, the root git reports does not.
  sh(store, 'init', '-q', '--initial-branch=main', '.');
  sh(store, 'config', 'core.worktree', hidden);
  fs.writeFileSync(path.join(elsewhere, '.git'), `gitdir: ${path.join(store, '.git')}\n`);
  const autosave = new Autosave({ appName: 'Plass', stateDir: folder('state'), log, interval: 60_000, binary, home });
  const window = { id: 'w' };
  lines.length = 0;
  await autosave.setDocument(window, path.join(elsewhere, 'doc.typ'));
  assert.equal(autosave.project(window), null);
  fs.mkdirSync(path.join(elsewhere, 'sub'));
  await autosave.setDocument(window, path.join(elsewhere, 'sub', 'doc.typ'));
  assert.equal(autosave.project(window), null);
  const said = lines.filter((line) => line.includes(`no record for the repository at ${fs.realpathSync.native(hidden)}: it is in a hidden folder of the home folder`));
  assert.equal(said.length, 1, `said once (${lines.join(' | ')})`);
  assert.throws(() => sh(store, 'rev-parse', '--verify', '-q', BRANCH), 'no record branch');
  assert.ok(!fs.existsSync(path.join(hidden, 'untracked')), 'nothing written in ~/.config/nvim');
  await autosave.quit();
});

test('the error line is the last one that is not a hint or a warning', () => {
  assert.equal(errorLine("error: 'Desktop/' does not have a commit checked out\nhint: You've added another git repository\nhint: Disable this message"), "error: 'Desktop/' does not have a commit checked out");
  assert.equal(errorLine('fatal: bad\nwarning: careful\n'), 'fatal: bad');
  assert.equal(errorLine('hint: only advice'), 'hint: only advice');
  assert.equal(errorLine(''), '');
  // A filter process that never started: the cause, not git's wrap-up.
  const missing = 'git-lfs filter-process: git-lfs: command not found\nfatal: the remote end hung up unexpectedly';
  assert.equal(errorLine(missing), 'git-lfs filter-process: git-lfs: command not found');
  assert.equal(errorLine('fatal: the remote end hung up unexpectedly'), 'fatal: the remote end hung up unexpectedly');
  assert.equal(filterFailure(missing), 'git-lfs filter-process: git-lfs: command not found');
  assert.equal(filterFailure("error: external filter 'x' failed 1\nfatal: a.bin: clean filter 'crypt' failed"), "error: external filter 'x' failed 1");
  assert.equal(filterFailure('fatal: something else'), null);
});
