// Autosave: a full, unpruned git record of every project an app has open
// (Knuth's docs/AUTOSAVE.md: a GPX track for research). The shell is the
// git runner for every app in the suite, since it has the filesystem and
// knows which document each window holds; a page only says when something
// happened (a cell ran). Knuth and Plass both run on this.
//
// A document's project is the git repository its folder is in; a folder
// in none gets one, quietly, once. The record is one branch per
// repository, refs/heads/claerbout-autosave, written with plumbing only:
// a temporary index (GIT_INDEX_FILE) filled by `git add -A` over the
// working tree, so .gitignore applies, then write-tree, commit-tree with
// the branch's tip as parent, and update-ref. The user's HEAD, branch,
// index and working tree are never touched, and nothing is committed
// while git itself is at work (index.lock) or a merge, rebase or
// cherry-pick is in progress. A commit lands only when the tree differs
// from the tip's.
//
// Triggers: a page's `autosave` notice ("cell run [4]"), a timer per open
// project, `session open` when the first window on a project opens and
// `session close` when the last closes; quitting flushes. Messages are
// "<app>: <trigger>". untracked/ (large data, caches, scratch) is ignored
// but kept inside the track by a manifest, .claerbout/untracked.json,
// rewritten before every commit with each file's size, mtime and SHA-256
// (rehashed only when size or mtime changed; the hashes are cached in
// the shell's state folder). Common secret files are kept out of the
// temporary index by pathspec.
//
// The record stays on this machine: nothing here pushes. The spec's
// outside witness (the branch pushed to a remote on a schedule) is open;
// see AUTOSAVE.md's "Built" section in Knuth.
//
// Config: "autosave": true turns it on. <PREFIX>_AUTOSAVE=0 turns it off
// for a test; <PREFIX>_AUTOSAVE_INTERVAL (seconds) shortens the timer.
'use strict';

const { execFile, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const BRANCH_NAME = 'claerbout-autosave';
const BRANCH = `refs/heads/${BRANCH_NAME}`;
/** Kept out of the temporary index by pathspec, in every folder. */
const SECRETS = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', '*.p12', 'credentials.json', '.npmrc', '.netrc'];
const IDENTITY = { name: 'Claerbout Autosave', email: 'autosave@claerbout.local' };
const UNTRACKED = 'untracked';
const MANIFEST = path.join('.claerbout', 'untracked.json');
const DEFAULT_INTERVAL_MS = 60 * 1000;
/** Files in .git that mean a merge, rebase, cherry-pick or revert is under way. */
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
/** What the user's environment may say about *where* a repository is;
 *  stripped from git's environment so a terminal launch inside another
 *  repository cannot redirect the record. */
const REDIRECTS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
];

// MARK: - Running git

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The git on this machine. An app opened from Finder gets a bare PATH,
 *  so the usual places are asked directly. On a Mac, /usr/bin/git is a
 *  stub that opens a dialog offering the developer tools when they are
 *  not installed; it is used only when they are. */
function findGit() {
  const candidates = [
    process.env.CLAERBOUT_GIT,
    ...(process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, 'git')),
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
    '/usr/bin/git',
  ];
  for (const candidate of candidates) {
    if (!candidate || !isExecutable(candidate)) continue;
    if (process.platform === 'darwin' && candidate === '/usr/bin/git' && !developerToolsInstalled()) continue;
    return candidate;
  }
  return null;
}

function developerToolsInstalled() {
  try {
    return execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim() !== '';
  } catch {
    return false;
  }
}

function gitEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!REDIRECTS.includes(key)) env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extra };
}

/** Run git to completion: {status, stdout, stderr}. A timeout kills it and
 *  reports -1, so a hung git never hangs the app. */
function git(binary, cwd, args, { env = {}, timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile(binary, args, { cwd, env: gitEnvironment(env), timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        status: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      });
    });
  });
}

const lastLine = (text) => text.trim().split('\n').filter(Boolean).pop() ?? '';

// MARK: - Repositories

/** The repository a folder is in: {root, gitDir}; null when it is in
 *  none; 'unusable' when it is inside a .git folder or a bare repository,
 *  where no record can be kept. */
async function repositoryOf(binary, dir) {
  const { status, stdout, stderr } = await git(binary, dir, [
    'rev-parse',
    '--is-inside-git-dir',
    '--is-bare-repository',
    '--show-toplevel',
    '--absolute-git-dir',
  ]);
  if (status !== 0) {
    if (/not a git repository/i.test(stderr)) return null;
    // Inside .git itself, --show-toplevel fails after the two booleans.
    if (/must be run in a work tree/i.test(stderr) || /^true/m.test(stdout)) return 'unusable';
    throw new Error(lastLine(stderr) || `git rev-parse failed (${status})`);
  }
  const [insideGitDir, bare, root, gitDir] = stdout.trim().split('\n');
  if (insideGitDir === 'true' || bare === 'true' || !root) return 'unusable';
  return { root, gitDir };
}

/** A repository at a folder that has none. Its HEAD is an unborn branch;
 *  the user's own first commit is what gives it one. */
async function initRepository(binary, dir) {
  const configured = await git(binary, dir, ['config', '--get', 'init.defaultBranch']);
  const args = ['init', '-q', ...(configured.stdout.trim() ? [] : ['--initial-branch=main']), '.'];
  const { status, stderr } = await git(binary, dir, args);
  if (status !== 0) throw new Error(lastLine(stderr) || `git init failed (${status})`);
  const found = await repositoryOf(binary, dir);
  if (!found || found === 'unusable') throw new Error(`no repository after git init at ${dir}`);
  return found;
}

// MARK: - The untracked/ manifest

async function sha256Of(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function filesUnder(folder) {
  const found = [];
  let entries;
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(full)));
    else if (entry.isFile()) found.push(full);
    // Symbolic links and anything else are not data of the project's.
  }
  return found;
}

/** .claerbout/untracked.json: every file under untracked/ with its size,
 *  mtime and SHA-256, so the data the record leaves out is still pinned
 *  by it. A file is hashed again only when its size or mtime changed;
 *  the hashes live in `cacheFile`, outside the project. */
async function writeManifest(root, cacheFile) {
  let cache = {};
  try {
    cache = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
  } catch {
    // No cache yet, or an unreadable one: every file is hashed.
  }
  const files = (await filesUnder(path.join(root, UNTRACKED))).sort();
  const fresh = {};
  const entries = [];
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    let info;
    try {
      info = await fsp.stat(file);
    } catch {
      continue;
    }
    const known = cache[relative];
    const sha256 =
      known && known.size === info.size && known.mtime === info.mtimeMs ? known.sha256 : await sha256Of(file);
    fresh[relative] = { size: info.size, mtime: info.mtimeMs, sha256 };
    entries.push({ path: relative, size: info.size, mtime: new Date(info.mtimeMs).toISOString(), sha256 });
  }
  const manifest = path.join(root, MANIFEST);
  const text = `${JSON.stringify({ files: entries }, null, 2)}\n`;
  let current = null;
  try {
    current = await fsp.readFile(manifest, 'utf8');
  } catch {
    // Not there yet.
  }
  if (current !== text) {
    await fsp.mkdir(path.dirname(manifest), { recursive: true });
    await fsp.writeFile(manifest, text);
  }
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  await fsp.writeFile(cacheFile, JSON.stringify(fresh));
  return entries;
}

// MARK: - One project

class Project {
  /**
   * @param {object} options
   * @param {string} options.binary git
   * @param {string} options.root the working tree
   * @param {string} options.gitDir its .git
   * @param {string} options.appName lower-case, the message's prefix
   * @param {string} options.stateDir this project's folder in the shell's state
   * @param {(line: string) => void} options.log
   */
  constructor({ binary, root, gitDir, appName, stateDir, log }) {
    this.binary = binary;
    this.root = root;
    this.gitDir = gitDir;
    this.appName = appName;
    this.stateDir = stateDir;
    this.log = log;
    this.windows = new Set();
    this.timer = null;
    this.prepared = false;
    /** One git job at a time per project. */
    this.queue = Promise.resolve();
  }

  git(args, options) {
    return git(this.binary, this.root, args, options);
  }

  /** Chain a job after the ones before it; its failure is logged, not thrown. */
  run(job) {
    const next = this.queue.then(job, job).catch((error) => {
      this.log(`autosave: ${error.message} (${this.root})`);
      return null;
    });
    this.queue = next.then(() => undefined);
    return next;
  }

  /** untracked/ exists and is ignored; .claerbout/ exists. Once per
   *  process; idempotent on disk. */
  async prepare() {
    if (this.prepared) return;
    await fsp.mkdir(path.join(this.root, UNTRACKED), { recursive: true });
    await fsp.mkdir(path.join(this.root, '.claerbout'), { recursive: true });
    const ignored = await this.git(['check-ignore', '-q', `${UNTRACKED}/`]);
    if (ignored.status === 1) {
      const file = path.join(this.root, '.gitignore');
      let text = '';
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch {
        // No .gitignore yet.
      }
      const lead = text === '' || text.endsWith('\n') ? '' : '\n';
      await fsp.appendFile(
        file,
        `${lead}# Claerbout: large data, caches and scratch, pinned by .claerbout/untracked.json\n${UNTRACKED}/\n`,
      );
      this.log(`autosave: ${UNTRACKED}/ added to .gitignore (${this.root})`);
    }
    this.prepared = true;
  }

  /** Why no commit can be made right now, or null. */
  async blocked() {
    if (fs.existsSync(path.join(this.gitDir, 'index.lock'))) return 'index.lock exists';
    for (const marker of IN_PROGRESS) {
      if (fs.existsSync(path.join(this.gitDir, marker))) {
        return `${marker.replace(/_HEAD$/, '').replace('-', ' ').toLowerCase()} in progress`;
      }
    }
    return null;
  }

  /** The repository's own identity when it has one, else the autosave's. */
  async identity() {
    const name = await this.git(['config', '--get', 'user.name']);
    const email = await this.git(['config', '--get', 'user.email']);
    if (name.status === 0 && email.status === 0 && name.stdout.trim() && email.stdout.trim()) return {};
    return {
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email,
    };
  }

  async tip() {
    const { status, stdout } = await this.git(['rev-parse', '--verify', '-q', BRANCH]);
    return status === 0 ? stdout.trim() : null;
  }

  /**
   * One autosave commit on the branch, if anything changed:
   * {committed: true, hash, message} or {skipped: why, message}. The
   * user's repository state is read, never written: the temporary index
   * is the only index touched, and the branch is the only ref.
   */
  async commit(trigger) {
    const message = `${this.appName}: ${cleanTrigger(trigger)}`;
    const reason = await this.blocked();
    if (reason) return { skipped: reason, message };
    await this.prepare();
    await writeManifest(this.root, path.join(this.stateDir, 'hashes.json'));
    await fsp.mkdir(this.stateDir, { recursive: true });
    const index = path.join(this.stateDir, 'index');
    await fsp.rm(index, { force: true });
    await fsp.rm(`${index}.lock`, { force: true });
    const env = { GIT_INDEX_FILE: index };
    try {
      const added = await this.git(
        ['add', '-A', '--ignore-errors', '--', '.', ...SECRETS.map((pattern) => `:(exclude,glob)**/${pattern}`)],
        { env },
      );
      if (added.status !== 0) throw new Error(`git add: ${lastLine(added.stderr) || added.status}`);
      const written = await this.git(['write-tree'], { env });
      if (written.status !== 0) throw new Error(`git write-tree: ${lastLine(written.stderr) || written.status}`);
      const tree = written.stdout.trim();
      // The tip may move under us: another app on the same project keeps
      // the same branch. Two tries at the compare-and-swap are plenty.
      for (let attempt = 0; attempt < 2; attempt++) {
        const parent = await this.tip();
        if (parent) {
          const parentTree = await this.git(['rev-parse', `${parent}^{tree}`]);
          if (parentTree.status === 0 && parentTree.stdout.trim() === tree) return { skipped: 'unchanged', message };
        }
        const made = await this.git(
          ['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message],
          { env: await this.identity() },
        );
        if (made.status !== 0) throw new Error(`git commit-tree: ${lastLine(made.stderr) || made.status}`);
        const hash = made.stdout.trim();
        const updated = await this.git([
          'update-ref',
          '-m',
          `autosave: ${message}`,
          BRANCH,
          hash,
          parent ?? '0'.repeat(tree.length),
        ]);
        if (updated.status === 0) return { committed: true, hash, message };
        if (attempt === 1) throw new Error(`git update-ref: ${lastLine(updated.stderr) || updated.status}`);
      }
      return { skipped: 'the branch moved twice', message };
    } finally {
      await fsp.rm(index, { force: true });
    }
  }

  /** A trigger's commit, in turn, logged when it lands. */
  autosave(trigger) {
    return this.run(async () => {
      const result = await this.commit(trigger);
      if (result.committed) this.log(`autosave: ${result.message} → ${result.hash.slice(0, 10)} (${this.root})`);
      return result;
    });
  }

  startTimer(interval) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.autosave('timer'), interval);
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** A page's trigger as one short line. */
function cleanTrigger(trigger) {
  const text = String(trigger ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 120);
  return text || 'notice';
}

// MARK: - The sessions

/**
 * Windows and the projects they are on. A window is an opaque key (the
 * BrowserWindow in the shell, anything in a test). The first window on a
 * project opens its session; the last closes it.
 */
class Autosave {
  /**
   * @param {object} options
   * @param {string} options.appName
   * @param {string} options.stateDir the shell's state folder
   * @param {(line: string) => void} options.log
   * @param {number} [options.interval] the timer, in ms
   * @param {string | null} [options.binary] git; found when omitted
   */
  constructor({ appName, stateDir, log, interval = DEFAULT_INTERVAL_MS, binary }) {
    this.appName = appName.toLowerCase();
    this.stateDir = path.join(stateDir, 'autosave');
    this.log = log;
    this.interval = interval;
    this.binary = binary === undefined ? findGit() : binary;
    /** root → Project */
    this.projects = new Map();
    /** window → root */
    this.windows = new Map();
    /** Folders already looked at: dir → root or null. */
    this.roots = new Map();
    /** Membership changes, one after another. */
    this.chain = Promise.resolve();
    this.quitting = false;
  }

  get enabled() {
    return this.binary !== null;
  }

  /** The project for a document's folder: its repository's root, made if
   *  there is none; null where no record can be kept (logged once). */
  async rootFor(dir) {
    if (this.roots.has(dir)) return this.roots.get(dir);
    let root = null;
    try {
      let found = await repositoryOf(this.binary, dir);
      if (found === null) {
        found = await initRepository(this.binary, dir);
        this.log(`autosave: initialised a repository at ${found.root}`);
      }
      if (found === 'unusable') this.log(`autosave: no record for ${dir}: inside a git directory or a bare repository`);
      else {
        root = found.root;
        if (!this.projects.has(root)) {
          const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
          this.projects.set(
            root,
            new Project({
              binary: this.binary,
              root,
              gitDir: found.gitDir,
              appName: this.appName,
              stateDir: path.join(this.stateDir, key),
              log: this.log,
            }),
          );
        }
      }
    } catch (error) {
      this.log(`autosave: no record for ${dir}: ${error.message}`);
    }
    this.roots.set(dir, root);
    return root;
  }

  project(window) {
    const root = this.windows.get(window);
    return root ? (this.projects.get(root) ?? null) : null;
  }

  /** The window holds this document now (null: none). */
  setDocument(window, file) {
    if (!this.enabled || this.quitting) return Promise.resolve();
    this.chain = this.chain.then(async () => {
      const root = typeof file === 'string' && path.isAbsolute(file) ? await this.rootFor(path.dirname(file)) : null;
      const before = this.windows.get(window) ?? null;
      if (before === root) return;
      if (before) this.leave(window, before);
      if (root) this.join(window, root);
    });
    return this.chain;
  }

  closed(window) {
    if (!this.enabled || this.quitting) return Promise.resolve();
    this.chain = this.chain.then(() => {
      const root = this.windows.get(window);
      if (root) this.leave(window, root);
    });
    return this.chain;
  }

  join(window, root) {
    const project = this.projects.get(root);
    this.windows.set(window, root);
    project.windows.add(window);
    if (project.windows.size === 1) {
      void project.autosave('session open');
      project.startTimer(this.interval);
    }
  }

  leave(window, root) {
    const project = this.projects.get(root);
    this.windows.delete(window);
    project.windows.delete(window);
    if (project.windows.size === 0) {
      project.stopTimer();
      void project.autosave('session close');
    }
  }

  /** A page's notice: {type: 'autosave', trigger}. */
  notice(window, trigger) {
    if (!this.enabled || this.quitting) return Promise.resolve(null);
    const project = this.project(window);
    if (!project) return Promise.resolve(null);
    return project.autosave(trigger);
  }

  /** Every open session closes and nothing starts after. Bounded, so a
   *  slow git cannot hold the app open. */
  async quit(limit = 20_000) {
    if (!this.enabled || this.quitting) return;
    this.quitting = true;
    await this.chain;
    const closing = [];
    for (const project of this.projects.values()) {
      project.stopTimer();
      if (project.windows.size === 0) continue;
      project.windows.clear();
      closing.push(project.autosave('session close'));
    }
    this.windows.clear();
    await Promise.race([Promise.allSettled(closing), new Promise((resolve) => setTimeout(resolve, limit))]);
  }
}

// MARK: - In the shell

/**
 * The shell's autosave, from its config: an Autosave when the config
 * says so and git is at hand, otherwise an object of the same shape that
 * does nothing. `env` is the shell's: <PREFIX>_AUTOSAVE=0 turns it off,
 * <PREFIX>_AUTOSAVE_INTERVAL (seconds) sets the timer.
 */
function attach({ config, env, log, stateDir }) {
  const nothing = {
    enabled: false,
    setDocument: () => Promise.resolve(),
    closed: () => Promise.resolve(),
    notice: () => Promise.resolve(null),
    quit: () => Promise.resolve(),
  };
  if (config.autosave !== true || env('AUTOSAVE') === '0') return nothing;
  const seconds = Number(env('AUTOSAVE_INTERVAL'));
  const interval = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_INTERVAL_MS;
  const autosave = new Autosave({ appName: config.name, stateDir, log, interval });
  if (!autosave.enabled) {
    log('autosave: off, no git on this machine');
    return nothing;
  }
  log(`autosave: on, ${BRANCH_NAME} every ${Math.round(interval / 1000)} s and on every trigger, git at ${autosave.binary}`);
  return autosave;
}

module.exports = {
  attach,
  Autosave,
  Project,
  findGit,
  repositoryOf,
  initRepository,
  writeManifest,
  BRANCH,
  BRANCH_NAME,
  SECRETS,
  IDENTITY,
  MANIFEST,
  UNTRACKED,
};
