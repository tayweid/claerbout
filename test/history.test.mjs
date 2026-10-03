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
// refuses it; from the third pass: a commit whose file is a tree, or whose
// contents the repository lacks (a crafted one, a partial clone's), or
// whose tree git cannot list, is refused whole, and the working tree never
// holds a .gitignore without /untracked/ while another app commits; and from
// its review: the graph still draws such commits (a partial clone's among
// them), git's refusal names a path with a quote or a newline whole, one
// rewind at a time writes a working tree while every other shell's commits
// wait, the new .gitignore is made in the state folder, and a file named
// untracked, or a folder named .gitignore, in a commit is left alone and
// named; and a file .claerbout/ignore keeps out, and the rules themselves,
// are left alone and named.
// Everything lives under os.tmpdir(); the user's git configuration is kept
// out (GIT_CONFIG_GLOBAL points at an empty file).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claerbout-history-'));
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');

const { Project, repositoryOf, findGit, BRANCH, MANIFEST, IGNORE_LINES } = require('../autosave.js');
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
  assert.deepEqual(await history.rewind(project, { sha: first, tip: second }), { refused: 'paused', reason: 'a merge is in progress on main' });
  assert.equal((await history.compare(project, first)).blocked, 'a merge is in progress on main');
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'));
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');
  assert.deepEqual(await history.rewind(project, { sha: first, tip: second }), { refused: 'paused', reason: 'git holds index.lock' });
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
  const unsaved = await history.rewind(project, { sha: first, tip: second, anyway: true }, { others, save: async () => ({ unsaved: { path: path.join(dir, 'a.txt'), error: 'the disk is full' } }) });
  assert.deepEqual(unsaved, { refused: 'unsaved', path: path.join(dir, 'a.txt'), error: 'the disk is full' });
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

// From the second review: the rewind's safety and the page's numbers.

const treeName = (dir, rev) => sh(dir, 'rev-parse', `${rev}^{tree}`);
/** An object written as it is given, so a test can craft what git itself
 *  would never make. */
const object = (dir, type, content) =>
  execFileSync(binary, ['hash-object', '-t', type, '--literally', '-w', '--stdin'], { cwd: dir, input: content, stdio: ['pipe', 'pipe', 'pipe'] })
    .toString()
    .trim();
const blobNamed = (dir, text) => object(dir, 'blob', Buffer.from(text));
const treeNamed = (dir, entries) =>
  object(dir, 'tree', Buffer.concat(entries.map(([mode, name, sha]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, 'hex')]))));
/** A tree's top entries as [mode, name, sha]. */
const topOf = (dir, tree) =>
  sh(dir, 'ls-tree', '-z', tree)
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, name] = line.split('\t');
      const [mode, , sha] = meta.split(' ');
      return [mode, name, sha];
    });
const listing = (dir) => fs.readdirSync(dir).sort();

test('a file that becomes a folder, and a folder that becomes a link, are rewound both ways, onto the target\'s own tree', async () => {
  const dir = folder('swap');
  const project = await projectAt(dir);
  const elsewhere = folder('elsewhere');
  write(elsewhere, 'file.txt', 'outside\n');
  write(dir, 'keep.txt', 'keep\n');
  write(dir, 'results', 'a file\n');
  write(dir, 'dir/file.txt', 'in a folder\n');
  const asFiles = (await project.commit('session open')).hash;
  fs.rmSync(path.join(dir, 'results'));
  write(dir, 'results/a.csv', 'x,y\n');
  fs.rmSync(path.join(dir, 'dir'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(dir, 'dir'));
  const asFolders = (await project.commit('timer')).hash;
  // results is a folder now and a file in the target; dir a link now and a
  // folder there: what this same set removes is no obstacle.
  const preview = await history.compare(project, asFiles);
  assert.deepEqual(preview.skipped, []);
  assert.deepEqual(preview.write.map((entry) => entry.path).sort(), ['dir/file.txt', 'results']);
  assert.deepEqual([...preview.remove].sort(), ['dir', 'results/a.csv']);
  const back = await history.rewind(project, { sha: asFiles, tip: asFolders });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.deepEqual(back.skipped, []);
  assert.equal(read(dir, 'results'), 'a file\n');
  assert.ok(fs.lstatSync(path.join(dir, 'dir')).isDirectory(), 'the link went, and a folder came back');
  assert.equal(read(dir, 'dir/file.txt'), 'in a folder\n');
  assert.deepEqual(listing(elsewhere), ['file.txt']);
  assert.equal(read(elsewhere, 'file.txt'), 'outside\n', 'nothing was written through the link');
  assert.equal(treeName(dir, back.to), treeName(dir, asFiles), '"rewind to" holds the target\'s tree');
  // The other way: the folder and the link come back.
  const forth = await history.rewind(project, { sha: asFolders, tip: back.to });
  assert.equal(forth.ok, true, JSON.stringify(forth));
  assert.deepEqual(forth.skipped, []);
  assert.equal(read(dir, 'results/a.csv'), 'x,y\n');
  assert.ok(fs.lstatSync(path.join(dir, 'dir')).isSymbolicLink());
  assert.equal(fs.readlinkSync(path.join(dir, 'dir')), elsewhere);
  assert.equal(read(elsewhere, 'file.txt'), 'outside\n');
  assert.equal(treeName(dir, forth.to), treeName(dir, asFolders), '"rewind to" holds the target\'s tree');
});

test('a folder that still holds a file the record does not keep is left, and the file of that name is not written over it', async () => {
  const dir = folder('swap-kept');
  const project = await projectAt(dir);
  write(dir, '.gitignore', '*.log\n');
  write(dir, 'results', 'a file\n');
  const asFile = (await project.commit('session open')).hash;
  fs.rmSync(path.join(dir, 'results'));
  write(dir, 'results/a.csv', 'x,y\n');
  write(dir, 'results/cache.log', 'ignored\n');
  const asFolder = (await project.commit('timer')).hash;
  const result = await history.rewind(project, { sha: asFile, tip: asFolder });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.removed, ['results/a.csv']);
  assert.deepEqual(result.written, []);
  assert.deepEqual(result.skipped.map((entry) => entry.path), ['results']);
  assert.match(result.skipped[0].why, /a folder is there/);
  assert.equal(read(dir, 'results/cache.log'), 'ignored\n');
});

test('a failure in the write step after .gitignore is written never lets untracked/ into the record', async () => {
  const dir = folder('step-two');
  const project = await projectAt(dir);
  write(dir, '.gitignore', 'build/\n');
  write(dir, 'a.txt', 'a\n');
  write(dir, 'locked/b.txt', 'b\n');
  sh(dir, 'add', '.gitignore', 'a.txt', 'locked/b.txt');
  at(dir, now() - 100, 'commit', '-q', '-m', 'Before the record');
  const old = sh(dir, 'rev-parse', 'HEAD');
  write(dir, 'a.txt', 'a, later\n');
  write(dir, 'locked/b.txt', 'b, later\n');
  write(dir, 'untracked/huge.bin', 'huge\n');
  const tip = (await project.commit('session open')).hash;
  assert.match(read(dir, '.gitignore'), /^\/untracked\/$/m);
  // checkout-index writes .gitignore (the target's, without the line), then
  // cannot replace a file in a folder it may not write.
  fs.chmodSync(path.join(dir, 'locked'), 0o555);
  try {
    const result = await history.rewind(project, { sha: old, tip });
    assert.equal(result.refused, 'failed', JSON.stringify(result));
    assert.match(result.detail, /^write: /);
    assert.match(read(dir, '.gitignore'), /^build\/\n/, "the target's .gitignore was written");
    assert.match(read(dir, '.gitignore'), /^\/untracked\/$/m, 'and the record put its line back at once');
    const next = await project.commit('timer');
    assert.equal(next.committed, true, JSON.stringify(next));
    const kept = sh(dir, 'ls-tree', '-r', '--name-only', next.hash).split('\n');
    assert.ok(!kept.some((file) => file.startsWith('untracked/')), 'untracked/ stayed out of the record');
    assert.ok(kept.includes(MANIFEST), 'and its manifest pins it');
  } finally {
    fs.chmodSync(path.join(dir, 'locked'), 0o755);
  }
});

test('a .gitignore that is a symbolic link in the target is left alone, so untracked/ keeps its line', async () => {
  const dir = folder('linked-ignore');
  const project = await projectAt(dir);
  write(dir, 'a.txt', 'a\n');
  write(dir, 'untracked/data.csv', 'x,y\n');
  const tip = (await project.commit('session open')).hash;
  const gitignore = read(dir, '.gitignore');
  // A commit elsewhere whose .gitignore is a link (to a file outside, say).
  const tree = treeNamed(dir, [...topOf(dir, treeName(dir, tip)).filter(([, name]) => name !== '.gitignore'), ['120000', '.gitignore', blobNamed(dir, '/etc/hosts')]]);
  const side = at(dir, now(), 'commit-tree', tree, '-m', 'Elsewhere');
  write(dir, 'a.txt', 'a, later\n');
  const result = await history.rewind(project, { sha: side, tip: (await project.commit('timer')).hash });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.skipped.map((entry) => entry.path), ['.gitignore']);
  assert.equal(read(dir, '.gitignore'), gitignore);
  assert.ok(!fs.lstatSync(path.join(dir, '.gitignore')).isSymbolicLink());
  assert.ok(!sh(dir, 'ls-tree', '-r', '--name-only', result.to).split('\n').some((file) => file.startsWith('untracked/')));
});

test('a crafted commit is refused whole, before anything is recorded or removed, and the graph still draws it', async () => {
  const outside = folder('outside');
  write(outside, 'victim.txt', 'victim\n');
  const crafted = [
    ['a .. folder', (dir, evil) => [['40000', '..', treeNamed(dir, [['100644', 'victim.txt', evil]])]], '../victim.txt'],
    ['a name with slashes', (dir, evil) => [['100644', 'x/../../evil.txt', evil]], 'x/../../evil.txt'],
    ['.git/hooks', (dir, evil) => [['40000', '.git', treeNamed(dir, [['40000', 'hooks', treeNamed(dir, [['100755', 'post-commit', evil]])]])]], '.git/hooks/post-commit'],
    ['.GIT', (dir, evil) => [['100644', '.GIT', evil]], '.GIT'],
    ['an HFS+ spelling of .git', (dir, evil) => [['40000', '.g\u200cit', treeNamed(dir, [['100644', 'config', evil]])]], '.g\u200cit/config'],
    ['a path under a link of the same commit', (dir, evil) => [['120000', 'lnk', blobNamed(dir, outside)], ['40000', 'lnk', treeNamed(dir, [['100644', 'victim.txt', evil]])]], 'lnk/victim.txt'],
    ['a .gitmodules link, which git itself refuses', (dir) => [['120000', '.gitmodules', blobNamed(dir, outside)]], '.gitmodules'],
    // git names these as they are, a quote or a newline included.
    ["a .gitmodules link in a folder named it's", (dir) => [['40000', "it's", treeNamed(dir, [['120000', '.gitmodules', blobNamed(dir, outside)]])]], "it's/.gitmodules"],
    ['a .gitmodules link in a folder whose name holds a newline', (dir) => [['40000', 'x\ny', treeNamed(dir, [['120000', '.gitmodules', blobNamed(dir, outside)]])]], 'x\ny/.gitmodules'],
    // checkout-index finds these out only as it writes, after it has
    // removed what it replaces: checked first, with git's own objects.
    ['a tree where the commit says a file', (dir, evil) => [['100644', 'notafile.txt', treeNamed(dir, [['100644', 'x.txt', evil]])]], 'notafile.txt'],
    ['a file whose contents are not in the repository', () => [['100644', 'm.txt', 'b'.repeat(40)]], 'm.txt'],
    // git cannot list it at all.
    ['an empty name', (dir, evil) => [['100644', '', evil]], null],
  ];
  for (const [what, extra, bad] of crafted) {
    const { dir, project, second } = await recorded(`crafted-${counter}`);
    const hooks = listing(path.join(dir, '.git', 'hooks'));
    const evil = blobNamed(dir, 'evil\n');
    const tree = treeNamed(dir, [...topOf(dir, treeName(dir, second)), ...extra(dir, evil)]);
    // Someone moved the record onto it, and the record went on from there.
    const commit = sh(dir, 'commit-tree', tree, '-p', second, '-m', 'fixture: timer');
    sh(dir, 'update-ref', BRANCH, commit);
    write(dir, 'later.txt', 'later\n');
    const tip = (await project.commit('timer')).hash;
    assert.ok(tip, what);
    const gitignore = read(dir, '.gitignore');
    const before = subjects(dir).length;
    const preview = await history.compare(project, commit);
    assert.ok(preview.invalid, `${what}: the card says so: ${JSON.stringify(preview)}`);
    assert.deepEqual([preview.invalid.path, preview.write, preview.remove], [bad, [], []], `${what}: the card says so`);
    assert.equal(preview.invalid.partial, undefined, `${what}: no partial clone here`);
    // The page loads all the same: the graph draws the commit, whose card says why.
    const drawn = await history.graph(project);
    assert.ok(drawn.commits.some((entry) => entry.sha === commit), `${what}: the graph draws it`);
    let saved = false;
    const result = await history.rewind(project, { sha: commit, tip }, { save: async () => ((saved = true), null) });
    assert.equal(result.refused, 'invalid', `${what}: ${JSON.stringify(result)}`);
    assert.equal(result.path, bad, what);
    assert.equal(saved, false, `${what}: refused before the save step`);
    assert.equal(subjects(dir).length, before, `${what}: nothing recorded`);
    assert.equal(read(dir, 'later.txt'), 'later\n', `${what}: nothing removed`);
    assert.equal(read(dir, 'c.txt'), 'c\n', `${what}: nothing removed`);
    assert.equal(read(dir, '.gitignore'), gitignore, `${what}: nothing written`);
    assert.deepEqual(listing(path.join(dir, '.git', 'hooks')), hooks, `${what}: .git/hooks untouched`);
    assert.deepEqual(listing(outside), ['victim.txt'], `${what}: nothing outside`);
    assert.ok(!fs.readdirSync(project.stateDir).some((name) => name.startsWith('rewind-')), `${what}: no throwaway index left`);
  }
  assert.equal(read(outside, 'victim.txt'), 'victim\n');
});

test("a commit whose files a partial clone never fetched is refused whole, and nothing is fetched", async () => {
  const origin = folder('origin');
  sh(origin, 'init', '-q', '--initial-branch=main', '.');
  for (const name of ['a', 'b', 'z']) write(origin, `${name}.txt`, `${name} v1\n`);
  sh(origin, 'add', '.');
  at(origin, now() - 1000, 'commit', '-q', '-m', 'v1');
  const v1 = sh(origin, 'rev-parse', 'HEAD');
  for (const name of ['a', 'b', 'z']) write(origin, `${name}.txt`, `${name} v2\n`);
  sh(origin, 'add', '.');
  at(origin, now() - 900, 'commit', '-q', '-m', 'v2');
  sh(origin, 'config', 'uploadpack.allowFilter', 'true');
  const parent = folder('blobless');
  sh(parent, 'clone', '-q', '--filter=blob:none', `file://${origin}`, 'clone');
  const dir = path.join(parent, 'clone');
  const missing = () => sh(dir, 'rev-list', '--objects', '--missing=print', '--all').split('\n').filter((line) => line.startsWith('?')).length;
  const unfetched = missing();
  assert.equal(unfetched, 3, "v1's three files were never fetched");
  const project = await projectAt(dir);
  write(dir, 'a.txt', 'a, mine\n');
  const tip = (await project.commit('session open')).hash;
  const before = userSide(dir);
  const preview = await history.compare(project, v1);
  assert.equal(preview.invalid?.absent, true, JSON.stringify(preview));
  assert.equal(preview.invalid.partial, true, 'and the card can say why: a partial clone');
  assert.deepEqual([preview.write, preview.remove], [[], []]);
  // The page loads all the same: the graph names v1's files (counting them
  // would read their blobs), and its detail lists them, uncounted.
  const drawn = await history.graph(project);
  assert.deepEqual(drawn.commits.find((entry) => entry.sha === v1)?.changed.sort(), ['a.txt', 'b.txt', 'z.txt']);
  assert.ok(drawn.commits.some((entry) => entry.line === 'record'), 'beside the record');
  const detail = await history.commitDetail(project, v1);
  assert.deepEqual(detail.files.map((file) => [file.path, file.plus, file.patch]), ['a.txt', 'b.txt', 'z.txt'].map((name) => [name, 0, undefined]));
  let saved = false;
  const result = await history.rewind(project, { sha: v1, tip }, { save: async () => ((saved = true), null) });
  assert.equal(result.refused, 'invalid', JSON.stringify(result));
  assert.equal(result.absent, true);
  assert.equal(saved, false, 'refused before the save step');
  assert.deepEqual(subjects(dir), ['fixture: session open'], 'nothing recorded');
  assert.deepEqual(['a', 'b', 'z'].map((name) => read(dir, `${name}.txt`)), ['a, mine\n', 'b v2\n', 'z v2\n'], 'nothing removed or written');
  assert.deepEqual(userSide(dir), before);
  assert.equal(missing(), unfetched, 'nothing fetched');
  assert.ok(!fs.readdirSync(project.stateDir).some((name) => name.startsWith('rewind-')), 'no throwaway index left');
});

test('the working tree never holds a .gitignore without /untracked/ during a rewind, so another app\'s commit then never takes untracked/ in', async () => {
  const dir = folder('window');
  const knuth = await projectAt(dir, 'knuth');
  const found = await repositoryOf(binary, dir);
  const plass = new Project({ binary, root: found.root, gitDir: found.gitDir, commonDir: found.commonDir, appName: 'plass', stateDir: folder('state'), log });
  write(dir, '.gitignore', 'build/\n');
  write(dir, 'a.txt', 'a, old\n');
  // A large file, which checkout-index writes after .gitignore: the gap an
  // earlier build left open lasted as long as it took to write.
  fs.writeFileSync(path.join(dir, 'model.bin'), randomBytes(32 * 1024 * 1024));
  sh(dir, 'add', '.');
  at(dir, now() - 100, 'commit', '-q', '-m', 'Before the record');
  const old = sh(dir, 'rev-parse', 'HEAD');
  write(dir, 'untracked/huge.bin', 'pretend this is 40 GB\n');
  write(dir, 'a.txt', 'a, new\n');
  fs.writeFileSync(path.join(dir, 'model.bin'), 'small now\n');
  await knuth.commit('session open');
  await plass.commit('session open');
  // Plass's timer commits the moment .gitignore lacks the line.
  const without = [];
  const plassCommits = [];
  const watch = setInterval(() => {
    let text = '';
    try {
      text = read(dir, '.gitignore');
    } catch {
      // None at all: no line either.
    }
    if (/^\/untracked\/$/m.test(text)) return;
    without.push(text);
    if (plassCommits.length === 0) {
      write(dir, 'b.txt', 'plass wrote this\n');
      plassCommits.push(plass.run(() => plass.commit('timer')));
    }
  }, 1);
  try {
    // A commit from before the record: its .gitignore lacks the line.
    const toOld = await history.rewind(knuth, { sha: old, tip: await knuth.tip() });
    assert.equal(toOld.ok, true, JSON.stringify(toOld));
    assert.ok(toOld.written.includes('.gitignore') && toOld.written.includes('model.bin'));
    assert.equal(read(dir, '.gitignore'), `build/\n${IGNORE_LINES}`, "the target's .gitignore, with the record's line");
    // A record commit without .gitignore (crafted: the record keeps one
    // always): the file becomes the record's line alone, never goes.
    const tip = await knuth.tip();
    const bare = sh(dir, 'commit-tree', treeNamed(dir, topOf(dir, treeName(dir, tip)).filter(([, name]) => name !== '.gitignore')), '-p', tip, '-m', 'knuth: timer');
    sh(dir, 'update-ref', BRANCH, bare);
    write(dir, 'a.txt', 'a, later\n');
    const later = (await knuth.commit('timer')).hash;
    const toBare = await history.rewind(knuth, { sha: bare, tip: later });
    assert.equal(toBare.ok, true, JSON.stringify(toBare));
    assert.ok(toBare.removed.includes('.gitignore'));
    assert.equal(read(dir, '.gitignore'), IGNORE_LINES);
  } finally {
    clearInterval(watch);
  }
  assert.deepEqual(without, [], 'the working tree never held a .gitignore without the line');
  await Promise.all(plassCommits);
  for (const sha of sh(dir, 'rev-list', BRANCH).split('\n')) {
    const files = sh(dir, 'ls-tree', '-r', '--name-only', sha).split('\n');
    assert.ok(!files.some((file) => file.startsWith('untracked/')), `${sh(dir, 'log', '-1', '--format=%s', sha)}: untracked/ stayed out`);
  }
});

test('on a volume that ignores case, Untracked/ is untracked/ and the manifest in any case is the manifest', async (t) => {
  const dir = folder('caseless');
  const project = await projectAt(dir);
  if (!fs.existsSync(path.join(dir, '.GIT'))) {
    t.skip('this volume keeps case apart');
    return;
  }
  write(dir, 'a.txt', 'a\n');
  sh(dir, 'add', 'a.txt');
  at(dir, now() - 100, 'commit', '-q', '-m', 'start');
  write(dir, 'untracked/data.csv', 'x,y\n');
  write(dir, 'a.txt', 'a, later\n');
  const tip = (await project.commit('session open')).hash;
  // A commit on a user branch (made elsewhere, say) that names untracked/
  // and the manifest in other cases.
  const index = path.join(work, `case-index-${counter++}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync(binary, ['read-tree', 'HEAD'], { cwd: dir, env });
  for (const [name, text] of [['Untracked/new.csv', 'new\n'], ['.Claerbout/Untracked.json', '{}\n']]) {
    execFileSync(binary, ['update-index', '--add', '--cacheinfo', `100644,${blobNamed(dir, text)},${name}`], { cwd: dir, env });
  }
  const tree = execFileSync(binary, ['write-tree'], { cwd: dir, env, encoding: 'utf8' }).trim();
  const side = at(dir, now(), 'commit-tree', tree, '-p', 'HEAD', '-m', 'Elsewhere');
  const manifest = read(dir, MANIFEST);
  const preview = await history.compare(project, side);
  assert.deepEqual(preview.write.map((entry) => entry.path), ['a.txt']);
  const result = await history.rewind(project, { sha: side, tip });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.written, ['a.txt']);
  assert.deepEqual(listing(path.join(dir, 'untracked')), ['data.csv'], 'nothing was written into untracked/');
  assert.equal(read(dir, MANIFEST), manifest, 'the manifest was not written');
});

test('nothing is removed or written through a link that takes a folder\'s place during the rewind', async () => {
  const dir = folder('links');
  const project = await projectAt(dir);
  const outside = folder('outside');
  write(outside, 'y.txt', 'outside y\n');
  write(dir, 'keep.txt', 'keep\n');
  write(dir, 'notes/x.txt', 'x\n');
  const first = (await project.commit('session open')).hash;
  fs.rmSync(path.join(dir, 'notes'), { recursive: true });
  write(dir, 'out/y.txt', 'y\n');
  const second = (await project.commit('timer')).hash;
  // Between the "rewind from" commit and the write, both folders become
  // links to a folder outside the project.
  const swap = (step, state) => {
    if (step !== 'write' || state !== 'doing') return;
    fs.rmSync(path.join(dir, 'out'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'out'));
    fs.symlinkSync(outside, path.join(dir, 'notes'));
  };
  const result = await history.rewind(project, { sha: first, tip: second }, { onStep: swap });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.written, []);
  assert.deepEqual(result.skipped.map((entry) => entry.path).sort(), ['notes/x.txt', 'out/y.txt']);
  assert.ok(result.skipped.every((entry) => /symbolic link/.test(entry.why)));
  assert.deepEqual(listing(outside), ['y.txt']);
  assert.equal(read(outside, 'y.txt'), 'outside y\n');
  // removePath on its own: a link along the way is never gone through, and
  // folders left empty go, never past the root.
  const root = folder('remove');
  fs.symlinkSync(outside, path.join(root, 'a'));
  assert.match(await history.removePath(root, 'a/y.txt'), /a is a symbolic link here/);
  assert.equal(read(outside, 'y.txt'), 'outside y\n');
  write(root, 'b/c/file.txt', 'f\n');
  assert.equal(await history.removePath(root, 'b/c/file.txt'), true);
  assert.deepEqual(listing(root), ['a']);
  assert.equal(await history.removePath(root, 'gone.txt'), false);
});

test('a file past 1 MB is not read, and one huge file costs only itself its patch', async () => {
  const dir = folder('large');
  const project = await projectAt(dir);
  write(dir, 'a.txt', 'one\n');
  write(dir, 'big.txt', 'small at first\n');
  await project.commit('session open');
  write(dir, 'a.txt', 'two\n');
  write(dir, 'big.txt', `${'x'.repeat(2 * 1024 * 1024)}\n`);
  const run = (await project.commit('cell run [1]')).hash;
  assert.deepEqual(await history.blob(project, run, 'big.txt'), { large: true, size: 2 * 1024 * 1024 + 1 });
  const detail = await history.commitDetail(project, run);
  const files = new Map(detail.files.map((file) => [file.path, file]));
  assert.match(files.get('a.txt').patch, /-one\n\+two$/);
  assert.equal(files.get('big.txt').large, true);
  assert.equal(files.get('big.txt').patch, undefined);
});

test('a window that does not answer save is named, and the rewind goes on and says which', async () => {
  const { dir, project, first, second } = await recorded('silent');
  const steps = [];
  const silent = [path.join(dir, 'a.txt')];
  const result = await history.rewind(project, { sha: first, tip: second }, { save: async () => ({ silent }), onStep: (step, state, detail) => steps.push([step, state, detail]) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.silent, silent);
  assert.deepEqual(steps[1], ['save', 'done', { silent }]);
  const again = await history.rewind(project, { sha: result.from ?? second, tip: result.to });
  assert.deepEqual(again.silent, [], 'every window answered');
});

// From the third pass's review.

test('one rewind at a time on a working tree: another shell\'s rewind and commits wait while it writes, and a lock its holder left is taken over', async () => {
  const { dir, project: knuth, first, second } = await recorded('lock');
  const found = await repositoryOf(binary, dir);
  const plass = new Project({ binary, root: found.root, gitDir: found.gitDir, commonDir: found.commonDir, appName: 'plass', stateDir: folder('state'), log });
  const holding = 'Fixture is rewinding this project';
  let during = null;
  const result = await history.rewind(knuth, { sha: first, tip: second }, {
    save: async () => {
      // Plass's timer, its rewind and its card, while this one holds the lock.
      write(dir, 'b.txt', 'plass wrote this\n');
      during = {
        commit: await plass.commit('timer'),
        rewind: await history.rewind(plass, { sha: second, tip: second }),
        compare: (await history.compare(plass, second)).blocked,
        lock: await plass.lockRewind(),
      };
      return null;
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(during, {
    commit: { skipped: holding, message: 'plass: timer' },
    rewind: { refused: 'paused', reason: holding },
    compare: holding,
    lock: holding,
  });
  assert.ok(!fs.existsSync(knuth.rewindLock), 'the lock goes with the rewind');
  assert.equal(subjects(dir).filter((subject) => subject.startsWith('plass:')).length, 0, 'plass recorded nothing meanwhile');
  write(dir, 'b.txt', 'plass again\n');
  assert.equal((await plass.commit('timer')).committed, true, 'and records again after it');

  const lock = (pid, app) => fs.writeFileSync(knuth.rewindLock, JSON.stringify({ pid, app }));
  // Another shell, running, holds it: refused before anything is saved or recorded.
  lock(process.ppid, 'plass');
  let saved = false;
  const before = subjects(dir).length;
  const refused = await history.rewind(knuth, { sha: second, tip: await knuth.tip() }, { save: async () => ((saved = true), null) });
  assert.deepEqual(refused, { refused: 'paused', reason: 'Plass is rewinding this project' });
  assert.deepEqual([saved, subjects(dir).length], [false, before]);
  assert.ok(fs.existsSync(knuth.rewindLock), "and the other shell's lock is left as it is");
  // Older than any rewind, its pid is no witness (the system may have given
  // it to another process).
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(knuth.rewindLock, old, old);
  assert.equal(await knuth.blocked(), null);
  // Left by a shell that died: taken over.
  lock(spawnSync(process.execPath, ['-e', '']).pid, 'plass');
  assert.equal(await knuth.blocked(), null);
  const over = await history.rewind(knuth, { sha: second, tip: await knuth.tip() });
  assert.equal(over.ok, true, JSON.stringify(over));
  assert.ok(!fs.existsSync(knuth.rewindLock));
});

test('the new .gitignore is made in the state folder, never in the working tree, so no fill or git status sees it', async () => {
  const dir = folder('staged-ignore');
  const project = await projectAt(dir);
  write(dir, '.gitignore', 'build/\n');
  write(dir, 'a.txt', 'a\n');
  sh(dir, 'add', '.');
  at(dir, now() - 100, 'commit', '-q', '-m', 'Before the record');
  const old = sh(dir, 'rev-parse', 'HEAD');
  write(dir, 'a.txt', 'a, later\n');
  const tip = (await project.commit('session open')).hash;
  const top = listing(dir);
  const renames = [];
  const rename = fsp.rename;
  fsp.rename = async (from, to) => {
    renames.push({ from, to, top: listing(dir), status: sh(dir, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=all') });
    return rename(from, to);
  };
  let result;
  try {
    result = await history.rewind(project, { sha: old, tip });
  } finally {
    fsp.rename = rename;
  }
  assert.equal(result.ok, true, JSON.stringify(result));
  const ignore = renames.find((entry) => entry.to === path.join(project.root, '.gitignore'));
  assert.ok(ignore, 'the rewind wrote .gitignore itself');
  assert.equal(path.dirname(ignore.from), project.stateDir, 'made in the state folder');
  assert.deepEqual(ignore.top, top, 'nothing new in the working tree as it lands');
  assert.ok(!/claerbout-/.test(ignore.status), `nor in git status (${ignore.status})`);
  assert.equal(read(dir, '.gitignore'), `build/\n${IGNORE_LINES}`);
  assert.deepEqual(listing(dir), top);
});

test('a file named untracked in a commit, where the record keeps its folder, is left alone and named', async () => {
  const dir = folder('named-untracked');
  const project = await projectAt(dir);
  write(dir, 'a.txt', 'a\n');
  write(dir, 'untracked', 'a file of that name\n');
  sh(dir, 'add', '.');
  at(dir, now() - 100, 'commit', '-q', '-m', 'Before the record');
  const old = sh(dir, 'rev-parse', 'HEAD');
  fs.rmSync(path.join(dir, 'untracked'));
  write(dir, 'untracked/data.csv', 'x,y\n');
  write(dir, 'a.txt', 'a, later\n');
  const tip = (await project.commit('session open')).hash;
  const preview = await history.compare(project, old);
  assert.deepEqual([preview.write.map((entry) => entry.path), preview.skipped.map((entry) => entry.path)], [['a.txt'], ['untracked']]);
  assert.match(preview.skipped[0].why, /the record keeps the name untracked for its own folder/);
  const result = await history.rewind(project, { sha: old, tip });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.written, result.skipped.map((entry) => entry.path)], [['a.txt'], ['untracked']]);
  assert.equal(read(dir, 'untracked/data.csv'), 'x,y\n', 'the folder is as it was');
});

test('what a commit holds in a folder named .gitignore is left alone and named, the card and the rewind agreeing', async () => {
  const dir = folder('ignore-folder');
  const project = await projectAt(dir);
  write(dir, 'a.txt', 'a\n');
  write(dir, 'untracked/data.csv', 'x,y\n');
  const start = (await project.commit('session open')).hash;
  // A record commit whose .gitignore is a folder (crafted: the record keeps a file there).
  const tree = treeNamed(dir, [
    ...topOf(dir, treeName(dir, start)).filter(([, name]) => name !== '.gitignore'),
    ['40000', '.gitignore', treeNamed(dir, [['100644', 'x', blobNamed(dir, 'x\n')]])],
  ]);
  const crafted = sh(dir, 'commit-tree', tree, '-p', start, '-m', 'fixture: timer');
  sh(dir, 'update-ref', BRANCH, crafted);
  write(dir, 'a.txt', 'a, later\n');
  const tip = (await project.commit('timer')).hash;
  const preview = await history.compare(project, crafted);
  assert.deepEqual([preview.write.map((entry) => entry.path), preview.remove, preview.skipped.map((entry) => entry.path)], [['a.txt'], ['.gitignore'], ['.gitignore/x']]);
  const result = await history.rewind(project, { sha: crafted, tip });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.written, result.removed, result.skipped.map((entry) => entry.path)], [['a.txt'], ['.gitignore'], ['.gitignore/x']]);
  assert.equal(read(dir, '.gitignore'), IGNORE_LINES, "a .gitignore the target lacks is the record's line alone");
  assert.ok(!sh(dir, 'ls-tree', '-r', '--name-only', result.to).split('\n').some((file) => file.startsWith('untracked/')));
});

test('a file .claerbout/ignore keeps out of the record is left alone by a rewind and named, and so are the rules themselves', async () => {
  const dir = folder('record-ignore');
  const project = await projectAt(dir);
  write(dir, 'notes.md', 'week 1\n');
  write(dir, 'video.mp4', 'render 1');
  sh(dir, 'add', 'notes.md', 'video.mp4');
  at(dir, now() - 100, 'commit', '-q', '-m', 'Week 1, posted');
  const posted = sh(dir, 'rev-parse', 'HEAD');
  // Recorded before the rules: the record holds render 1.
  const early = (await project.commit('session open')).hash;
  write(dir, '.claerbout/ignore', '*.mp4\n');
  write(dir, 'video.mp4', 'render 2');
  write(dir, 'notes.md', 'week 1, later\n');
  const tip = (await project.commit('timer')).hash;
  assert.ok(!sh(dir, 'ls-tree', '-r', '--name-only', tip).split('\n').includes('video.mp4'));
  // A user commit and an earlier record commit both hold render 1.
  for (const target of [posted, early]) {
    const preview = await history.compare(project, target);
    assert.deepEqual(preview.write.map((entry) => entry.path), ['notes.md'], JSON.stringify(preview));
    assert.deepEqual(preview.remove, []);
    const named = Object.fromEntries(preview.skipped.map((entry) => [entry.path, entry.why]));
    assert.equal(named['video.mp4'], 'kept out by .claerbout/ignore');
    if (target === early) assert.equal(named['.claerbout/ignore'], "the record's own rules, left as they are");
  }
  const result = await history.rewind(project, { sha: early, tip });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.written, result.removed], [['notes.md'], []]);
  assert.ok(result.skipped.some((entry) => entry.path === 'video.mp4' && entry.why === 'kept out by .claerbout/ignore'));
  assert.equal(read(dir, 'video.mp4'), 'render 2', 'never written');
  assert.equal(read(dir, '.claerbout/ignore'), '*.mp4\n', 'the rules stay');
  assert.equal(read(dir, 'notes.md'), 'week 1\n');
  // Gone from the disk, the render is still not written back.
  fs.rmSync(path.join(dir, 'video.mp4'));
  const later = (await project.commit('timer')).hash ?? (await project.tip());
  const again = await history.rewind(project, { sha: posted, tip: later });
  assert.ok(again.ok || again.same, JSON.stringify(again));
  assert.ok(!exists(dir, 'video.mp4'), 'a rewind never writes it');
});
