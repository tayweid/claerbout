// Autosave: a full, unpruned git record of every project an app has open
// (Knuth's docs/AUTOSAVE.md: a GPX track for research). The shell is the
// git runner for every app in the suite, since it has the filesystem and
// knows which document each window holds; a page only says when something
// happened (a cell ran). Knuth and Plass both run on this.
//
// A document's project is the git repository its folder is in. A folder
// in none gets one, quietly, once, but only where a project can be: never
// the home folder, its standard folders (Desktop, Documents, Downloads,
// …), a cloud-synced root, a temporary folder or a volume root; a folder
// below one of those is fine. The record is one branch per working tree:
// refs/heads/claerbout-autosave for a repository's main working tree,
// refs/heads/claerbout-autosave-<name> for a linked worktree. It is
// written with plumbing only: a temporary index (GIT_INDEX_FILE, kept in
// the shell's state folder between commits for its stat cache) filled by
// `git add -A` over the working tree, so .gitignore applies, then
// write-tree, commit-tree with the branch's tip as parent, and update-ref.
// The user's HEAD, branch and index are never touched: nothing is
// committed while the record's branch is checked out in any worktree,
// while git itself is at work (index.lock), or while a merge, rebase,
// cherry-pick or revert is in progress. A commit lands only when the tree
// differs from the tip's. In the working tree the record does write
// untracked/, a line in .gitignore and .claerbout/untracked.json.
//
// Triggers: a page's `autosave` notice ("cell run [4]"), a timer per open
// project (a tick while a job runs is dropped), `session open` when the
// first window on a project opens and `session close` when the last
// closes; quitting flushes, bounded. Messages are "<app>: <trigger>".
// untracked/ (large data, caches, scratch) is ignored but kept inside the
// track by a manifest, .claerbout/untracked.json, rewritten before every
// commit with each file's size, mtime and SHA-256 (rehashed only when size
// or mtime changed; the hashes are cached in the shell's state folder),
// and always recorded, whatever the ignore rules say. Common secret files
// are kept out by pathspec.
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
const os = require('node:os');
const path = require('node:path');

const BRANCH_NAME = 'claerbout-autosave';
const BRANCH = `refs/heads/${BRANCH_NAME}`;
/** Kept out of the record by pathspec, in every folder: files by name… */
const SECRET_FILES = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  'id_dsa*',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.gpg',
  '*.asc',
  'credentials.json',
  'service-account*.json',
  '.git-credentials',
  '.pypirc',
  '.npmrc',
  '.netrc',
  'token*',
  '*.token',
];
/** …and everything under a folder of one of these names. */
const SECRET_FOLDERS = ['.env', '.aws', '.ssh', '.gnupg'];
const SECRETS = [...SECRET_FILES, ...SECRET_FOLDERS.map((name) => `${name}/`)];
const IDENTITY = { name: 'Claerbout Autosave', email: 'autosave@claerbout.local' };
const UNTRACKED = 'untracked';
const MANIFEST = path.join('.claerbout', 'untracked.json');
const MANIFEST_PATH = MANIFEST.split(path.sep).join('/');
const DEFAULT_INTERVAL_MS = 60 * 1000;
/** Files in .git that mean a merge, rebase, cherry-pick or revert is under way. */
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
/** Set on every git the record runs, so nothing it does writes into the
 *  user's .git beyond objects and its own branch: a split index would put
 *  a sharedindex file there for each temporary index, an fsmonitor would
 *  start a daemon, and the advice is noise in the log. */
const QUIET = [
  '-c', 'core.splitIndex=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'advice.addIgnoredFile=false',
  '-c', 'advice.addEmbeddedRepo=false',
  '-c', 'commit.gpgsign=false',
];
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

/** git's environment: the user's, without the redirects, never prompting,
 *  taking no optional locks, and in the C locale so its messages are the
 *  ones this module reads. */
function gitEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!REDIRECTS.includes(key)) env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...extra };
}

/** Run git to completion: {status, stdout, stderr}. A timeout kills it and
 *  reports -1, so a hung git never hangs the app. `input` goes to its
 *  standard input, which is closed either way. */
function git(binary, cwd, args, { env = {}, timeout = 120_000, input = '' } = {}) {
  return new Promise((resolve) => {
    const child = execFile(binary, args, { cwd, env: gitEnvironment(env), timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        status: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/** The line of git's stderr that says what went wrong: the last that is
 *  not a hint or a warning (git ends many errors with advice). */
function errorLine(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return [...lines].reverse().find((line) => !/^(hint|warning):/i.test(line)) ?? lines.at(-1) ?? '';
}

const nulList = (text) => text.split('\0').filter(Boolean);

function realpath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** A few names for the log: the first ten, and how many more. */
function someOf(names) {
  return names.length <= 10 ? names.join(', ') : `${names.slice(0, 10).join(', ')} and ${names.length - 10} more`;
}

// MARK: - Repositories

/** The repository a folder is in: {root, gitDir, linked}; null when it is
 *  in none; 'unusable' when it is inside a .git folder or a bare
 *  repository, where no record can be kept. `linked` is a linked worktree
 *  (`git worktree add`), whose git dir is not the repository's common one. */
async function repositoryOf(binary, dir) {
  const { status, stdout, stderr } = await git(binary, dir, [
    'rev-parse',
    '--is-inside-git-dir',
    '--is-bare-repository',
    '--show-toplevel',
    '--absolute-git-dir',
    '--git-common-dir',
  ]);
  if (status !== 0) {
    if (/not a git repository/i.test(stderr)) return null;
    // Inside .git itself, --show-toplevel fails after the two booleans.
    if (/must be run in a work tree/i.test(stderr) || /^true/m.test(stdout)) return 'unusable';
    throw new Error(errorLine(stderr) || `git rev-parse failed (${status})`);
  }
  const [insideGitDir, bare, root, gitDir, commonDir] = stdout.trim().split('\n');
  if (insideGitDir === 'true' || bare === 'true' || !root) return 'unusable';
  const linked = Boolean(commonDir) && realpath(path.resolve(dir, commonDir)) !== realpath(gitDir);
  return { root, gitDir, linked };
}

/** A repository at a folder that has none. Its HEAD is an unborn branch;
 *  the user's own first commit is what gives it one. */
async function initRepository(binary, dir) {
  const configured = await git(binary, dir, ['config', '--get', 'init.defaultBranch']);
  const args = ['init', '-q', ...(configured.stdout.trim() ? [] : ['--initial-branch=main']), '.'];
  const { status, stderr } = await git(binary, dir, args);
  if (status !== 0) throw new Error(errorLine(stderr) || `git init failed (${status})`);
  const found = await repositoryOf(binary, dir);
  if (!found || found === 'unusable') throw new Error(`no repository after git init at ${dir}`);
  return found;
}

/** The record's branch for a working tree: claerbout-autosave for the
 *  main one; for a linked worktree, claerbout-autosave-<name>, the name
 *  git gave the worktree in .git/worktrees (its folder's name, made
 *  unique by git), so two worktrees open at once never write over each
 *  other's tip. A hyphen, not a slash: git cannot keep
 *  refs/heads/claerbout-autosave/x beside refs/heads/claerbout-autosave. */
function branchFor({ gitDir, linked }) {
  if (!linked) return BRANCH_NAME;
  const name = path
    .basename(gitDir)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .replace(/\.lock$/i, '-lock')
    .replace(/[.]+$/, '');
  return `${BRANCH_NAME}-${name || createHash('sha256').update(gitDir).digest('hex').slice(0, 8)}`;
}

// MARK: - Where a repository may be started

/** The home folder's own folders: a document saved straight into one is
 *  never given a repository there (the record would take in everything
 *  beside it, every minute). A folder inside one is a project's. */
const STANDARD_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Public', 'Library'];
/** Cloud-synced roots, relative to the home folder: the root holds
 *  everything synced, and a .git written every minute where a sync
 *  client watches is how repositories get corrupted. */
const CLOUD_ROOTS = [
  /^Library\/Mobile Documents(\/[^/]+)?$/, // iCloud Drive (com~apple~CloudDocs) and the apps' containers
  /^Library\/CloudStorage(\/[^/]+)?$/, // Dropbox, Google Drive, OneDrive, Box under File Provider
  /^Library\/CloudStorage\/[^/]+\/(My Drive|Shared drives|Other computers)$/,
  /^(Dropbox|Box|Google Drive|iCloud Drive|Creative Cloud Files)( \([^/]*\))?$/,
  /^OneDrive([ -][^/]*)?$/,
];
const TEMPORARY_FOLDERS = () => [os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'];

/**
 * Why a folder in no repository is no place to start one, or null when it
 * is a project's folder: the home folder or a folder it is in, one of its
 * standard folders, a cloud-synced root, a temporary folder, or a volume
 * root. A folder at least one level below any of those qualifies
 * (~/Projects/foo, ~/Desktop/week-3). Paths are compared as given and
 * with symbolic links resolved (/tmp is /private/tmp on a Mac).
 */
function notProjectFolder(dir, { home = os.homedir(), temporary = TEMPORARY_FOLDERS() } = {}) {
  const forms = (file) => new Set([path.resolve(file), realpath(file)]);
  const here = forms(dir);
  const is = (file) => [...forms(file)].some((form) => here.has(form));
  for (const form of here) {
    if (path.parse(form).root === form || /^\/Volumes\/[^/]+$/.test(form)) return 'a volume root';
  }
  if (is(home)) return 'the home folder';
  for (const homeForm of forms(home)) {
    for (const form of here) if (homeForm.startsWith(form + path.sep)) return 'a folder the home folder is in';
  }
  for (const name of STANDARD_FOLDERS) if (is(path.join(home, name))) return `the ${name} folder itself`;
  for (const folder of temporary) if (is(folder)) return 'a temporary folder';
  for (const homeForm of forms(home)) {
    for (const form of here) {
      const relative = path.relative(homeForm, form).split(path.sep).join('/');
      if (!relative.startsWith('..') && CLOUD_ROOTS.some((pattern) => pattern.test(relative))) return 'a cloud-synced root';
    }
  }
  return null;
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
 *  the hashes live in `cacheFile`, outside the project. A file that
 *  cannot be read is left out and named to `unreadable`. */
async function writeManifest(root, cacheFile, unreadable = () => {}) {
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
    let sha256;
    try {
      info = await fsp.stat(file);
      const known = cache[relative];
      sha256 = known && known.size === info.size && known.mtime === info.mtimeMs ? known.sha256 : await sha256Of(file);
    } catch (error) {
      if (error.code !== 'ENOENT') unreadable(relative);
      continue;
    }
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

/** Pathspecs for the secrets: `exclude,` for git add, '' to match them. */
function secretPathspecs(magic) {
  return [
    ...SECRET_FILES.map((pattern) => `:(${magic}glob)**/${pattern}`),
    ...SECRET_FOLDERS.map((name) => `:(${magic}glob)**/${name}/**`),
  ];
}

class Project {
  /**
   * @param {object} options
   * @param {string} options.binary git
   * @param {string} options.root the working tree
   * @param {string} options.gitDir its git dir (a linked worktree's own)
   * @param {string} [options.branch] the record's branch name (branchFor)
   * @param {string} options.appName lower-case, the message's prefix
   * @param {string} options.stateDir this project's folder in the shell's state
   * @param {(line: string) => void} options.log
   */
  constructor({ binary, root, gitDir, branch = BRANCH_NAME, appName, stateDir, log }) {
    this.binary = binary;
    this.root = root;
    this.gitDir = gitDir;
    this.branchName = branch;
    this.ref = `refs/heads/${branch}`;
    this.appName = appName;
    this.stateDir = stateDir;
    /** The temporary index, kept between commits for its stat cache. */
    this.index = path.join(stateDir, 'index');
    this.log = log;
    this.windows = new Set();
    this.timer = null;
    this.prepared = false;
    /** untracked/ and .claerbout/ are folders: the manifest is kept. */
    this.manifest = true;
    /** One git job at a time per project, and how many are queued. */
    this.queue = Promise.resolve();
    this.pending = 0;
    /** Lines said once per launch. */
    this.said = new Set();
    /** Why the last commit was skipped, so it is said once. */
    this.blockedBy = null;
    /** Nested repositories without a commit, left out of the record. */
    this.excluded = new Set();
    this.secretsShown = false;
  }

  git(args, options) {
    return git(this.binary, this.root, [...QUIET, ...args], options);
  }

  once(key, line) {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.log(line);
  }

  /** Chain a job after the ones before it; its failure is logged, not thrown. */
  run(job) {
    this.pending += 1;
    const next = this.queue
      .then(job, job)
      .catch((error) => {
        this.log(`autosave: ${error.message} (${this.root})`);
        return null;
      })
      .finally(() => {
        this.pending -= 1;
      });
    this.queue = next.then(() => undefined);
    return next;
  }

  /** A folder of the record's in the working tree; false (said once) when
   *  something that is not a folder has its name. */
  async folder(name) {
    const full = path.join(this.root, name);
    try {
      await fsp.mkdir(full);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        try {
          if ((await fsp.stat(full)).isDirectory()) return true;
        } catch {
          // A dangling link: not a folder.
        }
      }
      this.once(`folder ${name}`, `autosave: ${name} exists and is not a folder, so untracked/ is not kept and has no manifest (${this.root})`);
      return false;
    }
  }

  /** untracked/ exists and is ignored; .claerbout/ exists. Once per
   *  process; idempotent on disk. Neither when a file has either name. */
  async prepare() {
    if (this.prepared) return;
    this.manifest = (await this.folder(UNTRACKED)) && (await this.folder('.claerbout'));
    if (this.manifest) {
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
    // The branch checked out in any working tree of the repository: an
    // update-ref would move that worktree's HEAD under the user.
    const listed = await this.git(['worktree', 'list', '--porcelain']);
    const checkedOut =
      listed.status === 0
        ? listed.stdout.split('\n').includes(`branch ${this.ref}`)
        : (await this.git(['symbolic-ref', '-q', 'HEAD'])).stdout.trim() === this.ref;
    if (checkedOut) return `${this.branchName} is checked out`;
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
    const { status, stdout } = await this.git(['rev-parse', '--verify', '-q', this.ref]);
    return status === 0 ? stdout.trim() : null;
  }

  /** A nested repository left out for having no commit comes back once it
   *  has one (as a gitlink) or is gone. */
  async recheckExcluded() {
    for (const entry of [...this.excluded]) {
      const inner = path.join(this.root, entry);
      if (!fs.existsSync(inner)) {
        this.excluded.delete(entry);
        continue;
      }
      const head = await git(this.binary, inner, ['rev-parse', '--verify', '-q', 'HEAD']);
      if (head.status === 0) this.excluded.delete(entry);
    }
  }

  /**
   * The temporary index made to match the working tree; its tree. `git add
   * -A --ignore-errors` skips what it cannot read (exit 1; each file said
   * once) and a nested repository without a commit (left out from then
   * on); entries the ignore rules or the secrets now match leave the kept
   * index (git add never drops a path the index already has); and the
   * manifest and .gitignore go in whatever the ignore rules say.
   */
  async fill(env) {
    await this.recheckExcluded();
    const add = () =>
      this.git(
        [
          'add',
          '-A',
          '--ignore-errors',
          '--',
          '.',
          ...secretPathspecs('exclude,'),
          ...[...this.excluded].map((entry) => `:(exclude,literal)${entry}`),
        ],
        { env },
      );
    let added = await add();
    const unborn = [...added.stderr.matchAll(/'(.+?)\/?' does not have a commit checked out/g)]
      .map((match) => match[1])
      .filter((entry) => !this.excluded.has(entry));
    for (const entry of unborn) {
      this.excluded.add(entry);
      this.once(`unborn ${entry}`, `autosave: ${entry}/ is a repository without a commit, left out of the record (${this.root})`);
    }
    // An older git gives up (128) on a nested repository without a commit
    // even with --ignore-errors: again, with it excluded.
    if (added.status !== 0 && added.status !== 1 && unborn.length > 0) added = await add();
    if (added.status === 1) {
      const unreadable = [...added.stderr.matchAll(/unable to index file '(.+?)'/g)]
        .map((match) => match[1])
        .filter((file) => !this.said.has(`unreadable ${file}`));
      for (const file of unreadable) this.said.add(`unreadable ${file}`);
      if (unreadable.length > 0) this.log(`autosave: left out of the record, unreadable: ${someOf(unreadable)} (${this.root})`);
      const other = added.stderr
        .split('\n')
        .filter((line) => /^(error|fatal):/.test(line) && !/unable to index file|open\(|does not have a commit checked out/.test(line));
      if (other.length > 0) this.once(`add ${other.at(-1)}`, `autosave: git add skipped something: ${other.at(-1)} (${this.root})`);
    } else if (added.status !== 0) {
      throw new Error(`git add: ${errorLine(added.stderr) || added.status}`);
    }
    // What the kept index has that the record must not: ignored now, a
    // secret, or inside a nested repository left out.
    const ignored = await this.git(['ls-files', '-z', '-c', '-i', '--exclude-standard'], { env });
    if (ignored.status !== 0) throw new Error(`git ls-files: ${errorLine(ignored.stderr) || ignored.status}`);
    const matched = await this.git(
      ['ls-files', '-z', '-c', '--', ...secretPathspecs(''), ...[...this.excluded].map((entry) => `:(literal)${entry}`)],
      { env },
    );
    if (matched.status !== 0) throw new Error(`git ls-files: ${errorLine(matched.stderr) || matched.status}`);
    const drop = [...new Set([...nulList(ignored.stdout), ...nulList(matched.stdout)])];
    if (drop.length > 0) {
      const removed = await this.git(['update-index', '-z', '--force-remove', '--stdin'], { env, input: `${drop.join('\0')}\0` });
      if (removed.status !== 0) throw new Error(`git update-index: ${errorLine(removed.stderr) || removed.status}`);
    }
    // The manifest is what keeps untracked/ inside the track, and the
    // .gitignore says what the record leaves out: both always go in.
    const forced = [...(this.manifest ? [MANIFEST_PATH] : []), '.gitignore'].filter((file) => fs.existsSync(path.join(this.root, file)));
    if (forced.length > 0) {
      const forcedAdd = await this.git(['add', '-f', '--', ...forced.map((file) => `:(literal)${file}`)], { env });
      if (forcedAdd.status !== 0) throw new Error(`git add -f: ${errorLine(forcedAdd.stderr) || forcedAdd.status}`);
    }
    if (!this.secretsShown) {
      // Once per launch: what the secrets list keeps out of this project,
      // so a name it catches by mistake (tokenizer.py) is seen.
      this.secretsShown = true;
      const kept = await this.git(['ls-files', '-z', '-o', '--exclude-standard', '--', ...secretPathspecs('')], { env });
      const names = nulList(kept.stdout);
      if (kept.status === 0 && names.length > 0) this.log(`autosave: kept out of the record as possible secrets: ${someOf(names)} (${this.root})`);
    }
    const written = await this.git(['write-tree'], { env });
    if (written.status !== 0) throw new Error(`git write-tree: ${errorLine(written.stderr) || written.status}`);
    return written.stdout.trim();
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
    if (reason !== this.blockedBy) {
      if (reason) this.log(`autosave: not recorded while ${reason} (${this.root})`);
      this.blockedBy = reason;
    }
    if (reason) return { skipped: reason, message };
    await this.prepare();
    if (this.manifest) {
      await writeManifest(this.root, path.join(this.stateDir, 'hashes.json'), (file) =>
        this.once(`unhashed ${file}`, `autosave: ${file} cannot be read, so the manifest leaves it out (${this.root})`),
      );
    }
    await fsp.mkdir(this.stateDir, { recursive: true });
    // The index is kept between commits (git add -A against it uses its
    // stat cache); a lock left by a git that was killed goes.
    await fsp.rm(`${this.index}.lock`, { force: true });
    const env = { GIT_INDEX_FILE: this.index };
    try {
      const tree = await this.fill(env);
      // The tip may move under us: another app on the same working tree
      // keeps the same branch. Two tries at the compare-and-swap are plenty.
      for (let attempt = 0; attempt < 2; attempt++) {
        const parent = await this.tip();
        if (parent) {
          const parentTree = await this.git(['rev-parse', `${parent}^{tree}`]);
          if (parentTree.status === 0 && parentTree.stdout.trim() === tree) return { skipped: 'unchanged', message };
        }
        const made = await this.git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], {
          env: await this.identity(),
        });
        if (made.status !== 0) throw new Error(`git commit-tree: ${errorLine(made.stderr) || made.status}`);
        const hash = made.stdout.trim();
        const updated = await this.git([
          'update-ref',
          '-m',
          `autosave: ${message}`,
          this.ref,
          hash,
          parent ?? '0'.repeat(tree.length),
        ]);
        if (updated.status === 0) return { committed: true, hash, message };
        if (attempt === 1) throw new Error(`git update-ref: ${errorLine(updated.stderr) || updated.status}`);
      }
      return { skipped: 'the branch moved twice', message };
    } catch (error) {
      // An index git could not use is rebuilt at the next commit.
      await fsp.rm(this.index, { force: true });
      throw error;
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

  /** The timer's commit, dropped while another job runs or waits, so a
   *  commit slower than the interval never piles up behind itself. */
  tick() {
    if (this.pending > 0) return null;
    return this.autosave('timer');
  }

  startTimer(interval) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), interval);
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
   * @param {string} [options.home] the home folder, for where a repository may be started
   * @param {string[]} [options.temporary] the temporary folders, likewise
   */
  constructor({ appName, stateDir, log, interval = DEFAULT_INTERVAL_MS, binary, home, temporary }) {
    this.appName = appName.toLowerCase();
    this.stateDir = path.join(stateDir, 'autosave');
    this.log = log;
    this.interval = interval;
    this.binary = binary === undefined ? findGit() : binary;
    this.places = { home: home ?? os.homedir(), temporary: temporary ?? TEMPORARY_FOLDERS() };
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

  /** The project for a document's folder: the repository it is in, or one
   *  made there when it is in none and is a project's folder; null where
   *  no record is kept (said once per folder). */
  async rootFor(dir) {
    if (this.roots.has(dir)) return this.roots.get(dir);
    let root = null;
    try {
      let found = await repositoryOf(this.binary, dir);
      if (found === null) {
        const refused = notProjectFolder(dir, this.places);
        if (refused) {
          this.log(`autosave: no record for ${dir}: ${refused} is not a project's folder; a document here needs a folder of its own`);
          found = 'refused';
        } else {
          found = await initRepository(this.binary, dir);
          this.log(`autosave: initialised a repository at ${found.root}`);
        }
      }
      if (found === 'unusable') this.log(`autosave: no record for ${dir}: inside a git directory or a bare repository`);
      else if (found !== 'refused') {
        root = found.root;
        if (!this.projects.has(root)) {
          const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
          this.projects.set(
            root,
            new Project({
              binary: this.binary,
              root,
              gitDir: found.gitDir,
              branch: branchFor(found),
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

  /** Every open session closes, every job already queued (a session close
   *  from a window just shut, a commit under way) finishes, and nothing
   *  starts after. Bounded, so a slow git cannot hold the app open. The
   *  kept indexes go once everything is done. */
  async quit(limit = 20_000) {
    if (!this.enabled || this.quitting) return;
    this.quitting = true;
    const flush = async () => {
      await this.chain;
      for (const project of this.projects.values()) {
        project.stopTimer();
        if (project.windows.size === 0) continue;
        project.windows.clear();
        void project.autosave('session close');
      }
      this.windows.clear();
      await Promise.allSettled([...this.projects.values()].map((project) => project.queue));
      return true;
    };
    let timer;
    const done = await Promise.race([flush(), new Promise((resolve) => (timer = setTimeout(() => resolve(false), limit)))]);
    clearTimeout(timer);
    if (!done) {
      this.log(`autosave: quit before the record was done (${Math.round(limit / 1000)} s)`);
      return;
    }
    for (const project of this.projects.values()) {
      await fsp.rm(project.index, { force: true });
      await fsp.rm(`${project.index}.lock`, { force: true });
    }
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
  branchFor,
  notProjectFolder,
  writeManifest,
  errorLine,
  BRANCH,
  BRANCH_NAME,
  SECRETS,
  SECRET_FILES,
  SECRET_FOLDERS,
  IDENTITY,
  MANIFEST,
  UNTRACKED,
};
