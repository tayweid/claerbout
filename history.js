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
// ref. untracked/ and the record's manifest are never written or removed.
// A file that exists now but not in the target is removed only when the
// target is on the record and the record's tip (the one the page drew)
// holds it: nothing the record never held is removed, and a commit on a
// user branch writes only the files it holds.
//
// Every function takes the autosave Project for the window's project and
// runs git through it (its environment, its guards, its job queue), so
// all of this runs under node:test without Electron.
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { BRANCH_NAME, MANIFEST_PATH, UNTRACKED, errorLine } = require('./autosave.js');

const LIMIT = 2000;
const MOST = 5000;
/** How many changed paths a graph commit names. */
const CHANGED_KEPT = 20;
/** Record commits a tie looks through for a user commit. */
const TIE_CANDIDATES = 200;
/** A patch's lines per file, and its bytes in all. */
const PATCH_LINES = 400;
const PATCH_BYTES = 1024 * 1024;
/** A commit with more files than this has no patches (its first, say). */
const PATCH_FILES = 400;
const BLOB_BYTES = 1024 * 1024;
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

/** A path the rewind leaves alone: the record's manifest and untracked/. */
function recordOwn(file) {
  return file === MANIFEST_PATH || file === UNTRACKED || file.startsWith(`${UNTRACKED}/`);
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
 *  [{status, from, to, path}], `from` and `to` the two modes. */
async function rawDiff(project, a, b) {
  const left = a ?? (await emptyTree(project));
  const fields = nul(ok(await project.git(['diff-tree', '-r', '--no-renames', '--raw', '-z', left, b]), 'diff-tree'));
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [from, to, , , status] = fields[i].replace(/^:/, '').split(' ');
    entries.push({ status: status[0], from, to, path: fields[i + 1] });
  }
  return entries;
}

const GITLINK = '160000';

// MARK: - The graph

/** Commits from one `git log` with the graph's format and numstat, newest
 *  first, shaped as the graph's commits (without ties). */
async function logCommits(project, revisions, { limit, until } = {}) {
  const args = [
    'log',
    '--date-order',
    '--parents',
    '--source',
    '--numstat',
    '-z',
    '--no-renames',
    '--diff-merges=first-parent',
    `--format=${FORMAT}`,
    ...(limit ? ['-n', String(limit)] : []),
    ...(until ? [`--until=@${until}`] : []),
    ...revisions,
    '--',
  ];
  const text = ok(await project.git(args), 'log');
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
    };
    if (!record) commit.author = author;
    for (const entry of end === -1 ? [] : nul(chunk.slice(end + 1).replace(/^\n/, ''))) {
      const stat = entry.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
      if (!stat) continue;
      commit.files += 1;
      if (stat[1] !== '-') commit.plus += Number(stat[1]);
      if (stat[2] !== '-') commit.minus += Number(stat[2]);
      if (commit.changed.length < CHANGED_KEPT) commit.changed.push(stat[3]);
    }
    if (record) Object.assign(commit, parseSubject(subject));
    commits.push(commit);
  }
  return commits;
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
 * user commit with its author and its `tie`.
 */
async function graph(project, { before = null, limit = LIMIT, ties = new Map() } = {}) {
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
  return { tip, head, branches, commits, more, total };
}

/** The record's commits after `from` up to `to`, newest first, shaped as
 *  the graph's (for the `history {kind: 'commit'}` event). */
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
 * plus, minus, binary, link?, gitlink?, patch?}]}. A patch is capped at
 * 400 lines per file and 1 MB in all, and left out for a commit of more
 * than 400 files. diff-tree runs with no external diff and no textconv.
 */
async function commitDetail(project, sha) {
  const full = await resolveCommit(project, sha);
  const [, parents, time, subject, author] = ok(await project.git(['log', '-1', '--format=%H%x1f%P%x1f%aI%x1f%s%x1f%an', full, '--']), 'log')
    .replace(/\n$/, '')
    .split('\x1f');
  const parentList = parents ? parents.split(' ') : [];
  const left = parentList[0] ?? (await emptyTree(project));
  const raw = await rawDiff(project, left, full);
  const stats = nul(ok(await project.git(['diff-tree', '-r', '--no-renames', '--numstat', '-z', left, full]), 'diff-tree'));
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
    const patch = await project.git(['diff-tree', '-r', '--no-renames', '-p', '--no-color', '--no-ext-diff', '--no-textconv', left, full]);
    if (patch.status === 0) {
      // One chunk per file, in the same order as the raw list.
      const chunks = patch.stdout.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith('diff --git '));
      if (chunks.length === files.length) {
        let budget = PATCH_BYTES;
        chunks.forEach((chunk, i) => {
          const start = chunk.search(/^@@ /m);
          if (start === -1 || budget <= 0) return;
          const lines = chunk.slice(start).replace(/\n$/, '').split('\n');
          let text = lines.slice(0, PATCH_LINES).join('\n');
          if (text.length > budget) text = text.slice(0, budget);
          budget -= text.length;
          files[i].patch = text;
          if (lines.length > PATCH_LINES || text.length < lines.join('\n').length) files[i].cut = true;
        });
      }
    }
  }
  return { sha: full, parents: parentList, time, subject, author, files };
}

/** A file at a commit or a tree: {text} (UTF-8, at most 1 MB), {binary:
 *  true, size}, or {large: true, size} for text past 1 MB. */
async function blob(project, sha, file) {
  checkedSha(sha);
  if (typeof file !== 'string' || !file || file.includes('\0') || file.startsWith('/')) throw new Error('path must be a path inside the project');
  const name = `${sha}:${file}`;
  const kind = await project.git(['cat-file', '-t', name]);
  if (kind.status !== 0) return { missing: true };
  if (kind.stdout.trim() !== 'blob') return { missing: true, kind: kind.stdout.trim() };
  const size = Number(ok(await project.git(['cat-file', '-s', name]), 'cat-file').trim());
  const bytes = await project.git(['cat-file', 'blob', name], { encoding: 'buffer', ...(size > BLOB_BYTES ? { timeout: 30_000 } : {}) });
  if (bytes.status !== 0) throw new Error(`git cat-file: ${errorLine(bytes.stderr)}`);
  const data = bytes.stdout.subarray(0, Math.min(bytes.stdout.length, 8000));
  if (data.includes(0)) return { binary: true, size };
  if (size > BLOB_BYTES) return { large: true, size };
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

/** Whether the working tree has something at a path (a file the record
 *  never kept: ignored, or kept out as a secret), or a leading folder of
 *  it is not a folder; never following a link. */
function inTheWay(root, file) {
  const parts = file.split('/');
  for (let i = 1; i <= parts.length; i++) {
    let info;
    try {
      info = fs.lstatSync(path.join(root, ...parts.slice(0, i)));
    } catch {
      return false;
    }
    if (i === parts.length || !info.isDirectory()) return true;
  }
  return false;
}

/**
 * The rewind's set, by the rules: what writing `target`'s files over a
 * working tree whose tree is `base` would do. A, M and T paths are
 * written; a D path is removed only when the target is on the record and
 * the record's tip held it (`held`); the manifest and untracked/ are left
 * out; a gitlink is left alone, and an A path where the working tree
 * already has something is skipped (it can only be a file the record did
 * not keep). `paths`, when given, keeps the set to those. Answer: {write:
 * [{path, status}], remove: [path], skipped: [{path, why}], kept: [path]
 * (removals the rules forbid), full (the set's size before `paths`)}.
 */
async function rewindSet(project, { base, target, held, onRecord, paths = null }) {
  const write = [];
  const remove = [];
  const skipped = [];
  const kept = [];
  for (const entry of await rawDiff(project, base, target)) {
    if (recordOwn(entry.path)) continue;
    if (entry.from === GITLINK || entry.to === GITLINK) {
      skipped.push({ path: entry.path, why: 'a nested repository, left alone' });
      continue;
    }
    if (entry.status === 'D') {
      if (onRecord && held.has(entry.path)) remove.push(entry.path);
      else kept.push(entry.path);
      continue;
    }
    if (entry.status === 'A' && inTheWay(project.root, entry.path)) {
      skipped.push({ path: entry.path, why: 'something the record does not keep is there (an ignored file, or one kept out as a secret)' });
      continue;
    }
    write.push({ path: entry.path, status: entry.status });
  }
  const full = write.length + remove.length;
  if (Array.isArray(paths)) {
    const wanted = new Set(paths.filter((file) => typeof file === 'string'));
    return { write: write.filter((entry) => wanted.has(entry.path)), remove: remove.filter((file) => wanted.has(file)), skipped, kept, full };
  }
  return { write, remove, skipped, kept, full };
}

/** Whether a commit is the record's tip or behind it. */
async function onTheRecord(project, sha, tip) {
  if (!tip) return false;
  return (await project.git(['merge-base', '--is-ancestor', sha, tip])).status === 0;
}

/** Another app's documents on this project that a set writes or removes:
 *  {app, documents} for the first such app, or null. */
function heldElsewhere(project, others, set) {
  const touchedPaths = new Set([...set.write.map((entry) => entry.path), ...set.remove]);
  for (const other of others) {
    const documents = (other.documents ?? []).filter((file) => touchedPaths.has(relativeTo(project.root, file)));
    if (documents.length > 0) return { app: other.app, documents };
  }
  return null;
}

/** A document's path inside the project, '/'-separated, as the record's
 *  trees name it; null when it is outside. */
function relativeTo(root, file) {
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
  const relative = path.relative(root, real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/**
 * What a rewind to `sha` would do now, on the project's job queue like a
 * commit: {tip, now, target, onRecord, unrecorded, write, remove, skipped,
 * kept, same, untracked, untrackedGone, others, blocked}. `now` is the
 * tree of a fresh fill of the working tree (written, not committed), so
 * the page can read now's files from it; while a guard holds, nothing is
 * filled and `now` is the tip's tree. `others()` is another app's windows
 * on the project (the presence files): [{app, documents}].
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
      const set = await rewindSet(project, { base: now, target: targetTree, held: await pathsIn(project, tipTree), onRecord, paths });
      const unrecorded = blocked || !now ? [] : (await rawDiff(project, tipTree, now)).map((entry) => entry.path);
      const differing = new Set((await rawDiff(project, now, targetTree)).map((entry) => entry.path));
      const same = [...(await pathsIn(project, targetTree))].filter((file) => !recordOwn(file) && !differing.has(file)).length;
      const then = await manifestAt(project, targetTree);
      const current = await manifestAt(project, now);
      const untracked = then !== null && JSON.stringify([...then]) !== JSON.stringify([...(current ?? new Map())]);
      const untrackedGone = untracked ? [...then].filter(([file, hash]) => current?.get(file) !== hash).map(([file]) => file) : [];
      return {
        tip,
        now,
        target,
        onRecord,
        unrecorded,
        write: set.write,
        remove: set.remove,
        skipped: set.skipped,
        kept: set.kept,
        same,
        untracked,
        untrackedGone,
        others: others(),
        blocked: blocked ?? null,
      };
    } catch (error) {
      return { error: error.message };
    }
  });
}

/** Remove a file or link the rewind's set names (never what a link points
 *  to), then its folders while they are empty, never past the root. */
async function removePath(root, file) {
  const full = path.join(root, ...file.split('/'));
  let info;
  try {
    info = await fsp.lstat(full);
  } catch {
    return false;
  }
  if (info.isDirectory()) return false;
  await fsp.unlink(full);
  let dir = path.dirname(full);
  while (dir.startsWith(root + path.sep) && dir !== root) {
    try {
      await fsp.rmdir(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
  return true;
}

/** The target's files at `paths`, written into the working tree through a
 *  throwaway index (read-tree, then checkout-index on those paths only). */
async function writeFiles(project, target, paths) {
  if (paths.length === 0) return;
  await fsp.mkdir(project.stateDir, { recursive: true });
  const index = path.join(project.stateDir, `rewind-${process.pid}-${Date.now()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    ok(await project.git(['read-tree', target], { env }), 'read-tree');
    ok(await project.git(['checkout-index', '-f', '-z', '--stdin'], { env, input: `${paths.join('\0')}\0` }), 'checkout-index');
  } finally {
    await fsp.rm(index, { force: true });
    await fsp.rm(`${index}.lock`, { force: true });
  }
}

/**
 * The rewind, as one job on the project's queue (so the record's timer is
 * dropped while it runs): `{sha, tip, paths?, anyway?}`.
 *
 * Checks: the record's tip must still be `tip`, else {refused: 'moved',
 * tip}; no guard may hold, else {refused: 'paused', reason}; another
 * app's windows holding a file the rewind writes or removes refuse it,
 * {refused: 'other-app', app, documents}, unless `anyway`; nothing to
 * write or remove is {same: true}. Then `save()` asks this shell's
 * windows on the project to save (a window that answers that it could
 * not refuses: {refused: 'unsaved', path}), and the three steps:
 *
 * 1. Record now: "<app>: rewind from <tip>", through the record's own
 *    commit path, skipped when the working tree equals the tip.
 * 2. Write the target's files: the set again, against the tip after step
 *    1, removals first, then the writes through a throwaway index.
 * 3. Record the rewind: "<app>: rewind to <target>" (with its paths for a
 *    partial one), always, after the record prepares again (a target's
 *    .gitignore without /untracked/ gets the line back before the fill).
 *
 * `onStep(step, state, detail?)` hears 'save', 'record-from', 'write'
 * and 'record-to', each 'doing' then 'done'. Answer: {ok: true, from,
 * to, target, written, removed, skipped}, `from` null when step 1 was
 * skipped. A git failure in step 2 or 3 is {refused: 'failed', detail};
 * the next commit records whatever the folder then holds.
 */
function rewind(project, request, { save = async () => null, onStep = () => {}, others = () => [] } = {}) {
  return project.run(async () => {
    let step = 'check';
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
      if (!request.anyway) {
        const holder = heldElsewhere(project, others(), planned);
        if (holder) return { refused: 'other-app', ...holder };
      }
      if (planned.write.length + planned.remove.length === 0) return { same: true };

      step = 'save';
      onStep('save', 'doing');
      const unsaved = await save();
      if (unsaved) return { refused: 'unsaved', ...unsaved };
      onStep('save', 'done');

      step = 'record-from';
      onStep('record-from', 'doing');
      const recorded = await project.commit(`rewind from ${tip}`);
      if (!recorded.committed && recorded.skipped !== 'unchanged') return { refused: 'paused', reason: recorded.skipped };
      const from = recorded.committed ? recorded.hash : null;
      onStep('record-from', 'done', { from });

      step = 'write';
      onStep('write', 'doing');
      // Against the record as it now is: the working tree, just recorded.
      const base = await treeOf(project, (await project.tip()) ?? tip);
      const set = await rewindSet(project, { base, target: targetTree, held, onRecord, paths });
      const removed = [];
      for (const file of set.remove) if (await removePath(project.root, file)) removed.push(file);
      const written = [];
      const skipped = [...set.skipped];
      for (const entry of set.write) {
        // A removal above may have cleared the way; anything still there
        // that is not the record's own is left alone.
        if (entry.status === 'A' && inTheWay(project.root, entry.path)) skipped.push({ path: entry.path, why: 'something the record does not keep is there' });
        else written.push(entry.path);
      }
      await writeFiles(project, target, written);
      onStep('write', 'done', { written, removed });

      step = 'record-to';
      onStep('record-to', 'doing');
      // The record prepares again: the target's .gitignore may lack the
      // /untracked/ line, and the next fill would take untracked/ in.
      project.prepared = false;
      const partial = paths !== null && written.length + removed.length < set.full ? [...written, ...removed].sort() : null;
      const landed = await project.commit(rewindToTrigger(target, partial), { always: true });
      if (!landed.committed) return { refused: 'failed', detail: `the files were written, but the record did not commit: ${landed.skipped}`, written, removed };
      onStep('record-to', 'done', { to: landed.hash });
      return { ok: true, from, to: landed.hash, target, written, removed, skipped };
    } catch (error) {
      if (step === 'check' || step === 'save') return { refused: 'failed', detail: error.message };
      return { refused: 'failed', detail: `${step}: ${error.message}` };
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
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  };
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
  recordTip,
  touched,
  commitDetail,
  blob,
  compare,
  rewind,
  presence,
  relativeTo,
  LIMIT,
};
