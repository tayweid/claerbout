// The history view's git (Knuth's docs/mockups/history.md): the autosave
// record (autosave.js) and the user's own branches as one graph, what one
// commit changed, a file at a commit, what a rewind to a commit would do
// now, and the rewind itself. The window is the shell's own page
// (history/history.html); main.js answers its requests from here, always
// for that window's project, so the page never names a folder.
//
// Reading is plumbing only (log, diff-tree, cat-file, ls-tree). A rewind
// is a step forward that reproduces an older state, never a reset: the
// record commits now ("<app>: rewind from <tip>"), the target commit's
// files are written into the working tree through a throwaway index
// (read-tree, then checkout-index on the paths that differ, never -a, so
// files that did not change keep their mtimes), and the record commits
// again ("<app>: rewind to <target>"), always, even when its tree equals
// the tip's. The user's HEAD, branch and index are never touched: the
// throwaway index is the only index, and the record's branch the only
// ref. untracked/ and the record's manifest are never written or removed,
// nor are .claerbout/ignore and a file it keeps out of the record (named).
// A file that exists now but not in the target is removed only when the
// target is on the record and the record's tip (the one the page drew)
// holds it: nothing the record never held is removed, and a commit on a
// user branch writes only the files it holds.
//
// Before anything is recorded or touched, the target is checked twice:
// here (git can list its tree; no empty, '.' or '..' name, not absolute,
// no .git in any case or HFS+ spelling, nothing under another of its
// entries that is a link or a nested repository; and every file and link
// it holds is in the repository as a blob, which a tree object under a
// file's mode or a partial clone's unfetched blob is not) and by git itself
// (`read-tree` into the throwaway index the write then uses). A target
// that fails either is refused whole, and the card says so before the
// click (compare makes both checks too). On the disk, every removal and
// every write walks from the project's root with lstat and never goes
// through a link; and paths are compared as the volume compares them
// (Unicode form always, case on a volume that ignores it, as macOS's
// does), so Untracked/ is untracked/. The top .gitignore is written by the
// rewind itself, with the record's /untracked/ line in it, made in the
// shell's state folder and renamed into place, so another app's fill never
// finds one without the line, nor the new file before it is in place. One
// rewind at a time writes a working tree, whichever shell runs it: each
// holds a lock in the git dir (autosave.js), and every other shell's
// commits wait on it too, so none records a rewind half written.
//
// Every function takes the autosave Project for the window's project and
// runs git through it (its environment, its guards, its job queue), so
// all of this runs under node:test without Electron.
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { BRANCH_NAME, MANIFEST_PATH, RECORD_IGNORE_PATH, UNTRACKED, IGNORE_LINES, errorLine, replaceFile, alive } = require('./autosave.js');

const LIMIT = 2000;
const MOST = 5000;
/** How many changed paths a graph commit names. */
const CHANGED_KEPT = 20;
/** How many paths beside its document a commit names (scoped). */
const BESIDE_KEPT = 200;
/** Record commits a tie looks through for a user commit. */
const TIE_CANDIDATES = 200;
/** A patch's lines per file, and its bytes in all. */
const PATCH_LINES = 400;
const PATCH_BYTES = 1024 * 1024;
/** A commit with more files than this has no patches (its first, say). */
const PATCH_FILES = 400;
/** A file past this, on either side, is too large to read: no blob text,
 *  no patch. */
const BLOB_BYTES = 1024 * 1024;
/** The bytes of blobs one commit's patches may read in all, so git's
 *  output always fits its buffer. */
const PATCH_READ = 16 * 1024 * 1024;
const MANIFEST_BYTES = 8 * 1024 * 1024;
const SHA = /^[0-9a-f]{4,64}$/;
/** The log's fields: record separator, then unit separators. */
const FORMAT = '%x1e%H%x1f%P%x1f%T%x1f%S%x1f%aI%x1f%at%x1f%an%x1f%s';

// MARK: - Messages

/**
 * What a record commit's message says, so the page never parses commit
 * text: "<app>: <trigger>" → {app, trigger}, with `trigger` one of 'run'
 * (with `cells`, and `error` when the run raised), 'timer', 'open',
 * 'close', 'rewind-from' (with `from`), 'rewind-to' (with `target`, and
 * for a partial rewind `partial`, the number of files, and `paths` when
 * the message names them), or 'notice' for anything else.
 */
function parseSubject(subject) {
  const match = String(subject ?? '').match(/^([a-z0-9][a-z0-9._-]*): (.*)$/);
  if (!match) return { app: null, trigger: 'notice' };
  const [, app, rest] = match;
  if (rest === 'timer') return { app, trigger: 'timer' };
  if (rest === 'session open') return { app, trigger: 'open' };
  if (rest === 'session close') return { app, trigger: 'close' };
  let found = rest.match(/^cell run \[([0-9, ]*)\]( \(error\))?$/);
  if (found) {
    const cells = found[1]
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((cell) => Number.isInteger(cell) && cell > 0);
    return { app, trigger: 'run', cells, ...(found[2] ? { error: true } : {}) };
  }
  found = rest.match(/^rewind from ([0-9a-f]{7,64})$/);
  if (found) return { app, trigger: 'rewind-from', from: found[1] };
  found = rest.match(/^rewind to ([0-9a-f]{7,64})(?: \((.+)\))?$/);
  if (found) {
    const parsed = { app, trigger: 'rewind-to', target: found[1] };
    if (found[2] !== undefined) {
      const counted = found[2].match(/^(\d+) files?$/);
      if (counted) parsed.partial = Number(counted[1]);
      else {
        parsed.paths = found[2].split(', ');
        parsed.partial = parsed.paths.length;
      }
    }
    return parsed;
  }
  return { app, trigger: 'notice' };
}

/** "rewind to <target>", and for a partial rewind its paths in brackets,
 *  or "(3 files)" past two or past what the record's 120 characters keep. */
function rewindToTrigger(target, partial) {
  const base = `rewind to ${target}`;
  if (!partial) return base;
  const named = `${base} (${partial.join(', ')})`;
  if (partial.length <= 2 && named.length <= 120 && !partial.some((file) => /[(),\u0000-\u001f]/.test(file))) return named;
  return `${base} (${partial.length} ${partial.length === 1 ? 'file' : 'files'})`;
}

// MARK: - Small helpers

/** A sha the page sent: hex only, so it can never be read as an option. */
function checkedSha(value, what = 'sha') {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error(`${what} must be a commit's hex name`);
  return value;
}

/** git's stdout, or an error with git's own line. */
function ok(result, what) {
  if (result.status !== 0) throw new Error(`git ${what}: ${errorLine(result.stderr) || result.status}`);
  return result.stdout;
}

const nul = (text) => text.split('\0').filter(Boolean);

// MARK: - Paths as the volume compares them

const caseless = new Map();
/** Whether the volume a working tree is on ignores case (macOS's default
 *  APFS does): .git and .GIT are one file. Asked of the disk, once per
 *  root, rather than of core.ignorecase, which a copied repository can
 *  carry from another volume. */
function ignoresCase(root) {
  if (!caseless.has(root)) {
    let found = false;
    try {
      const one = fs.lstatSync(path.join(root, '.git'));
      const two = fs.lstatSync(path.join(root, '.GIT'));
      found = one.dev === two.dev && one.ino === two.ino;
    } catch {
      // No .GIT: the volume keeps case apart.
    }
    caseless.set(root, found);
  }
  return caseless.get(root);
}

/**
 * A working tree's way of comparing paths: each path's form as the volume
 * compares names, the same rule autosave.js judges a folder by (the name
 * as the disk keeps it). Unicode NFC always (APFS and HFS+ ignore the
 * form), and lower case where the volume ignores case, so Untracked/x is
 * untracked/x and Paper.typ is paper.typ.
 */
function foldFor(root) {
  const lower = ignoresCase(root);
  return (file) => {
    const form = String(file).normalize('NFC');
    return lower ? form.toLowerCase() : form;
  };
}

/** A path the rewind leaves alone: the record's manifest and untracked/,
 *  in whatever case the volume takes for them. */
function recordOwn(file, fold = (name) => name) {
  const folded = fold(file);
  const untracked = fold(UNTRACKED);
  return folded === fold(MANIFEST_PATH) || folded === untracked || folded.startsWith(`${untracked}/`);
}

/** Code points HFS+ ignores in a name (git's is_hfs_dotgit list): on such
 *  a volume '.g\u200cit' opens .git. */
const IGNORED = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/** Why a path from a tree is no path a rewind writes or removes, or null:
 *  an empty, '.' or '..' name, an absolute path, or a .git name in any
 *  case or HFS+ spelling, anywhere along it. */
function badPath(file) {
  if (typeof file !== 'string' || file === '') return 'an empty name';
  if (file.startsWith('/')) return 'an absolute path';
  if (file.includes('\0')) return 'a NUL in its name';
  for (const part of file.split('/')) {
    if (part === '') return 'an empty name along it';
    if (part === '..') return 'it climbs out of the project (..)';
    if (part === '.') return "a '.' along it";
    if (part.replace(IGNORED, '').toLowerCase() === '.git') return 'a .git along it';
  }
  return null;
}

/** The full name of a commit the page named; an error when it is none. */
async function resolveCommit(project, sha) {
  checkedSha(sha);
  const result = await project.git(['rev-parse', '--verify', '-q', `${sha}^{commit}`]);
  if (result.status !== 0) throw new Error(`no commit ${sha}`);
  return result.stdout.trim();
}

async function treeOf(project, sha) {
  return ok(await project.git(['rev-parse', '--verify', '-q', `${sha}^{tree}`]), 'rev-parse').trim();
}

/** The empty tree's name in this repository (sha1 or sha256). */
const emptyTrees = new Map();
async function emptyTree(project) {
  if (!emptyTrees.has(project.root)) {
    emptyTrees.set(project.root, ok(await project.git(['hash-object', '-t', 'tree', '--stdin']), 'hash-object').trim());
  }
  return emptyTrees.get(project.root);
}

/** Every path a tree holds, files and links and gitlinks. */
async function pathsIn(project, tree) {
  if (!tree) return new Set();
  return new Set(nul(ok(await project.git(['ls-tree', '-r', '-z', '--name-only', tree]), 'ls-tree')));
}

/** `git diff-tree --raw` between two trees (null: the empty tree), as
 *  [{status, from, to, a, b, path}], `from` and `to` the two modes, `a`
 *  and `b` the two blobs (zeros for none). */
async function rawDiff(project, a, b) {
  const left = a ?? (await emptyTree(project));
  const fields = nul(ok(await project.git(['diff-tree', '-r', '--no-renames', '--raw', '-z', left, b]), 'diff-tree'));
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [from, to, before, after, status] = fields[i].replace(/^:/, '').split(' ');
    entries.push({ status: status[0], from, to, a: before, b: after, path: fields[i + 1] });
  }
  return entries;
}

/** Every entry a tree holds, files, links and gitlinks: [{mode, object,
 *  path}]. */
async function entriesIn(project, tree) {
  return nul(ok(await project.git(['ls-tree', '-r', '-z', '--full-tree', tree]), 'ls-tree')).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, , object] = line.slice(0, tab).split(' ');
    return { mode, object, path: line.slice(tab + 1) };
  });
}

/** What git keeps under each name: name → 'blob', 'tree', 'commit',
 *  'tag' or 'missing'; one `cat-file --batch-check`. git never fetches a
 *  partial clone's missing object here (GIT_NO_LAZY_FETCH, autosave.js),
 *  so one that was never fetched is 'missing'. */
async function objectTypes(project, names) {
  const unique = [...new Set(names)];
  const types = new Map();
  if (unique.length === 0) return types;
  const text = ok(await project.git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${unique.join('\n')}\n` }), 'cat-file --batch-check');
  for (const line of text.split('\n')) {
    const [name, type] = line.split(' ');
    if (name && type) types.set(name, type);
  }
  return types;
}

/** {path: null, why} for a tree git cannot read, from git's own line. */
const unreadable = (error) => ({ path: null, why: `git cannot read this commit's tree (${error.message.replace(/^git [a-z-]+: /, '')})` });

/**
 * Why a tree is no tree a rewind writes, or null: git must be able to list
 * it; every path it holds must pass badPath, and none may lie under
 * another of its entries that is a symbolic link or a nested repository
 * (compared as the volume compares names, so `Sub`, a link, and `sub/x`
 * collide on a volume that ignores case); and every file and link it holds
 * (but the record's own, which no rewind writes) must be in the repository
 * as a blob. checkout-index finds out only as it writes, after it has
 * removed the file it replaces, so a tree object under a file's mode, or a
 * blob a partial clone never fetched (`absent`), would leave the folder
 * half rewound. git's own check comes after (read-tree). {path, why,
 * absent?, partial?} for the first that fails (`partial` when the
 * repository is a partial clone): the whole rewind is refused.
 */
async function checkTree(project, tree, fold) {
  let entries;
  try {
    entries = await entriesIn(project, tree);
  } catch (error) {
    return unreadable(error);
  }
  const leaves = new Set(entries.filter((entry) => entry.mode === '120000' || entry.mode === GITLINK).map((entry) => fold(entry.path)));
  for (const entry of entries) {
    const why = badPath(entry.path);
    if (why) return { path: entry.path, why };
    const parts = fold(entry.path).split('/');
    for (let i = 1; i < parts.length; i++) {
      const lead = parts.slice(0, i).join('/');
      if (leaves.has(lead)) return { path: entry.path, why: `it lies under ${entry.path.split('/').slice(0, i).join('/')}, a symbolic link or a nested repository in that commit` };
    }
  }
  const files = entries.filter((entry) => entry.mode !== GITLINK && !recordOwn(entry.path, fold));
  const types = await objectTypes(project, files.map((entry) => entry.object));
  for (const entry of files) {
    const type = types.get(entry.object) ?? 'missing';
    if (type === 'blob') continue;
    if (type === 'missing') {
      const partial = await partialClone(project);
      return { path: entry.path, why: 'its contents are not in this repository', absent: true, ...(partial ? { partial } : {}) };
    }
    return { path: entry.path, why: `it is a ${type} in that commit, not a file` };
  }
  return null;
}

const GITLINK = '160000';

/** Whether the repository is a partial clone, whose missing objects a
 *  remote promises: there an absent blob was never fetched, and anywhere
 *  else it was lost. */
async function partialClone(project) {
  const listed = await project.git(['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$']);
  return listed.status === 0 && listed.stdout.split('\n').some((line) => /^extensions\.partialclone \S/i.test(line) || /\.promisor (true|yes|on|1)$/i.test(line));
}

// MARK: - The graph

/** Commits from one `git log` with the graph's format and numstat, newest
 *  first, shaped as the graph's commits (without ties), each with `paths`,
 *  every path it changed, which scoped() reads and takes off. */
async function logCommits(project, revisions, { limit, until } = {}) {
  const args = (shape) => [
    'log',
    '--date-order',
    '--parents',
    '--source',
    ...(shape ? [shape] : []),
    '-z',
    '--no-renames',
    '--diff-merges=first-parent',
    `--format=${FORMAT}`,
    ...(limit ? ['-n', String(limit)] : []),
    ...(until ? [`--until=@${until}`] : []),
    ...revisions,
    '--',
  ];
  // --numstat reads every blob it counts, so one git does not have (a
  // partial clone's, never fetched, or a crafted commit's) fails the whole
  // log: then names only, which reads trees and never a blob, and where a
  // tree cannot be read at all (an empty name in it), no names. The graph
  // still draws, and that commit's card says why no rewind writes it.
  let listed;
  let shape;
  for (shape of ['--numstat', '--name-only', null]) {
    listed = await project.git(args(shape));
    if (listed.status === 0) break;
  }
  const text = ok(listed, 'log');
  const commits = [];
  for (const chunk of text.split('\x1e').slice(1)) {
    const end = chunk.indexOf('\0');
    const [sha, parents, tree, source, time, at, author, subject] = (end === -1 ? chunk : chunk.slice(0, end)).split('\x1f');
    const record = source === project.ref;
    const commit = {
      sha,
      parents: parents ? parents.split(' ') : [],
      tree,
      line: record ? 'record' : source.replace(/^refs\/heads\//, ''),
      refs: [],
      time,
      at: Number(at),
      subject,
      files: 0,
      plus: 0,
      minus: 0,
      changed: [],
      paths: [],
    };
    if (!record) commit.author = author;
    for (const entry of end === -1 ? [] : nul(chunk.slice(end + 1).replace(/^\n/, ''))) {
      let file = entry;
      if (shape === '--numstat') {
        const stat = entry.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
        if (!stat) continue;
        if (stat[1] !== '-') commit.plus += Number(stat[1]);
        if (stat[2] !== '-') commit.minus += Number(stat[2]);
        file = stat[3];
      }
      commit.files += 1;
      commit.paths.push(file);
      if (commit.changed.length < CHANGED_KEPT) commit.changed.push(file);
    }
    if (record) Object.assign(commit, parseSubject(subject));
    commits.push(commit);
  }
  return commits;
}

/**
 * The commits as a History page opened from one document sees them, from
 * the file lists the graph's one log already read (logCommits), so no
 * scope costs another git: each without `paths`, and, when `document` is
 * that document's path in the project ('/'-separated, as the record's
 * trees name it), with `scope`: 'document' for a commit that changed the
 * document itself, 'folder' for one that changed anything else under the
 * document's folder (at any depth; the whole project when the document is
 * at its top), null for the rest. A commit that changed the document also
 * names `beside`: the paths it changed in the document's folder, the
 * document's own among them, as git spells them (at most 200), which is
 * what a run writes beside its document (Knuth's values.json and figs/);
 * none for a root commit, whose first fill holds everything, nor for a
 * "rewind to", which writes whatever differed. Paths are compared as the
 * volume compares them. Without a document, the commits as they are.
 */
function scoped(root, commits, document = null) {
  const fold = foldFor(root);
  const doc = typeof document === 'string' && !badPath(document) ? fold(document) : null;
  const cut = doc ? doc.lastIndexOf('/') : -1;
  const folder = cut > 0 ? `${doc.slice(0, cut)}/` : '';
  return commits.map(({ paths = [], ...commit }) => {
    if (doc === null) return commit;
    const folded = paths.map(fold);
    if (folded.includes(doc)) {
      const plain = commit.parents.length === 0 || (commit.line === 'record' && commit.trigger === 'rewind-to');
      const beside = plain ? [] : paths.filter((_file, i) => folded[i].startsWith(folder)).slice(0, BESIDE_KEPT);
      return { ...commit, scope: 'document', beside };
    }
    return { ...commit, scope: folded.some((file) => file.startsWith(folder)) ? 'folder' : null };
  });
}

/** The user's local branches (no record's), and HEAD. */
async function refs(project) {
  const listed = ok(await project.git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads']), 'for-each-ref');
  const head = await project.git(['symbolic-ref', '-q', 'HEAD']);
  const headRef = head.status === 0 ? head.stdout.trim() : null;
  const headSha = await project.git(['rev-parse', '--verify', '-q', 'HEAD']);
  const branches = [];
  for (const line of listed.split('\n').filter(Boolean)) {
    const space = line.indexOf(' ');
    const ref = line.slice(space + 1);
    const name = ref.replace(/^refs\/heads\//, '');
    if (name === BRANCH_NAME || name.startsWith(`${BRANCH_NAME}-`)) continue;
    branches.push({ name, tip: line.slice(0, space), head: ref === headRef });
  }
  const result = {
    branches,
    head: { branch: headRef ? headRef.replace(/^refs\/heads\//, '') : null, sha: headSha.status === 0 ? headSha.stdout.trim() : null },
  };
  result.signature = JSON.stringify(result);
  return result;
}

/**
 * The tie of a commit on a user branch: the newest record commit at or
 * before its time that holds every file it holds, byte for byte (files
 * only the record has do not count, since a user's commits are often
 * partial): {sha, exact: true}; else, within 200 record commits, the one
 * with the fewest differing paths, {sha, exact: false, differs}; null
 * when the record has nothing that early. One `diff-tree --stdin` over
 * the candidates' trees (the newest ten first, which is where a match
 * usually is). Cached by sha in `cache`.
 */
async function tieOf(project, commit, cache, began) {
  if (cache.has(commit.sha)) return cache.get(commit.sha);
  if (began === null || commit.at < began) {
    // Made before the record began: nothing can hold its files.
    cache.set(commit.sha, null);
    return null;
  }
  const listed = ok(
    await project.git(['log', '-n', String(TIE_CANDIDATES), `--until=@${commit.at}`, '--format=%H %T', project.ref, '--']),
    'log',
  );
  const candidates = listed
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, tree] = line.split(' ');
      return { sha, tree };
    });
  let best = null;
  for (const batch of [candidates.slice(0, 10), candidates.slice(10)]) {
    if (batch.length === 0) continue;
    const trees = [...new Set(batch.map((candidate) => candidate.tree))];
    const input = trees.map((tree) => `${tree} ${commit.tree}\n`).join('');
    const text = ok(
      await project.git(['diff-tree', '--stdin', '-r', '--no-renames', '--name-only', '--diff-filter=AMT', '-z'], { input }),
      'diff-tree --stdin',
    );
    // Each pair's line is echoed, then its paths, each ending in NUL.
    const differs = new Map();
    let at = 0;
    let current = null;
    const header = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64})\n/;
    while (at < text.length) {
      const found = text.slice(at, at + 140).match(header);
      if (found) {
        current = found[1];
        differs.set(current, []);
        at += found[0].length;
        continue;
      }
      const end = text.indexOf('\0', at);
      const name = text.slice(at, end === -1 ? text.length : end);
      if (current !== null && name) differs.get(current).push(name);
      at = end === -1 ? text.length : end + 1;
    }
    for (const candidate of batch) {
      const paths = differs.get(candidate.tree) ?? [];
      if (paths.length === 0) {
        best = { sha: candidate.sha, exact: true };
        break;
      }
      if (!best || paths.length < best.differs.length) best = { sha: candidate.sha, exact: false, differs: paths.slice(0, CHANGED_KEPT) };
    }
    if (best?.exact) break;
  }
  cache.set(commit.sha, best);
  return best;
}

/**
 * The graph for the history view: the record and the user's branches in
 * one list, newest first, from one log: `--branches` with the records
 * excluded (neither this working tree's nor another worktree's) takes the
 * user's branches, and the record comes in by name. Not `--all`, which
 * pulls in refs/stash, remotes and other worktrees' records. `before`
 * pages back in time (the same log, until that commit's time; the page
 * drops any it already holds). Answer: {tip, head, branches, commits,
 * more, total}; each commit is {sha, parents, line ('record' or the
 * branch it was reached by), refs, time, subject, files, plus, minus,
 * changed}, a record commit with its message parsed (parseSubject), a
 * user commit with its author and its `tie`; with `document` (a path in
 * the project), each with its `scope` and `beside` too (scoped).
 */
async function graph(project, { before = null, limit = LIMIT, ties = new Map(), document = null } = {}) {
  const most = Math.max(1, Math.min(MOST, Number.isInteger(limit) ? limit : LIMIT));
  const tip = await project.tip();
  let until = null;
  if (before) {
    const sha = await resolveCommit(project, before);
    until = ok(await project.git(['log', '-1', '--format=%ct', sha, '--']), 'log').trim();
  }
  const revisions = [`--exclude=${BRANCH_NAME}`, `--exclude=${BRANCH_NAME}-*`, '--branches', ...(tip ? [project.ref] : [])];
  const commits = await logCommits(project, revisions, { limit: most + 1, until });
  const more = commits.length > most;
  if (more) commits.length = most;
  const { branches, head } = await refs(project);
  const tipsOf = new Map();
  for (const branch of branches) tipsOf.set(branch.tip, [...(tipsOf.get(branch.tip) ?? []), branch.name]);
  if (tip) tipsOf.set(tip, [...(tipsOf.get(tip) ?? []), project.branchName]);
  // When the record began: its root commit's time.
  const began = tip
    ? Math.min(...ok(await project.git(['log', '--max-parents=0', '--format=%at', project.ref, '--']), 'log').split('\n').filter(Boolean).map(Number))
    : null;
  for (const commit of commits) {
    commit.refs = tipsOf.get(commit.sha) ?? [];
    if (commit.line !== 'record') commit.tie = await tieOf(project, commit, ties, began);
  }
  const total = tip ? Number(ok(await project.git(['rev-list', '--count', project.ref, '--']), 'rev-list').trim()) : 0;
  return { tip, head, branches, commits: scoped(project.root, commits, document), more, total };
}

/** The record's commits after `from` up to `to`, newest first, shaped as
 *  the graph's (for the `history {kind: 'commit'}` event), each still with
 *  its `paths`: the shell scopes them for each page (scoped). */
async function recordSince(project, from, to, limit = 500) {
  if (!to) return [];
  checkedSha(to, 'tip');
  if (from) checkedSha(from, 'tip');
  const commits = await logCommits(project, [from ? `${from}..${to}` : to], { limit });
  // Reached by a range, not by the ref's name: every one is the record's.
  return commits.map((commit) => ({ ...commit, line: 'record', ...parseSubject(commit.subject), author: undefined }));
}

/** The record's tip read cheaply, for the shell's two-second look: the
 *  loose ref file, else git (a packed ref). */
async function recordTip(project) {
  try {
    const text = (await fsp.readFile(path.join(await project.common(), project.ref), 'utf8')).trim();
    if (/^[0-9a-f]{40,64}$/.test(text)) return text;
  } catch {
    // Packed, or not there yet.
  }
  return project.tip();
}

/** The paths a commit changed against its first parent (every path the
 *  "rewind to" commit wrote or removed, for another app's reload). */
async function touched(project, sha) {
  const commit = await resolveCommit(project, sha);
  const parent = (await project.git(['rev-parse', '--verify', '-q', `${commit}^1`])).stdout.trim() || null;
  return (await rawDiff(project, parent ? await treeOf(project, parent) : null, await treeOf(project, commit))).map((entry) => entry.path);
}

// MARK: - One commit, one file

/**
 * What one commit changed against its first parent (the empty tree for a
 * root): {sha, parents, time, subject, author, files: [{path, status,
 * plus, minus, binary, link?, gitlink?, patch?, cut?, large?, size?}]}.
 * A patch is capped at 400 lines per file and 1 MB in all, and left out
 * for a commit of more than 400 files; a file with a side past 1 MB has
 * none and is `large`, with the larger side's `size`. diff-tree runs with
 * no external diff and no textconv.
 */
async function commitDetail(project, sha) {
  const full = await resolveCommit(project, sha);
  const [, parents, time, subject, author] = ok(await project.git(['log', '-1', '--format=%H%x1f%P%x1f%aI%x1f%s%x1f%an', full, '--']), 'log')
    .replace(/\n$/, '')
    .split('\x1f');
  const parentList = parents ? parents.split(' ') : [];
  const left = parentList[0] ?? (await emptyTree(project));
  const raw = await rawDiff(project, left, full);
  // No counts where git cannot read a blob it would count (a partial
  // clone's, a crafted commit's): the files are still listed.
  const counted = await project.git(['diff-tree', '-r', '--no-renames', '--numstat', '-z', left, full]);
  const stats = counted.status === 0 ? nul(counted.stdout) : [];
  const byPath = new Map();
  for (const entry of stats) {
    const stat = entry.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (stat) byPath.set(stat[3], { plus: stat[1] === '-' ? 0 : Number(stat[1]), minus: stat[2] === '-' ? 0 : Number(stat[2]), binary: stat[1] === '-' });
  }
  const files = raw.map((entry) => ({
    path: entry.path,
    status: entry.status,
    plus: byPath.get(entry.path)?.plus ?? 0,
    minus: byPath.get(entry.path)?.minus ?? 0,
    binary: byPath.get(entry.path)?.binary ?? false,
    ...(entry.from === '120000' || entry.to === '120000' ? { link: true } : {}),
    ...(entry.from === GITLINK || entry.to === GITLINK ? { gitlink: true } : {}),
  }));
  if (files.length > 0 && files.length <= PATCH_FILES) {
    // Patches only for files whose two sides are small enough to read, so
    // one huge file costs only itself its patch, and git's output always
    // fits its buffer. A type change is two chunks in a patch, and a
    // nested repository's says only which commit: neither is asked for.
    const wanted = raw.map((entry, i) => ({ entry, file: files[i] })).filter(({ entry, file }) => !file.binary && !file.gitlink && entry.status !== 'T');
    const sizes = await blobSizes(project, wanted.flatMap(({ entry }) => [entry.a, entry.b]));
    let room = PATCH_READ;
    const chosen = [];
    for (const item of wanted) {
      const one = sizes.get(item.entry.a) ?? 0;
      const two = sizes.get(item.entry.b) ?? 0;
      if (one > BLOB_BYTES || two > BLOB_BYTES) {
        item.file.large = true;
        item.file.size = Math.max(one, two);
        continue;
      }
      if (one + two > room) continue;
      room -= one + two;
      chosen.push(item);
    }
    const patch = chosen.length
      ? await project.git(['diff-tree', '-r', '--no-renames', '-p', '--no-color', '--no-ext-diff', '--no-textconv', left, full, '--', ...chosen.map(({ entry }) => entry.path)], {
          env: { GIT_LITERAL_PATHSPECS: '1' },
        })
      : null;
    if (patch?.status === 0) {
      // One chunk per file, in the same order as the raw list.
      const chunks = patch.stdout.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith('diff --git '));
      if (chunks.length === chosen.length) {
        let budget = PATCH_BYTES;
        chunks.forEach((chunk, i) => {
          const start = chunk.search(/^@@ /m);
          if (start === -1 || budget <= 0) return;
          const lines = chunk.slice(start).replace(/\n$/, '').split('\n');
          let text = lines.slice(0, PATCH_LINES).join('\n');
          if (text.length > budget) text = text.slice(0, budget);
          budget -= text.length;
          chosen[i].file.patch = text;
          if (lines.length > PATCH_LINES || text.length < lines.join('\n').length) chosen[i].file.cut = true;
        });
      }
    }
  }
  return { sha: full, parents: parentList, time, subject, author, files };
}

/** The sizes of blobs by name (zeros, for no blob, are left out): one
 *  `cat-file --batch-check`. */
async function blobSizes(project, shas) {
  const names = [...new Set(shas.filter((sha) => sha && !/^0+$/.test(sha)))];
  const sizes = new Map();
  if (names.length === 0) return sizes;
  const text = ok(await project.git(['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: `${names.join('\n')}\n` }), 'cat-file --batch-check');
  for (const line of text.split('\n')) {
    const [sha, size] = line.split(' ');
    if (/^\d+$/.test(size ?? '')) sizes.set(sha, Number(size));
  }
  return sizes;
}

/** A file at a commit or a tree: {text, size} (UTF-8, at most 1 MB),
 *  {binary: true, size}, or {large: true, size} past 1 MB, which is not
 *  read at all (its size is asked first), so a 400 MB file costs nothing.
 *  The page says a large file is too large to look inside. */
async function blob(project, sha, file) {
  checkedSha(sha);
  if (typeof file !== 'string' || !file || file.includes('\0') || file.startsWith('/')) throw new Error('path must be a path inside the project');
  const name = `${sha}:${file}`;
  const kind = await project.git(['cat-file', '-t', name]);
  if (kind.status !== 0) return { missing: true };
  if (kind.stdout.trim() !== 'blob') return { missing: true, kind: kind.stdout.trim() };
  const size = Number(ok(await project.git(['cat-file', '-s', name]), 'cat-file').trim());
  if (!(size <= BLOB_BYTES)) return { large: true, size };
  const bytes = await project.git(['cat-file', 'blob', name], { encoding: 'buffer' });
  if (bytes.status !== 0) throw new Error(`git cat-file: ${errorLine(bytes.stderr) || bytes.status}`);
  if (bytes.stdout.subarray(0, Math.min(bytes.stdout.length, 8000)).includes(0)) return { binary: true, size };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.stdout), size };
  } catch {
    return { binary: true, size };
  }
}

// MARK: - What a rewind does

/** The manifest's files at a tree: path → sha256; null when it has none. */
async function manifestAt(project, tree) {
  if (!tree) return null;
  const name = `${tree}:${MANIFEST_PATH}`;
  const size = await project.git(['cat-file', '-s', name]);
  if (size.status !== 0 || Number(size.stdout) > MANIFEST_BYTES) return null;
  try {
    const parsed = JSON.parse(ok(await project.git(['cat-file', 'blob', name]), 'cat-file'));
    return new Map((parsed.files ?? []).map((entry) => [entry.path, entry.sha256]));
  } catch {
    return null;
  }
}

/**
 * What stands where a rewind would write `file`, or null when the way is
 * clear. It walks from the project's root with lstat, never following a
 * link: each leading name must be a real folder (or missing, and then so
 * is everything below it), and the last must be missing for a new file
 * (`added`), or anything but a folder for one the record holds (which
 * checkout-index replaces, a link included, never writing through it).
 * Something this same set removes is no obstacle (`removing`, folded): a
 * leading file or link it removes, or a folder at the path whose recorded
 * files it all removes (`goes`). The rewind asks again after its removals,
 * with nothing removing, so a folder that still holds a file the record
 * does not keep stops the write then.
 */
function obstacle(root, file, { added, removing = null, fold = (name) => name, goes = () => false }) {
  const parts = file.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const at = parts.slice(0, i).join('/');
    let info;
    try {
      info = fs.lstatSync(path.join(root, ...parts.slice(0, i)));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return `${at} cannot be looked at (${error.code ?? error.message})`;
    }
    const last = i === parts.length;
    if (info.isDirectory()) {
      if (!last) continue;
      if (removing && goes(at)) return null;
      return 'a folder is there, and this commit has a file by that name';
    }
    if (removing && removing.has(fold(at))) return null;
    if (!last) return `${at} is ${info.isSymbolicLink() ? 'a symbolic link' : 'a file'} here, and a folder in this commit`;
    if (!added) return null;
    return 'something the record does not keep is there (an ignored file, or one kept out as a secret)';
  }
  return null;
}

/**
 * The rewind's set, by the rules: what writing `target`'s files over a
 * working tree whose tree is `base` would do. A, M and T paths are
 * written; a D path is removed only when the target is on the record and
 * the record's tip held it (`held`); the manifest and untracked/ are left
 * out, in whatever case the volume takes for them (a file the target
 * holds under the name untracked is named among the skipped); a gitlink,
 * a .gitignore that is a link in the target, whatever the target holds in
 * a folder named .gitignore, .claerbout/ignore itself, and a file it keeps
 * out of the record (autosave.js keptOut, on either side), are left alone
 * and named; and a path with something in its way (obstacle) is skipped
 * and named, except where what is in its way is something this same set
 * removes: a file that becomes a folder, or a folder (or a link to one)
 * that becomes a file, is written once the removal clears it. `paths`,
 * when given, keeps the set to those (folded as the volume compares
 * them), and a removal left out keeps its way blocked. A target that
 * fails checkTree, or whose tree git cannot diff, is {invalid: {path,
 * why, absent?}} and nothing else: checked whole, whatever `paths`
 * keeps, so a choice of files never makes such a commit writable. Answer:
 * {write: [{path, status}], remove: [path], skipped: [{path, why}], kept:
 * [path] (removals the rules forbid), full (the set's size before
 * `paths`)}.
 */
async function rewindSet(project, { base, target, held, onRecord, paths = null }) {
  const fold = foldFor(project.root);
  const refused = (invalid) => ({ invalid, write: [], remove: [], skipped: [], kept: [], full: 0 });
  const invalid = await checkTree(project, target, fold);
  if (invalid) return refused(invalid);
  const heldNames = new Set([...held].map(fold));
  const skipped = [];
  const kept = [];
  const removals = [];
  const writes = [];
  let diff;
  try {
    diff = await rawDiff(project, base, target);
  } catch (error) {
    return refused(unreadable(error));
  }
  for (const entry of diff) {
    const why = badPath(entry.path);
    if (why) return refused({ path: entry.path, why });
  }
  // Each side's paths apart: one tree's file may be the other's folder.
  const keptOut = await project.keptOut([diff.filter((entry) => entry.status !== 'D').map((entry) => entry.path), diff.filter((entry) => entry.status !== 'A').map((entry) => entry.path)]);
  for (const entry of diff) {
    if (fold(entry.path) === fold(RECORD_IGNORE_PATH)) {
      // The record's own rules: a rewind to a day before them would let
      // the next render into a record that is never pruned.
      skipped.push({ path: entry.path, why: "the record's own rules, left as they are" });
      continue;
    }
    if (keptOut.has(entry.path) && !recordOwn(entry.path, fold) && fold(entry.path) !== fold('.gitignore')) {
      skipped.push({ path: entry.path, why: 'kept out by .claerbout/ignore' });
      continue;
    }
    if (recordOwn(entry.path, fold)) {
      // Left alone; but a file the commit holds under the folder's own
      // name is the project's, and is named rather than passed over.
      if (entry.status !== 'D' && fold(entry.path) === fold(UNTRACKED)) {
        skipped.push({ path: entry.path, why: `the record keeps the name ${UNTRACKED} for its own folder, so a file of that name is left alone` });
      }
      continue;
    }
    if (entry.from === GITLINK || entry.to === GITLINK) {
      skipped.push({ path: entry.path, why: 'a nested repository, left alone' });
      continue;
    }
    if (entry.to === '120000' && fold(entry.path) === fold('.gitignore')) {
      // git reads no linked .gitignore, so untracked/ would lose its line
      // and the record's next fill would take it in.
      skipped.push({ path: entry.path, why: 'a .gitignore that is a symbolic link in this commit: git reads none, and untracked/ would lose its line' });
      continue;
    }
    if (entry.status !== 'D' && fold(entry.path).startsWith(`${fold('.gitignore')}/`)) {
      // A folder named .gitignore: git reads no top .gitignore then either.
      skipped.push({ path: entry.path, why: 'it lies in a folder named .gitignore in this commit: git reads no .gitignore then, and untracked/ would lose its line' });
      continue;
    }
    if (entry.status === 'D') {
      if (onRecord && heldNames.has(fold(entry.path))) removals.push(entry.path);
      else kept.push(entry.path);
      continue;
    }
    writes.push(entry);
  }
  // The base's paths, folded, read once and only when a removal might
  // clear a folder out of a new file's way.
  let recorded = null;
  const plan = async (removed) => {
    const removing = new Set(removed.map(fold));
    if (recorded === null && removed.length > 0 && writes.some((entry) => entry.status === 'A')) recorded = [...(await pathsIn(project, base))].map(fold);
    const goes = (at) => {
      const prefix = `${fold(at)}/`;
      let any = false;
      for (const file of recorded ?? []) {
        if (!file.startsWith(prefix)) continue;
        if (!removing.has(file)) return false;
        any = true;
      }
      return any;
    };
    const write = [];
    const left = [];
    for (const entry of writes) {
      const why = obstacle(project.root, entry.path, { added: entry.status === 'A', removing, fold, goes });
      if (why) left.push({ path: entry.path, why });
      else write.push({ path: entry.path, status: entry.status });
    }
    return { write, left };
  };
  const all = await plan(removals);
  const full = all.write.length + removals.length;
  if (!Array.isArray(paths)) return { write: all.write, remove: removals, skipped: [...skipped, ...all.left], kept, full };
  const wanted = new Set(paths.filter((file) => typeof file === 'string').map(fold));
  const remove = removals.filter((file) => wanted.has(fold(file)));
  const chosen = remove.length === removals.length ? all : await plan(remove);
  const before = new Set(all.left.map((entry) => entry.path));
  return {
    write: chosen.write.filter((entry) => wanted.has(fold(entry.path))),
    remove,
    // Left as they are: what no choice could write, and what a removal
    // left out of the choice keeps in the way.
    skipped: [...skipped, ...all.left, ...chosen.left.filter((entry) => !before.has(entry.path) && wanted.has(fold(entry.path)))],
    kept,
    full,
  };
}

/** Whether a commit is the record's tip or behind it. */
async function onTheRecord(project, sha, tip) {
  if (!tip) return false;
  return (await project.git(['merge-base', '--is-ancestor', sha, tip])).status === 0;
}

/** Another app's documents on this project that a set writes or removes:
 *  {app, documents} for the first such app, or null. */
function heldElsewhere(project, others, set) {
  const fold = foldFor(project.root);
  const touchedPaths = new Set([...set.write.map((entry) => entry.path), ...set.remove].map(fold));
  for (const other of others) {
    const documents = (other.documents ?? []).filter((file) => {
      const relative = relativeTo(project.root, file);
      return relative !== null && touchedPaths.has(fold(relative));
    });
    if (documents.length > 0) return { app: other.app, documents };
  }
  return null;
}

/** A document's path inside the project, '/'-separated, as the record's
 *  trees name it; null when it is outside. Both sides are resolved through
 *  any link on the way, so a project reached through one (~/Projects/week-3
 *  a link, macOS's /var → /private/var) still holds its documents. */
function relativeTo(root, file) {
  let base = root;
  try {
    base = fs.realpathSync.native(root);
  } catch {
    // Gone: compared as given.
  }
  let real = file;
  try {
    real = fs.realpathSync.native(file);
  } catch {
    try {
      real = path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file));
    } catch {
      // Gone: compared as given.
    }
  }
  const relative = path.relative(base, real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/** Documents' paths as the History page compares them with the record's:
 *  each one's path in the project (relativeTo, through any link), or, for
 *  one outside it, its path as given. The page never matches an absolute
 *  path against the project's root as text. */
function pagePaths(root, files) {
  return (files ?? []).filter((file) => typeof file === 'string').map((file) => relativeTo(root, file) ?? file);
}

/**
 * What a rewind to `sha` would do now, on the project's job queue like a
 * commit: {tip, now, target, onRecord, unrecorded, write, remove, skipped,
 * kept, same, untracked, untrackedGone, others, blocked}, and `invalid`
 * ({path, why, absent?}, with nothing to write) for a target no rewind
 * writes: the rewind's own checks, git's read-tree among them.
 * `now` is the tree of a fresh fill of the working tree (written, not
 * committed), so the page can read now's files from it; while a guard
 * holds, nothing is filled and `now` is the tip's tree. `others()` is
 * another app's windows on the project (the presence files): [{app,
 * documents}].
 */
function compare(project, sha, { paths = null, others = () => [] } = {}) {
  return project.run(async () => {
    try {
      const target = await resolveCommit(project, sha);
      const tip = await project.tip();
      const tipTree = tip ? await treeOf(project, tip) : null;
      let blocked = await project.blocked();
      let now = tipTree;
      if (!blocked) {
        try {
          now = await project.snapshot();
        } catch (error) {
          if (!error.reason) throw error;
          blocked = error.reason;
        }
      }
      const targetTree = await treeOf(project, target);
      const onRecord = await onTheRecord(project, target, tip);
      let set = await rewindSet(project, { base: now, target: targetTree, held: await pathsIn(project, tipTree), onRecord, paths });
      if (!set.invalid) {
        // git's own check, as the rewind makes it, so the card never offers
        // a rewind that a click would refuse: the throwaway index is dropped.
        const read = await readTarget(project, target);
        if (read.refused) set = { invalid: read.refused };
        else await dropIndex(read.index);
      }
      const answer = { tip, now, target, onRecord, others: others(), blocked: blocked ?? null };
      if (set.invalid) {
        return { ...answer, invalid: set.invalid, unrecorded: [], write: [], remove: [], skipped: [], kept: [], same: 0, untracked: false, untrackedGone: [] };
      }
      const fold = foldFor(project.root);
      const unrecorded = blocked || !now ? [] : (await rawDiff(project, tipTree, now)).map((entry) => entry.path);
      const differing = new Set((await rawDiff(project, now, targetTree)).map((entry) => entry.path));
      const same = [...(await pathsIn(project, targetTree))].filter((file) => !recordOwn(file, fold) && !differing.has(file)).length;
      const then = await manifestAt(project, targetTree);
      const current = await manifestAt(project, now);
      const untracked = then !== null && JSON.stringify([...then]) !== JSON.stringify([...(current ?? new Map())]);
      const untrackedGone = untracked ? [...then].filter(([file, hash]) => current?.get(file) !== hash).map(([file]) => file) : [];
      return {
        ...answer,
        unrecorded,
        write: set.write,
        remove: set.remove,
        skipped: set.skipped,
        kept: set.kept,
        same,
        untracked,
        untrackedGone,
      };
    } catch (error) {
      return { error: error.message };
    }
  });
}

/** null when every name of `parts` below the root is a real folder,
 *  looked at with lstat and never followed; else why not ('missing' when
 *  one is not there). */
async function realFolders(root, parts) {
  for (let i = 1; i <= parts.length; i++) {
    const at = parts.slice(0, i).join('/');
    let info;
    try {
      info = await fsp.lstat(path.join(root, ...parts.slice(0, i)));
    } catch (error) {
      if (error.code === 'ENOENT') return 'missing';
      return `${at} cannot be looked at (${error.code ?? error.message})`;
    }
    if (!info.isDirectory()) return `${at} is ${info.isSymbolicLink() ? 'a symbolic link' : 'not a folder'} here`;
  }
  return null;
}

/**
 * Remove a file or link the rewind's set names (never what a link points
 * to), then its folders while they are empty, never past the root: true
 * when it went, false when nothing was there, or why it was left. Every
 * name on the way is looked at with lstat from the root first, and again
 * before each folder is removed, so nothing is ever removed through a
 * link that took a folder's place.
 */
async function removePath(root, file) {
  const parts = file.split('/');
  const way = await realFolders(root, parts.slice(0, -1));
  if (way === 'missing') return false;
  if (way) return way;
  const full = path.join(root, ...parts);
  let info;
  try {
    info = await fsp.lstat(full);
  } catch {
    return false;
  }
  if (info.isDirectory()) return 'a folder is there now';
  await fsp.unlink(full);
  for (let i = parts.length - 1; i >= 1; i--) {
    if ((await realFolders(root, parts.slice(0, i))) !== null) break;
    try {
      await fsp.rmdir(path.join(root, ...parts.slice(0, i)));
    } catch {
      break;
    }
  }
  return true;
}

/** git's own check of every name a target holds: `read-tree` into a new
 *  throwaway index in the shell's state folder, the one the write then
 *  checks files out of. {index}, or {refused: {path, why}}. */
async function readTarget(project, target) {
  await fsp.mkdir(project.stateDir, { recursive: true });
  const index = path.join(project.stateDir, `rewind-${process.pid}-${Date.now()}.index`);
  const read = await project.git(['read-tree', target], { env: { GIT_INDEX_FILE: index } });
  if (read.status === 0) return { index };
  await dropIndex(index);
  return { refused: refusedByGit(read.stderr, read.status) };
}

/** What git's read-tree said in refusing a target: {path, why}, with the
 *  path its message names, when it names one, and null otherwise. */
function refusedByGit(stderr, status) {
  // git prints the path as it is, quotes and newlines included: the
  // quoted name runs to the last quote of the message.
  const named = String(stderr).trimEnd().match(/(?:^|\n)(?:error|fatal): invalid path '([\s\S]+)'$/);
  if (named) return { path: named[1], why: 'git refuses it (an invalid path)' };
  const line = errorLine(stderr) || `read-tree failed (${status})`;
  return { path: null, why: `git refuses a path in it (${line.replace(/^(error|fatal): /, '')})` };
}

async function dropIndex(index) {
  await fsp.rm(index, { force: true });
  await fsp.rm(`${index}.lock`, { force: true });
}

/** The target's files at `paths`, written into the working tree from the
 *  throwaway index (checkout-index on those paths only, never -a). */
async function writeFiles(project, index, paths) {
  if (paths.length === 0) return;
  ok(await project.git(['checkout-index', '-f', '-z', '--stdin'], { env: { GIT_INDEX_FILE: index }, input: `${paths.join('\0')}\0` }), 'checkout-index');
}

/** Whether git's rules ignore untracked/ with `text` as the top
 *  .gitignore: asked of git as prepare() asks it (check-ignore), in a
 *  scratch folder of the shell's state that holds that .gitignore alone,
 *  with the repository's own info/exclude and excludes file. */
async function ignoresUntracked(project, text) {
  await fsp.mkdir(project.stateDir, { recursive: true });
  const scratch = await fsp.mkdtemp(path.join(project.stateDir, `ignore-${process.pid}-`));
  try {
    await fsp.writeFile(path.join(scratch, '.gitignore'), text);
    const asked = await project.git(['-C', scratch, `--git-dir=${path.resolve(project.root, project.gitDir)}`, '--work-tree=.', 'check-ignore', '-q', `${UNTRACKED}/`]);
    return asked.status === 0;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The top .gitignore, written by the rewind itself, never by
 * checkout-index: the target's (in `tree`; none when null), with the
 * record's /untracked/ line appended where prepare() would append it (the
 * manifest kept, and the rules, that .gitignore among them, not ignoring
 * untracked/ without it), written whole (replaceFile: a new file made in
 * the shell's state folder, outside the working tree, and renamed over
 * it). So the working tree never holds a .gitignore without the line, not
 * for a moment: checkout-index would write the target's first and every
 * other file after it, and another app's fill in that gap could take
 * untracked/ into the record, which is never pruned. A rename replaces a
 * link rather than following it. true when written; null when the target
 * has none and the record needs no line (it is removed as any file is);
 * or why it was left.
 */
async function writeIgnore(project, file, tree) {
  let text = Buffer.alloc(0);
  let mode = '100644';
  if (tree) {
    const listed = nul(ok(await project.git(['ls-tree', '-z', tree, '--', file], { env: { GIT_LITERAL_PATHSPECS: '1' } }), 'ls-tree'))[0];
    if (!listed) throw new Error(`${file} is not in the target`);
    const [entryMode, , object] = listed.slice(0, listed.indexOf('\t')).split(' ');
    mode = entryMode;
    const read = await project.git(['cat-file', 'blob', object], { encoding: 'buffer' });
    if (read.status !== 0) throw new Error(`git cat-file: ${errorLine(read.stderr) || read.status}`);
    text = read.stdout;
  }
  const line = project.manifest && !(await ignoresUntracked(project, text)) ? IGNORE_LINES : '';
  if (!tree && !line) return null;
  const full = path.join(project.root, file);
  try {
    if ((await fsp.lstat(full)).isDirectory()) return 'a folder is there now';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lead = line && text.length > 0 && text[text.length - 1] !== 0x0a ? '\n' : '';
  await replaceFile(full, Buffer.concat([text, Buffer.from(lead + line)]), { mode: mode === '100755' ? 0o777 : 0o666, stage: project.stateDir });
  return true;
}

/**
 * The rewind, as one job on the project's queue (so the record's timer is
 * dropped while it runs): `{sha, tip, paths?, anyway?}`.
 *
 * Checks, before anything is recorded or touched: the record's tip must
 * still be `tip`, else {refused: 'moved', tip}; no guard may hold, else
 * {refused: 'paused', reason}; the target must pass checkTree (its paths,
 * and every file and link a blob that is here) and git's own read-tree,
 * else {refused: 'invalid', path, why, absent?, partial?}, `path` null when
 * git names none; another app's windows holding a file the rewind writes or
 * removes refuse it, {refused: 'other-app', app, documents}, unless `anyway`;
 * nothing to write or remove is {same: true}. Then the rewind takes the
 * working tree's lock (autosave.js lockRewind), which another shell's
 * rewind holding it refuses ({refused: 'paused', reason}: "Plass is
 * rewinding this project"). Held until the rewind ends, the lock keeps
 * every other shell's commits waiting too, so none records the rewind
 * half written. Then `save()` asks this shell's windows on the project to
 * save: it answers {unsaved: {path, error?}} when a window answered that
 * it could not, which refuses the rewind ({refused: 'unsaved', path,
 * error?}), or {silent: [path]}, the
 * documents whose windows did not answer, which goes on. Then the three
 * steps:
 *
 * 1. Record now: "<app>: rewind from <tip>", through the record's own
 *    commit path, skipped when the working tree equals the tip.
 * 2. Write the target's files: the set again, against the tip after step
 *    1; removals first, then the writes (each path asked again whether
 *    anything is in its way), from the index read-tree made, but for the
 *    top .gitignore, which writeIgnore writes with the record's line in it
 *    (and which, when the set removes it, becomes that line alone), so the
 *    working tree never holds one without the line. The record's
 *    `prepared` is cleared before anything is touched, and the record
 *    prepares again as soon as the step ends, whether it finished or not.
 * 3. Record the rewind: "<app>: rewind to <target>" (with its paths for a
 *    partial one), always.
 *
 * `onStep(step, state, detail?)` hears 'save' (done with {silent} when a
 * window did not answer), 'record-from', 'write' and 'record-to', each
 * 'doing' then 'done'. Answer: {ok: true, from, to, target, written,
 * removed, skipped, silent}, `from` null when step 1 was skipped. A git
 * failure in step 2 or 3 is {refused: 'failed', detail}; the next commit
 * records whatever the folder then holds.
 */
function rewind(project, request, { save = async () => null, onStep = () => {}, others = () => [] } = {}) {
  return project.run(async () => {
    let step = 'check';
    let index = null;
    let locked = false;
    try {
      const target = await resolveCommit(project, request?.sha);
      const tip = await project.tip();
      if ((request?.tip ?? null) !== tip) return { refused: 'moved', tip };
      if (!tip) return { refused: 'failed', detail: 'the record has no commit yet' };
      const reason = await project.blocked();
      if (reason) return { refused: 'paused', reason };
      const paths = Array.isArray(request.paths) ? request.paths : null;
      const tipTree = await treeOf(project, tip);
      const held = await pathsIn(project, tipTree);
      const targetTree = await treeOf(project, target);
      const onRecord = await onTheRecord(project, target, tip);
      let now;
      try {
        now = await project.snapshot();
      } catch (error) {
        if (error.reason) return { refused: 'paused', reason: error.reason };
        throw error;
      }
      const planned = await rewindSet(project, { base: now, target: targetTree, held, onRecord, paths });
      if (planned.invalid) return { refused: 'invalid', ...planned.invalid };
      const read = await readTarget(project, target);
      if (read.refused) return { refused: 'invalid', ...read.refused };
      index = read.index;
      if (!request.anyway) {
        const holder = heldElsewhere(project, others(), planned);
        if (holder) return { refused: 'other-app', ...holder };
      }
      if (planned.write.length + planned.remove.length === 0) return { same: true };

      // One rewind at a time on a working tree, whichever shell runs it. One
      // that ran to its end between this one's checks and its lock is like a
      // timer's commit meanwhile: step 2 reckons against the tip as it then
      // is, and removes only what the tip the card was drawn against held.
      const rewinding = await project.lockRewind();
      if (rewinding) return { refused: 'paused', reason: rewinding };
      locked = true;

      step = 'save';
      onStep('save', 'doing');
      const saved = (await save()) ?? {};
      if (saved.unsaved) return { refused: 'unsaved', ...saved.unsaved };
      const silent = Array.isArray(saved.silent) ? saved.silent : [];
      onStep('save', 'done', silent.length > 0 ? { silent } : undefined);

      step = 'record-from';
      onStep('record-from', 'doing');
      const recorded = await project.commit(`rewind from ${tip}`);
      if (!recorded.committed && recorded.skipped !== 'unchanged') return { refused: 'paused', reason: recorded.skipped };
      const from = recorded.committed ? recorded.hash : null;
      onStep('record-from', 'done', { from });

      step = 'write';
      onStep('write', 'doing');
      // Whatever happens from here, the next fill prepares first.
      project.prepared = false;
      const removed = [];
      const written = [];
      let set;
      try {
        // Against the record as it now is: the working tree, just recorded.
        const base = await treeOf(project, (await project.tip()) ?? tip);
        set = await rewindSet(project, { base, target: targetTree, held, onRecord, paths });
        if (set.invalid) throw new Error(`${set.invalid.path}: ${set.invalid.why}`);
        // The top .gitignore is never checkout-index's: writeIgnore keeps
        // the record's line in it throughout.
        const fold = foldFor(project.root);
        const isIgnore = (file) => fold(file) === fold('.gitignore');
        for (const file of set.remove) {
          // A .gitignore the target lacks becomes the record's line alone,
          // when the record needs one, rather than going.
          let gone = isIgnore(file) ? await writeIgnore(project, file, null) : null;
          if (gone === null) gone = await removePath(project.root, file);
          if (gone === true) removed.push(file);
          else if (gone) set.skipped.push({ path: file, why: `${gone}, so it was not removed` });
        }
        for (const entry of set.write) {
          // A removal above may have cleared the way; anything still in it
          // is left alone.
          const why = obstacle(project.root, entry.path, { added: entry.status === 'A' });
          if (why) set.skipped.push({ path: entry.path, why });
          else written.push(entry.path);
        }
        // .gitignore first, as checkout-index would sort it, then the rest.
        const ignore = written.find(isIgnore);
        if (ignore) {
          const left = await writeIgnore(project, ignore, targetTree);
          if (left !== true) {
            written.splice(written.indexOf(ignore), 1);
            set.skipped.push({ path: ignore, why: left });
          }
        }
        await writeFiles(project, index, written.filter((file) => file !== ignore));
      } finally {
        // Whatever the step did, the record prepares now, not at the next
        // fill, which may be another app's.
        await project.prepare().catch(() => {
          project.prepared = false;
        });
      }
      onStep('write', 'done', { written, removed });

      step = 'record-to';
      onStep('record-to', 'doing');
      const partial = paths !== null && written.length + removed.length < set.full ? [...written, ...removed].sort() : null;
      const landed = await project.commit(rewindToTrigger(target, partial), { always: true });
      if (!landed.committed) return { refused: 'failed', detail: `the files were written, but the record did not commit: ${landed.skipped}`, written, removed };
      onStep('record-to', 'done', { to: landed.hash });
      return { ok: true, from, to: landed.hash, target, written, removed, skipped: set.skipped, silent };
    } catch (error) {
      if (step === 'check' || step === 'save') return { refused: 'failed', detail: error.message };
      return { refused: 'failed', detail: `${step}: ${error.message}` };
    } finally {
      if (index) await dropIndex(index);
      if (locked) await project.unlockRewind();
    }
  });
}

// MARK: - Two shells on one project

/**
 * Which documents each app has open on which project, for a rewind's
 * `others` and `other-app` (open question 5): one file per app and
 * project in a folder every Claerbout app shares, {app, pid, root,
 * documents}, written when an app's windows on a project change and
 * removed when the last leaves and at quit. A file whose pid is gone is
 * ignored.
 */
function presence(dir) {
  const fileFor = (appName, root) => path.join(dir, `${appName}-${createHash('sha256').update(root).digest('hex').slice(0, 16)}.json`);
  return {
    dir,
    write(appName, root, documents) {
      const file = fileFor(appName, root);
      if (documents.length === 0) {
        fs.rmSync(file, { force: true });
        return;
      }
      fs.mkdirSync(dir, { recursive: true });
      const staged = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(staged, JSON.stringify({ app: appName, pid: process.pid, root, documents }));
      fs.renameSync(staged, file);
    },
    remove(appName, root) {
      fs.rmSync(fileFor(appName, root), { force: true });
    },
    others(root, appName) {
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
      } catch {
        return [];
      }
      const found = [];
      for (const name of names) {
        try {
          const entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
          if (entry.root !== root || entry.app === appName || !Number.isInteger(entry.pid) || !alive(entry.pid)) continue;
          found.push({ app: entry.app, documents: Array.isArray(entry.documents) ? entry.documents.filter((file) => typeof file === 'string') : [] });
        } catch {
          // Half-written or not one of ours.
        }
      }
      return found;
    },
  };
}

module.exports = {
  parseSubject,
  rewindToTrigger,
  graph,
  refs,
  recordSince,
  scoped,
  recordTip,
  touched,
  commitDetail,
  blob,
  compare,
  rewind,
  presence,
  relativeTo,
  pagePaths,
  removePath,
  LIMIT,
};
