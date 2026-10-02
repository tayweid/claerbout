// The history view's git (history.js) against real git in temporary
// repositories: the subject parser; a graph with the record, a user branch
// and a fork (two roots, the lines, the refs, exact and near ties,
// paging); what one commit changed and a file at a commit; what a rewind
// would do; and the rewind: it writes the target's files and leaves the
// user's HEAD, branch and index as they were, the record gets "rewind
// from" and "rewind to", files outside the write set keep their mtimes,
// a stale tip and every guard refuse it, a path the record never held is
// not removed, untracked/ and the manifest are untouched, a commit on a
// user branch removes nothing, a partial rewind writes only its paths, a
// file the record does not keep is never overwritten, a .gitignore
// without /untracked/ gets its line back, another app's document refuses
// it unless the request says anyway, and a window that could not save
// refuses it. Everything lives under os.tmpdir(); the user's git
// configuration is kept out (GIT_CONFIG_GLOBAL points at an empty file).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claerbout-history-'));
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');

const { Project, repositoryOf, findGit, BRANCH, MANIFEST } = require('../autosave.js');
const history = require('../history.js');
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
const at = (cwd, seconds, ...args) =>
  execFileSync(binary, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: `@${seconds} +0000`, GIT_COMMITTER_DATE: `@${seconds} +0000` },
  }).trim();
const now = () => Math.floor(Date.now() / 1000);
const subjects = (cwd, ref = BRANCH) => sh(cwd, 'log', '--format=%s', ref).split('\n').filter(Boolean);
const write = (dir, file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const exists = (dir, file) => fs.existsSync(path.join(dir, file));

/** A project on a folder with a repository whose main has one commit. */
async function projectAt(dir, appName = 'fixture') {
  if ((await repositoryOf(binary, dir)) === null) sh(dir, 'init', '-q', '--initial-branch=main', '.');
  const found = await repositoryOf(binary, dir);
  return new Project({ binary, root: found.root, gitDir: found.gitDir, commonDir: found.commonDir, appName, stateDir: folder('state'), log });
}
/** What the user's side of a repository is: HEAD, its branch, the index. */
const userSide = (dir) => ({
  head: sh(dir, 'rev-parse', '--verify', '-q', 'HEAD'),
  branch: sh(dir, 'symbolic-ref', 'HEAD'),
  index: sh(dir, 'ls-files', '--stage'),
  staged: sh(dir, 'diff', '--cached', '--name-only'),
});

after(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

test('the subject parser reads what the record writes', () => {
  assert.deepEqual(history.parseSubject('knuth: cell run [4]'), { app: 'knuth', trigger: 'run', cells: [4] });
  assert.deepEqual(history.parseSubject('knuth: cell run [1, 2, 3] (error)'), { app: 'knuth', trigger: 'run', cells: [1, 2, 3], error: true });
  assert.deepEqual(history.parseSubject('plass: timer'), { app: 'plass', trigger: 'timer' });
  assert.deepEqual(history.parseSubject('knuth: session open'), { app: 'knuth', trigger: 'open' });
  assert.deepEqual(history.parseSubject('knuth: session close'), { app: 'knuth', trigger: 'close' });
  const sha = 'a'.repeat(40);
  assert.deepEqual(history.parseSubject(`knuth: rewind from ${sha}`), { app: 'knuth', trigger: 'rewind-from', from: sha });
  assert.deepEqual(history.parseSubject(`knuth: rewind to ${sha}`), { app: 'knuth', trigger: 'rewind-to', target: sha });
  assert.deepEqual(history.parseSubject(`knuth: rewind to ${sha} (a.py, b.json)`), {
    app: 'knuth',
    trigger: 'rewind-to',
    target: sha,
    paths: ['a.py', 'b.json'],
    partial: 2,
  });
  assert.deepEqual(history.parseSubject(`knuth: rewind to ${sha} (3 files)`), { app: 'knuth', trigger: 'rewind-to', target: sha, partial: 3 });
  assert.deepEqual(history.parseSubject('knuth: something else'), { app: 'knuth', trigger: 'notice' });
  assert.deepEqual(history.parseSubject('Week 3 starter files'), { app: null, trigger: 'notice' });
  // The message the rewind writes is the one the parser reads.
  assert.equal(history.rewindToTrigger(sha, null), `rewind to ${sha}`);
  assert.equal(history.rewindToTrigger(sha, ['a.py', 'b.json']), `rewind to ${sha} (a.py, b.json)`);
  assert.equal(history.rewindToTrigger(sha, ['a', 'b', 'c']), `rewind to ${sha} (3 files)`);
  assert.equal(history.rewindToTrigger(sha, ['x'.repeat(80)]), `rewind to ${sha} (1 file)`);
  assert.equal(history.parseSubject(`knuth: ${history.rewindToTrigger(sha, ['x'.repeat(80)])}`).partial, 1);
});

test('a graph: the record and a user branch with a fork, two roots, their lines and refs, and ties', async () => {
  const dir = folder('graph');
  const project = await projectAt(dir);
  const start = now();
  write(dir, 'a.txt', 'one\n');
  write(dir, 'b.txt', 'b\n');
  sh(dir, 'add', 'a.txt', 'b.txt');
  at(dir, start - 1000, 'commit', '-q', '-m', 'Starter files');
  const first = sh(dir, 'rev-parse', 'HEAD');
  assert.equal((await project.commit('session open')).committed, true);
  write(dir, 'b.txt', 'b, later\n');
  const run = await project.commit('cell run [1]');
  assert.equal(run.committed, true);
  sh(dir, 'add', 'b.txt');
  at(dir, start + 100, 'commit', '-q', '-m', 'B on main');
  const onMain = sh(dir, 'rev-parse', 'HEAD');
  // A fork from the starter commit, with a file the record never had.
  sh(dir, 'branch', 'feature', first);
  const worktree = path.join(work, `feature-wt-${counter++}`);
  sh(dir, 'worktree', 'add', '-q', worktree, 'feature');
  write(worktree, 'a.txt', 'feature\n');
  sh(worktree, 'add', 'a.txt');
  at(worktree, start + 200, 'commit', '-q', '-m', 'On the feature');
  const onFeature = sh(worktree, 'rev-parse', 'HEAD');
  sh(dir, 'worktree', 'remove', '--force', worktree);

  const answer = await history.graph(project);
  assert.equal(answer.tip, run.hash);
  assert.equal(answer.total, 2);
  assert.equal(answer.more, false);
  assert.deepEqual(answer.head, { branch: 'main', sha: onMain });
  assert.deepEqual(
    answer.branches.map((branch) => [branch.name, branch.tip, branch.head]).sort(),
    [
      ['feature', onFeature, false],
      ['main', onMain, true],
    ],
  );
  const bySha = new Map(answer.commits.map((commit) => [commit.sha, commit]));
  assert.equal(answer.commits.length, 5, 'two record commits and three of the user');
  // The record: its own line, its messages parsed, a root of its own.
  const record = answer.commits.filter((commit) => commit.line === 'record');
  assert.deepEqual(record.map((commit) => commit.subject), ['fixture: cell run [1]', 'fixture: session open']);
  assert.equal(record[0].trigger, 'run');
  assert.deepEqual(record[0].cells, [1]);
  assert.equal(record[1].trigger, 'open');
  assert.deepEqual(record[1].parents, [], "the record's first commit is a root");
  assert.deepEqual(record[0].parents, [record[1].sha]);
  assert.deepEqual(record[0].refs, ['claerbout-autosave']);
  assert.equal(record[0].files, 1);
  assert.deepEqual(record[0].changed, ['b.txt']);
  assert.equal(record[0].plus, 1);
  assert.equal(record[0].minus, 1);
  assert.equal(record[0].author, undefined);
  // The user's commits: reached by their branches, the fork's parent is
  // the starter commit, main's first commit is the other root.
  assert.equal(bySha.get(onMain).line, 'main');
  assert.deepEqual(bySha.get(onMain).refs, ['main']);
  assert.equal(bySha.get(onFeature).line, 'feature');
  assert.deepEqual(bySha.get(onFeature).parents, [first]);
  assert.deepEqual(bySha.get(first).parents, []);
  assert.equal(bySha.get(first).author, 'T');
  assert.match(bySha.get(first).time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)$/);
  // Ties: B holds the files the run recorded, byte for byte; the fork's
  // a.txt is in no record commit; the starter came before the record.
  assert.deepEqual(bySha.get(onMain).tie, { sha: run.hash, exact: true });
  // The fork has the starter's b.txt, which the session open recorded and
  // the run changed: the nearest is the session open, a.txt apart.
  assert.deepEqual(bySha.get(onFeature).tie, { sha: record[1].sha, exact: false, differs: ['a.txt'] });
  assert.equal(bySha.get(first).tie, null);
  // Paging: the newest two, then the rest before the oldest of them.
  const page = await history.graph(project, { limit: 2 });
  assert.equal(page.commits.length, 2);
  assert.equal(page.more, true);
  const rest = await history.graph(project, { before: page.commits.at(-1).sha });
  const all = new Set([...page.commits, ...rest.commits].map((commit) => commit.sha));
  assert.equal(all.size, 5, 'the pages together hold every commit');
  // The record's commits since a tip, for the history events.
  const since = await history.recordSince(project, record[1].sha, record[0].sha);
  assert.deepEqual(since.map((commit) => [commit.sha, commit.trigger, commit.line]), [[run.hash, 'run', 'record']]);
  assert.equal(await history.recordTip(project), run.hash);
});

test('a graph before the record began: no tip, the user branch alone', async () => {
  const dir = folder('graph-empty');
  const project = await projectAt(dir);
  const empty = await history.graph(project);
  assert.deepEqual([empty.tip, empty.commits, empty.total], [null, [], 0]);
  write(dir, 'a.txt', 'a\n');
  sh(dir, 'add', 'a.txt');
  at(dir, now(), 'commit', '-q', '-m', 'first');
  const answer = await history.graph(project);
  assert.equal(answer.tip, null);
  assert.deepEqual(answer.commits.map((commit) => [commit.subject, commit.line, commit.tie]), [['first', 'main', null]]);
});

test('what one commit changed, and a file at a commit', async () => {
  const dir = folder('detail');
  const project = await projectAt(dir);
  write(dir, 'a.txt', 'one\ntwo\n');
  write(dir, 'bin.dat', Buffer.from([0, 1, 2, 3]));
  const opened = await project.commit('session open');
  write(dir, 'a.txt', 'one\nthree\n');
  fs.rmSync(path.join(dir, 'bin.dat'));
  write(dir, 'new.txt', 'new\n');
  const run = await project.commit('cell run [2]');
  const detail = await history.commitDetail(project, run.hash);
  assert.equal(detail.sha, run.hash);
  assert.deepEqual(detail.parents, [opened.hash]);
  assert.equal(detail.subject, 'fixture: cell run [2]');
  const files = new Map(detail.files.map((file) => [file.path, file]));
  assert.deepEqual([files.get('a.txt').status, files.get('a.txt').plus, files.get('a.txt').minus], ['M', 1, 1]);
  assert.match(files.get('a.txt').patch, /^@@ .*\n one\n-two\n\+three$/);
  assert.equal(files.get('bin.dat').status, 'D');
  assert.equal(files.get('bin.dat').binary, true);
  assert.equal(files.get('new.txt').status, 'A');
  // The first commit is against the empty tree.
  const root = await history.commitDetail(project, opened.hash);
  assert.ok(root.files.every((file) => file.status === 'A'));
  assert.ok(root.files.some((file) => file.path === 'a.txt'));
  assert.deepEqual(await history.blob(project, opened.hash, 'a.txt'), { text: 'one\ntwo\n', size: 8 });
  assert.deepEqual(await history.blob(project, opened.hash, 'bin.dat'), { binary: true, size: 4 });
  assert.equal((await history.blob(project, run.hash, 'bin.dat')).missing, true);
  await assert.rejects(history.blob(project, '--output=/tmp/x', 'a.txt'), /hex name/);
  await assert.rejects(history.commitDetail(project, 'f'.repeat(40)), /no commit/);
});

/** A project with a record of two commits: `first` holds a.txt one,
 *  notes/x.txt and keep.txt; `second` holds a.txt two, keep.txt and c.txt
 *  (notes/x.txt removed). main has one commit, and a file staged. */
async function recorded(name) {
  const dir = folder(name);
  const project = await projectAt(dir);
  write(dir, 'start.txt', 'start\n');
  sh(dir, 'add', 'start.txt');
  at(dir, now() - 500, 'commit', '-q', '-m', 'start');
  write(dir, 'staged.txt', 'staged\n');
  sh(dir, 'add', 'staged.txt');
  write(dir, 'a.txt', 'one\n');
  write(dir, 'notes/x.txt', 'x\n');
  write(dir, 'keep.txt', 'keep\n');
  const first = (await project.commit('session open')).hash;
  write(dir, 'a.txt', 'two\n');
  fs.rmSync(path.join(dir, 'notes'), { recursive: true });
  write(dir, 'c.txt', 'c\n');
  const second = (await project.commit('timer')).hash;
  return { dir, project, first, second };
}

test('a rewind writes the target\'s files, records from and to, and leaves HEAD, the branch and the index untouched', async () => {
  const { dir, project, first, second } = await recorded('rewind');
  write(dir, 'a.txt', 'three\n'); // not yet recorded
  const before = userSide(dir);
  const keepTime = fs.statSync(path.join(dir, 'keep.txt')).mtimeMs;
  const steps = [];
  const preview = await history.compare(project, first);
  assert.equal(preview.tip, second);
  assert.equal(preview.blocked, null);
  assert.equal(preview.onRecord, true);
  assert.deepEqual(preview.unrecorded, ['a.txt']);
  assert.deepEqual(preview.write, [
    { path: 'a.txt', status: 'M' },
    { path: 'notes/x.txt', status: 'A' },
  ]);
  assert.deepEqual(preview.remove, ['c.txt']);
  assert.ok(preview.same >= 2, 'keep.txt and start.txt are the same at both moments');
  // The page reads now's files from the fresh fill's tree.
  assert.equal((await history.blob(project, preview.now, 'a.txt')).text, 'three\n');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await history.rewind(project, { sha: first, tip: second }, { onStep: (step, state) => steps.push(`${step} ${state}`) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.target, first);
  assert.deepEqual(result.written, ['a.txt', 'notes/x.txt']);
  assert.deepEqual(result.removed, ['c.txt']);
  assert.deepEqual(steps, ['save doing', 'save done', 'record-from doing', 'record-from done', 'write doing', 'write done', 'record-to doing', 'record-to done']);
  // The files are the target's.
  assert.equal(read(dir, 'a.txt'), 'one\n');
  assert.equal(read(dir, 'notes/x.txt'), 'x\n');
  assert.ok(!exists(dir, 'c.txt'));
  assert.equal(fs.statSync(path.join(dir, 'keep.txt')).mtimeMs, keepTime, 'a file outside the write set keeps its mtime');
  // The record only grew: from, then to; from holds the unrecorded edit.
  assert.deepEqual(subjects(dir), [`fixture: rewind to ${first}`, `fixture: rewind from ${second}`, 'fixture: timer', 'fixture: session open']);
  assert.equal(sh(dir, 'rev-parse', `${BRANCH}~1`), result.from);
  assert.equal(sh(dir, 'rev-parse', BRANCH), result.to);
  assert.equal(sh(dir, 'show', `${result.from}:a.txt`), 'three');
  assert.equal(sh(dir, 'rev-parse', `${result.to}^{tree}`), sh(dir, 'rev-parse', `${first}^{tree}`), 'the rewind lands on the target\'s tree');
  // The user's side is as it was.
  assert.deepEqual(userSide(dir), before);
  assert.ok(!exists(dir, '.git/index.lock'));
  // The graph parses both.
  const answer = await history.graph(project);
  assert.equal(answer.commits[0].trigger, 'rewind-to');
  assert.equal(answer.commits[0].target, first);
  assert.equal(answer.commits[1].trigger, 'rewind-from');
  assert.equal(answer.commits[1].from, second);
  // Undo is one more rewind, to the "rewind from" commit.
  const undo = await history.rewind(project, { sha: result.from, tip: result.to });
  assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.equal(undo.from, null, 'nothing new to record first');
  assert.equal(read(dir, 'a.txt'), 'three\n');
  assert.equal(read(dir, 'c.txt'), 'c\n');
  assert.ok(!exists(dir, 'notes'), 'a removed file\'s empty folder goes too');
  assert.deepEqual(userSide(dir), before);
});

test('a stale tip is refused, and nothing is written', async () => {
  const { dir, project, first } = await recorded('stale');
  const result = await history.rewind(project, { sha: first, tip: first });
  assert.deepEqual(result, { refused: 'moved', tip: sh(dir, 'rev-parse', BRANCH) });
  assert.equal(read(dir, 'a.txt'), 'two\n');
  assert.equal(subjects(dir).length, 2);
});

test('the record\'s guards refuse a rewind: a merge in progress, index.lock, the record checked out', async () => {
  const { dir, project, first, second } = await recorded('guards');
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), '0'.repeat(40));
  assert.deepEqual(await history.rewind(project, { sha: first, tip: second }), { refused: 'paused', reason: 'merge in progress' });
  assert.equal((await history.compare(project, first)).blocked, 'merge in progress');
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'));
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');
  assert.deepEqual(await history.rewind(project, { sha: first, tip: second }), { refused: 'paused', reason: 'index.lock exists' });
  fs.rmSync(path.join(dir, '.git', 'index.lock'));
  const worktree = path.join(work, `record-wt-${counter++}`);
  sh(dir, 'worktree', 'add', '-q', worktree, 'claerbout-autosave');
  assert.deepEqual(await history.rewind(project, { sha: first, tip: second }), { refused: 'paused', reason: 'claerbout-autosave is checked out' });
  sh(dir, 'worktree', 'remove', '--force', worktree);
  assert.equal(read(dir, 'a.txt'), 'two\n');
  assert.equal(subjects(dir).length, 2, 'nothing was recorded');
});

test('a path the record never held is not removed', async () => {
  const { dir, project, first, second } = await recorded('never-held');
  write(dir, 'fresh.txt', 'made since the last commit\n');
  write(dir, '.gitignore', `${read(dir, '.gitignore')}*.log\n`);
  write(dir, 'debug.log', 'ignored\n');
  const result = await history.rewind(project, { sha: first, tip: second });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(read(dir, 'fresh.txt'), 'made since the last commit\n', 'a file the record never held stays');
  assert.equal(read(dir, 'debug.log'), 'ignored\n', 'an ignored file stays');
  assert.ok(!exists(dir, 'c.txt'), 'a file the record held is removed');
  assert.equal(sh(dir, 'show', `${result.from}:fresh.txt`), 'made since the last commit', 'and it is in the record now');
});

test('untracked/ and the manifest are never written or removed by a rewind', async () => {
  const dir = folder('untracked');
  const project = await projectAt(dir);
  write(dir, 'a.txt', 'one\n');
  write(dir, 'untracked/data.csv', 'x,y\n1,2\n');
  const first = (await project.commit('session open')).hash;
  assert.match(sh(dir, 'show', `${first}:${MANIFEST}`), /untracked\/data\.csv/);
  write(dir, 'a.txt', 'two\n');
  write(dir, 'untracked/data.csv', 'x,y\n3,4\n');
  write(dir, 'untracked/more.csv', 'more\n');
  const second = (await project.commit('timer')).hash;
  const manifest = read(dir, MANIFEST);
  const preview = await history.compare(project, first);
  assert.equal(preview.untracked, true);
  assert.deepEqual(preview.untrackedGone, ['untracked/data.csv']);
  assert.ok(!preview.write.some((entry) => entry.path.startsWith('untracked') || entry.path === MANIFEST));
  const result = await history.rewind(project, { sha: first, tip: second });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.written, ['a.txt']);
  assert.equal(read(dir, 'untracked/data.csv'), 'x,y\n3,4\n');
  assert.equal(read(dir, 'untracked/more.csv'), 'more\n');
  assert.equal(read(dir, MANIFEST), manifest, 'the manifest says what untracked/ holds now');
  assert.equal(sh(dir, 'show', `${result.to}:${MANIFEST}`), manifest.trim());
});

test('a rewind to a commit on a user branch writes the files it holds and removes nothing it lacks', async () => {
  const dir = folder('user-branch');
  const project = await projectAt(dir);
  write(dir, 'analysis.py', 'v1\n');
  sh(dir, 'add', 'analysis.py');
  at(dir, now() - 100, 'commit', '-q', '-m', 'Starter');
  const starter = sh(dir, 'rev-parse', 'HEAD');
  write(dir, 'analysis.py', 'v2\n');
  write(dir, 'paper.typ', 'never committed on main\n');
  const tip = (await project.commit('session open')).hash;
  const before = userSide(dir);
  const preview = await history.compare(project, starter);
  assert.equal(preview.onRecord, false);
  assert.deepEqual(preview.remove, []);
  assert.ok(preview.kept.includes('paper.typ'));
  const result = await history.rewind(project, { sha: starter, tip });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.written, ['analysis.py']);
  assert.deepEqual(result.removed, []);
  assert.equal(read(dir, 'analysis.py'), 'v1\n');
  assert.equal(read(dir, 'paper.typ'), 'never committed on main\n');
  assert.deepEqual(userSide(dir), before, 'main stays where it is');
});

test('a partial rewind writes only its paths, and its message names them', async () => {
  const { dir, project, first, second } = await recorded('partial');
  const result = await history.rewind(project, { sha: first, tip: second, paths: ['notes/x.txt'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.written, ['notes/x.txt']);
  assert.deepEqual(result.removed, []);
  assert.equal(read(dir, 'a.txt'), 'two\n');
  assert.equal(read(dir, 'c.txt'), 'c\n');
  assert.equal(subjects(dir)[0], `fixture: rewind to ${first} (notes/x.txt)`);
  assert.equal(result.from, null, 'the working tree was the tip, so nothing was recorded first');
  // Nothing to change is said, not recorded.
  const tip = sh(dir, 'rev-parse', BRANCH);
  assert.deepEqual(await history.rewind(project, { sha: tip, tip }), { same: true });
});

test('"rewind to" lands even when its tree equals the tip\'s', async () => {
  const dir = folder('always');
  const project = await projectAt(dir);
  write(dir, 'a.txt', 'a\n');
  await project.commit('session open');
  assert.equal((await project.commit('timer')).skipped, 'unchanged');
  const landed = await project.commit('rewind to x', { always: true });
  assert.equal(landed.committed, true);
  assert.equal(sh(dir, 'rev-parse', `${BRANCH}^{tree}`), sh(dir, 'rev-parse', `${BRANCH}~1^{tree}`));
});

test('a file the record does not keep is never overwritten, and a .gitignore without /untracked/ gets its line back', async () => {
  const dir = folder('in-the-way');
  const project = await projectAt(dir);
  write(dir, '.gitignore', 'build/\n');
  write(dir, 'debug.log', 'committed on main\n');
  write(dir, 'a.txt', 'a\n');
  sh(dir, 'add', '.gitignore', 'debug.log', 'a.txt');
  at(dir, now() - 100, 'commit', '-q', '-m', 'Before the record');
  const old = sh(dir, 'rev-parse', 'HEAD');
  write(dir, '.gitignore', 'build/\n*.log\n');
  write(dir, 'debug.log', 'the local log, ignored now\n');
  write(dir, 'a.txt', 'b\n');
  write(dir, 'untracked/big.bin', 'big\n');
  const tip = (await project.commit('session open')).hash;
  assert.match(read(dir, '.gitignore'), /^\/untracked\/$/m);
  const result = await history.rewind(project, { sha: old, tip });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(read(dir, 'debug.log'), 'the local log, ignored now\n', 'the ignored file is not overwritten');
  assert.ok(result.skipped.some((entry) => entry.path === 'debug.log'));
  assert.equal(read(dir, 'a.txt'), 'a\n');
  assert.match(read(dir, '.gitignore'), /^build\/\n/, "the target's .gitignore was written");
  assert.match(read(dir, '.gitignore'), /^\/untracked\/$/m, 'and the record added its line again');
  const kept = sh(dir, 'ls-tree', '-r', '--name-only', result.to).split('\n');
  assert.ok(!kept.some((file) => file.startsWith('untracked/')), 'untracked/ stayed out of the record');
});

test('another app\'s document refuses a rewind unless the request says anyway; a window that could not save refuses it', async () => {
  const { dir, project, first, second } = await recorded('other-app');
  const presence = history.presence(folder('presence'));
  presence.write('plass', project.root, [path.join(dir, 'a.txt')]);
  presence.write('fixture', project.root, [path.join(dir, 'keep.txt')]);
  presence.write('plass', '/elsewhere', [path.join(dir, 'a.txt')]);
  const others = () => presence.others(project.root, 'fixture');
  assert.deepEqual(others(), [{ app: 'plass', documents: [path.join(dir, 'a.txt')] }]);
  assert.deepEqual((await history.compare(project, first, { others })).others, others());
  const refused = await history.rewind(project, { sha: first, tip: second }, { others });
  assert.deepEqual(refused, { refused: 'other-app', app: 'plass', documents: [path.join(dir, 'a.txt')] });
  assert.equal(read(dir, 'a.txt'), 'two\n');
  // Without the file the other app holds, it goes through.
  const unsaved = await history.rewind(project, { sha: first, tip: second, anyway: true }, { others, save: async () => ({ path: path.join(dir, 'a.txt') }) });
  assert.deepEqual(unsaved, { refused: 'unsaved', path: path.join(dir, 'a.txt') });
  assert.equal(read(dir, 'a.txt'), 'two\n');
  assert.equal(subjects(dir).length, 2);
  const result = await history.rewind(project, { sha: first, tip: second, anyway: true }, { others });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(read(dir, 'a.txt'), 'one\n');
  // A presence file whose app is gone is ignored; an empty one is removed.
  presence.write('ghost', project.root, [path.join(dir, 'a.txt')]);
  const ghost = fs.readdirSync(presence.dir).find((name) => name.startsWith('ghost-'));
  const entry = JSON.parse(fs.readFileSync(path.join(presence.dir, ghost), 'utf8'));
  fs.writeFileSync(path.join(presence.dir, ghost), JSON.stringify({ ...entry, pid: 2 ** 22 + 12345 }));
  assert.deepEqual(others().map((other) => other.app), ['plass']);
  presence.write('plass', project.root, []);
  assert.deepEqual(others(), []);
});
