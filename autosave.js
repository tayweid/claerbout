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
// below one of those is fine. No record at all, repository or not, for a
// document in a hidden folder of the home folder (~/.ssh, ~/.aws,
// ~/.config/gh: where credentials live) or in a folder named like a
// secret one (.ssh, .aws, .gnupg, .env), nor for a repository whose root
// is the home folder or a folder it is in (a dotfiles ~/.git would take
// in everything under home). The record is one branch per working tree:
// refs/heads/claerbout-autosave for a repository's main working tree,
// refs/heads/claerbout-autosave-<name> for a linked worktree. It is
// written with plumbing only: a temporary index (GIT_INDEX_FILE, kept in
// the shell's state folder between commits for its stat cache) filled by
// `git add -A` over the working tree, so .gitignore applies, then
// write-tree, commit-tree with the branch's tip as parent, and update-ref
// --no-deref. The user's HEAD, branch and index are never touched:
// nothing is committed while the record's branch is checked out in any
// worktree or being rebased in one, while it is a symbolic ref, while git
// itself is at work (index.lock), or while a merge, rebase, cherry-pick or
// revert is in progress; all of that is checked again just before the ref
// moves, so only a few milliseconds of race remain. A commit lands only
// when the tree differs from the tip's. In the working tree the record
// does write untracked/, a line in .gitignore and
// .claerbout/untracked.json, never through a symbolic link: a link (or
// anything else that is not a folder or a file) at any of those names
// turns the manifest off for that project, said once.
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
// are kept out by pathspec, whatever their case, and a file in untracked/
// that the list matches is left out of the manifest, name and hash.
//
// git runs with the sparse-checkout rules off (the record is the working
// tree; git add refuses paths outside the cone otherwise), with no lazy
// fetch for a partial clone, and with a PATH that has Homebrew's and the
// system's folders after the app's own, so a clean filter (git-lfs) is
// found from a Finder launch. A required filter that is still missing
// skips the commit, said once; any other failure is said once until a
// commit lands again, never every tick.
//
// The record stays on this machine: nothing here pushes. The spec's
// outside witness (the branch pushed to a remote on a schedule) is open;
// see AUTOSAVE.md's "Built" section in Knuth.
//
// Config: "autosave": true turns it on. <PREFIX>_AUTOSAVE=0 turns it off
// for a test; <PREFIX>_AUTOSAVE_INTERVAL (seconds) shortens the timer.
'use strict';

const { execFile, execFileSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const BRANCH_NAME = 'claerbout-autosave';
const BRANCH = `refs/heads/${BRANCH_NAME}`;
/** Kept out of the record by pathspec, in every folder and whatever the
 *  case (a key exported on Windows is Server.PEM): files by name… */
const SECRET_FILES = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_*',
  '*.p8',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.keychain',
  '*.keychain-db',
  '*.gpg',
  '*.asc',
  '*.ppk',
  '*.kdbx',
  'credentials.json',
  'service-account*.json',
  'client_secret*.json',
  'kaggle.json',
  'secrets.toml',
  '.git-credentials',
  '.pypirc',
  '.npmrc',
  '.netrc',
  '.htpasswd',
  '.Renviron',
  'token',
  'token.txt',
  '*.token',
  '.token*',
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
 *  start a daemon, and the advice is noise in the log. The sparse-checkout
 *  rules are off because the record is the working tree: with them, git
 *  add refuses the manifest and any new file outside the cone. */
const QUIET = [
  '-c', 'core.splitIndex=false',
  '-c', 'core.sparseCheckout=false',
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

/** The folders a login shell's PATH starts from on a Mac (path_helper
 *  reads /etc/paths and /etc/paths.d); read once. */
let systemPaths = null;
function readSystemPaths() {
  if (systemPaths) return systemPaths;
  systemPaths = [];
  const lines = (file) => {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    } catch {
      return [];
    }
  };
  systemPaths.push(...lines('/etc/paths'));
  try {
    for (const name of fs.readdirSync('/etc/paths.d').sort()) systemPaths.push(...lines(path.join('/etc/paths.d', name)));
  } catch {
    // No /etc/paths.d: not a Mac.
  }
  return systemPaths;
}

/** The PATH git runs with: the app's own first, then Homebrew's, the
 *  system's defaults and the standard folders. An app opened from Finder
 *  has launchd's bare /usr/bin:/bin:/usr/sbin:/sbin, where git-lfs and
 *  git-crypt (clean and smudge filters), and credential helpers, are not. */
function searchPath() {
  const own = (process.env.PATH ?? '').split(path.delimiter);
  if (process.platform === 'win32') return own.filter(Boolean).join(path.delimiter);
  const more = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    ...readSystemPaths(),
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return [...new Set([...own, ...more].filter(Boolean))].join(path.delimiter);
}

/** git's environment: the user's, without the redirects, never prompting,
 *  taking no optional locks, never fetching a partial clone's missing
 *  objects, with the PATH above, and in the C locale so its messages are
 *  the ones this module reads. */
function gitEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!REDIRECTS.includes(key)) env[key] = value;
  }
  return {
    ...env,
    PATH: searchPath(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    LC_ALL: 'C',
    ...extra,
  };
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

/** Lines git ends with that are not the cause: advice, and the wrap-up a
 *  filter process that never started leaves (`the remote end hung up`). */
const NOT_THE_CAUSE = [/^(hint|warning):/i, /^fatal: the remote end hung up unexpectedly$/i, /^fatal: early EOF$/i];

/** The line of git's stderr that says what went wrong: the last that is
 *  not a hint, a warning or a wrap-up line (git ends many errors with
 *  advice, and a missing filter with `the remote end hung up`). */
function errorLine(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const reversed = [...lines].reverse();
  return (
    reversed.find((line) => !NOT_THE_CAUSE.some((pattern) => pattern.test(line))) ??
    reversed.find((line) => !NOT_THE_CAUSE[0].test(line)) ??
    lines.at(-1) ??
    ''
  );
}

/** Why git add stopped on a clean filter (git-lfs, git-crypt) it could
 *  not run, or null: the shell's `<command>: command not found` (`not
 *  found` from dash), or git's own line. */
function filterFailure(stderr) {
  const text = String(stderr ?? '');
  const missing = text.match(/^.*: (?:command )?not found\s*$/m);
  const failed = text.match(/^(?:fatal|error): .*(?:clean filter '[^']*' failed|external filter '[^']*' failed).*$/m);
  if (!missing && !failed) return null;
  return (missing ?? failed)[0].trim();
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

/** The repository a folder is in: {root, gitDir, commonDir, linked}; null
 *  when it is in none; 'unusable' when it is inside a .git folder or a
 *  bare repository, where no record can be kept. `linked` is a linked
 *  worktree (`git worktree add`), whose git dir is not the repository's
 *  common one (`commonDir`, where every worktree's own folder is kept). */
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
  const common = commonDir ? realpath(path.resolve(dir, commonDir)) : realpath(gitDir);
  const linked = common !== realpath(gitDir);
  return { root, gitDir, commonDir: common, linked };
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

/** A folder's two forms: as given and with symbolic links resolved (/tmp
 *  is /private/tmp on a Mac). */
const forms = (file) => new Set([path.resolve(file), realpath(file)]);

/** 'the home folder', 'a folder the home folder is in', or null. */
function aboveHome(dir, home) {
  const here = forms(dir);
  if ([...forms(home)].some((form) => here.has(form))) return 'the home folder';
  for (const homeForm of forms(home)) {
    for (const form of here) if (homeForm.startsWith(form.endsWith(path.sep) ? form : form + path.sep)) return 'a folder the home folder is in';
  }
  return null;
}

/** Whether a folder is a hidden folder of the home folder or inside one:
 *  ~/.ssh, ~/.aws, ~/.config/gh. */
function inHiddenHomeFolder(dir, home) {
  for (const homeForm of forms(home)) {
    for (const form of forms(dir)) {
      const relative = path.relative(homeForm, form);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && relative.split(path.sep)[0].startsWith('.')) return true;
    }
  }
  return false;
}

/**
 * Why no record is kept for a document in this folder at all, whether a
 * repository is there or not, or null: a hidden folder of the home folder
 * (~/.ssh, ~/.aws, ~/.gnupg, ~/.config/*, ~/.kube, ~/.docker), where
 * credentials live, or a folder named like one the secrets list keeps out
 * (.ssh, .aws, .gnupg, .env), anywhere. The secrets' pathspecs are
 * relative to the repository's root, so they miss when the root is that
 * folder.
 */
function secretPlace(dir, home = os.homedir()) {
  if (inHiddenHomeFolder(dir, home)) return 'a hidden folder of the home folder';
  for (const form of forms(dir)) {
    const named = form.split(path.sep).find((part) => SECRET_FOLDERS.some((name) => name.toLowerCase() === part.toLowerCase()));
    if (named) return `a ${named} folder`;
  }
  return null;
}

/**
 * Why a folder in no repository is no place to start one, or null when it
 * is a project's folder: the home folder or a folder it is in, a hidden
 * folder of the home folder or a folder in one, one of its standard
 * folders, a cloud-synced root, a temporary folder, or a volume root. A
 * folder at least one level below any of those but the hidden ones
 * qualifies (~/Projects/foo, ~/Desktop/week-3). Paths are compared as
 * given and with symbolic links resolved (/tmp is /private/tmp on a Mac).
 */
function notProjectFolder(dir, { home = os.homedir(), temporary = TEMPORARY_FOLDERS() } = {}) {
  const here = forms(dir);
  const is = (file) => [...forms(file)].some((form) => here.has(form));
  for (const form of here) {
    if (path.parse(form).root === form || /^\/Volumes\/[^/]+$/.test(form)) return 'a volume root';
  }
  const above = aboveHome(dir, home);
  if (above) return above;
  if (inHiddenHomeFolder(dir, home)) return 'a hidden folder of the home folder';
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

/** A name pattern of the secrets list as a regular expression: `*` is
 *  any run of characters but `/`, `?` one, and case is ignored, as git's
 *  `:(glob,icase)` pathspecs match them. */
function globPattern(pattern) {
  const source = pattern
    .replace(/[.+^$()|{}[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`, 'i');
}
const SECRET_NAMES = SECRET_FILES.map(globPattern);

/** Whether the secrets list matches a root-relative path ('a/b/.env'):
 *  its name matches a file pattern, or a folder on the way has a secret
 *  folder's name. */
function isSecret(relative) {
  const parts = relative.split('/');
  if (SECRET_NAMES.some((pattern) => pattern.test(parts.at(-1)))) return true;
  return parts.slice(0, -1).some((part) => SECRET_FOLDERS.some((name) => name.toLowerCase() === part.toLowerCase()));
}

/** What is at a path without following a link: 'missing', 'file',
 *  'folder', 'link' or 'other'. */
async function kindOf(file) {
  try {
    const info = await fsp.lstat(file);
    if (info.isSymbolicLink()) return 'link';
    if (info.isFile()) return 'file';
    if (info.isDirectory()) return 'folder';
    return 'other';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

/**
 * .claerbout/untracked.json: every file under untracked/ with its size,
 * mtime and SHA-256, so the data the record leaves out is still pinned by
 * it. A file is hashed again only when its size or mtime changed; the
 * hashes live in `cacheFile`, outside the project. A file that cannot be
 * read is left out and named to `unreadable`; a file the secrets list
 * matches is left out, neither named nor hashed, and counted to `secrets`.
 * The manifest is written to a new file beside it and renamed over it, so
 * a link there is replaced, never followed, and a reader never sees half
 * of one; but a link (or anything not a file) at its name, or at
 * .claerbout's, means no manifest: null, and nothing written.
 */
async function writeManifest(root, cacheFile, { unreadable = () => {}, secrets = () => {} } = {}) {
  const manifest = path.join(root, MANIFEST);
  const folder = await kindOf(path.dirname(manifest));
  if (folder === 'missing') await fsp.mkdir(path.dirname(manifest));
  else if (folder !== 'folder') return null;
  if (!['missing', 'file'].includes(await kindOf(manifest))) return null;
  let cache = {};
  try {
    cache = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
  } catch {
    // No cache yet, or an unreadable one: every file is hashed.
  }
  const files = (await filesUnder(path.join(root, UNTRACKED))).sort();
  const fresh = {};
  const entries = [];
  let secret = 0;
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (isSecret(relative)) {
      secret += 1;
      continue;
    }
    let info;
    let sha256;
    try {
      info = await fsp.lstat(file);
      if (!info.isFile()) continue;
      const known = cache[relative];
      sha256 = known && known.size === info.size && known.mtime === info.mtimeMs ? known.sha256 : await sha256Of(file);
    } catch (error) {
      if (error.code !== 'ENOENT') unreadable(relative);
      continue;
    }
    fresh[relative] = { size: info.size, mtime: info.mtimeMs, sha256 };
    entries.push({ path: relative, size: info.size, mtime: new Date(info.mtimeMs).toISOString(), sha256 });
  }
  secrets(secret);
  const text = `${JSON.stringify({ files: entries }, null, 2)}\n`;
  let current = null;
  try {
    current = await fsp.readFile(manifest, 'utf8');
  } catch {
    // Not there yet.
  }
  if (current !== text) {
    const fresher = `${manifest}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(fresher, text, { flag: 'wx' });
      await fsp.rename(fresher, manifest);
    } finally {
      await fsp.rm(fresher, { force: true });
    }
  }
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  await fsp.writeFile(cacheFile, JSON.stringify(fresh));
  return entries;
}

// MARK: - One project

/** Pathspecs for the secrets, whatever the case: `exclude,` for git add,
 *  '' to match them. */
function secretPathspecs(magic) {
  return [
    ...SECRET_FILES.map((pattern) => `:(${magic}glob,icase)**/${pattern}`),
    ...SECRET_FOLDERS.map((name) => `:(${magic}glob,icase)**/${name}/**`),
  ];
}

/** A commit skipped for a reason of the repository's, not an error:
 *  said once, as a guard's reason is. */
class Skip extends Error {
  constructor(reason, line) {
    super(reason);
    this.reason = reason;
    this.line = line;
  }
}

class Project {
  /**
   * @param {object} options
   * @param {string} options.binary git
   * @param {string} options.root the working tree
   * @param {string} options.gitDir its git dir (a linked worktree's own)
   * @param {string} [options.commonDir] the repository's common git dir;
   *   asked of git when omitted
   * @param {string} [options.branch] the record's branch name (branchFor)
   * @param {string} options.appName lower-case, the message's prefix
   * @param {string} options.stateDir this project's folder in the shell's state
   * @param {(line: string) => void} options.log
   */
  constructor({ binary, root, gitDir, commonDir, branch = BRANCH_NAME, appName, stateDir, log }) {
    this.binary = binary;
    this.root = root;
    this.gitDir = gitDir;
    this.commonDir = commonDir ?? null;
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
    /** The last job's error, so a failure every tick is said once. */
    this.failedWith = null;
    /** Secret files in untracked/ the manifest left out, for the log. */
    this.manifestSecrets = 0;
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

  /** Chain a job after the ones before it; its failure is logged, not
   *  thrown, and said once until a job succeeds again, so a repository
   *  the record cannot write logs its reason once, not every tick. */
  run(job) {
    this.pending += 1;
    const next = this.queue
      .then(job, job)
      .then(
        (value) => {
          this.failedWith = null;
          return value;
        },
        (error) => {
          if (error.message !== this.failedWith) this.log(`autosave: ${error.message} (${this.root})`);
          this.failedWith = error.message;
          return null;
        },
      )
      .finally(() => {
        this.pending -= 1;
      });
    this.queue = next.then(() => undefined);
    return next;
  }

  /** A folder of the record's in the working tree, made when missing;
   *  false (said once) when a symbolic link or something that is not a
   *  folder has its name. Never followed: a link to ~ would have the
   *  manifest walk and hash the whole home folder. */
  async folder(name) {
    const full = path.join(this.root, name);
    let kind;
    try {
      kind = await kindOf(full);
      if (kind === 'missing') {
        await fsp.mkdir(full);
        return true;
      }
    } catch (error) {
      kind = error.code ?? 'unusable';
    }
    if (kind === 'folder') return true;
    const what = kind === 'link' ? 'is a symbolic link' : kind === 'file' || kind === 'other' ? 'exists and is not a folder' : `cannot be used (${kind})`;
    this.once(`folder ${name}`, `autosave: ${name} ${what}, so untracked/ is not kept and has no manifest (${this.root})`);
    return false;
  }

  /** untracked/ exists and is ignored; .claerbout/ exists. Once per
   *  process; idempotent on disk. Neither, and no manifest, when a file or
   *  a link has either name, or when the line has to go into a .gitignore
   *  that is a link (git reads no linked .gitignore, and the append would
   *  land in the file it points to). */
  async prepare() {
    if (this.prepared) return;
    const ignored = (await this.git(['check-ignore', '-q', `${UNTRACKED}/`])).status !== 1;
    const file = path.join(this.root, '.gitignore');
    const kind = ignored ? null : await kindOf(file);
    if (kind !== null && kind !== 'missing' && kind !== 'file') {
      this.manifest = false;
      this.prepared = true;
      this.once('gitignore', `autosave: .gitignore ${kind === 'link' ? 'is a symbolic link' : 'is not a file'}, so untracked/ is not kept and has no manifest (${this.root})`);
      return;
    }
    this.manifest = (await this.folder(UNTRACKED)) && (await this.folder('.claerbout'));
    if (!this.manifest || ignored) {
      this.prepared = true;
      return;
    }
    const line = `# Claerbout: large data, caches and scratch, pinned by .claerbout/untracked.json\n${UNTRACKED}/\n`;
    if (kind === 'missing') {
      await fsp.writeFile(file, line, { flag: 'wx' });
    } else {
      const text = await fsp.readFile(file, 'utf8');
      const lead = text === '' || text.endsWith('\n') ? '' : '\n';
      const handle = await fsp.open(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        await handle.write(`${lead}${line}`);
      } finally {
        await handle.close();
      }
    }
    this.prepared = true;
    this.log(`autosave: ${UNTRACKED}/ added to .gitignore (${this.root})`);
  }

  /** The repository's common git dir, where every worktree's own is. */
  async common() {
    if (this.commonDir) return this.commonDir;
    const { status, stdout } = await this.git(['rev-parse', '--git-common-dir']);
    this.commonDir = status === 0 && stdout.trim() ? realpath(path.resolve(this.root, stdout.trim())) : this.gitDir;
    return this.commonDir;
  }

  /** Whether the record's branch is being rebased in any working tree:
   *  that worktree's HEAD is detached meanwhile, so the worktree list does
   *  not show the branch, but the rebase's head-name names it. */
  async rebasing() {
    const common = await this.common();
    let names = [];
    try {
      names = fs.readdirSync(path.join(common, 'worktrees'));
    } catch {
      // No linked worktrees.
    }
    for (const dir of [common, ...names.map((name) => path.join(common, 'worktrees', name))]) {
      for (const state of ['rebase-merge', 'rebase-apply']) {
        try {
          if (fs.readFileSync(path.join(dir, state, 'head-name'), 'utf8').trim() === this.ref) return true;
        } catch {
          // No rebase there.
        }
      }
    }
    return false;
  }

  /** Why no commit can be made right now, or null. Asked before a commit
   *  and again just before its ref moves. */
  async blocked() {
    if (fs.existsSync(path.join(this.gitDir, 'index.lock'))) return 'index.lock exists';
    for (const marker of IN_PROGRESS) {
      if (fs.existsSync(path.join(this.gitDir, marker))) {
        return `${marker.replace(/_HEAD$/, '').replace('-', ' ').toLowerCase()} in progress`;
      }
    }
    // A symbolic ref at the record's name would carry the write to the
    // branch it points at (the user's main, say).
    if ((await this.git(['symbolic-ref', '-q', this.ref])).status === 0) return `${this.branchName} is a symbolic ref`;
    // The branch checked out in any working tree of the repository: an
    // update-ref would move that worktree's HEAD under the user.
    const listed = await this.git(['worktree', 'list', '--porcelain']);
    const checkedOut =
      listed.status === 0
        ? listed.stdout.split('\n').includes(`branch ${this.ref}`)
        : (await this.git(['symbolic-ref', '-q', 'HEAD'])).stdout.trim() === this.ref;
    if (checkedOut) return `${this.branchName} is checked out`;
    // Being rebased in a working tree: a commit now would strand the
    // user's `git rebase --continue` (it cannot lock the ref).
    if (await this.rebasing()) return `${this.branchName} is being rebased`;
    return null;
  }

  /** A skipped commit's result; the reason said when it is new. */
  skip(reason, message, line = `autosave: not recorded while ${reason} (${this.root})`) {
    if (reason !== this.blockedBy) {
      this.log(line);
      this.blockedBy = reason;
    }
    return { skipped: reason, message };
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
   * manifest and .gitignore go in whatever the ignore rules say. A clean
   * filter that cannot run (git-lfs not installed, with
   * filter.<name>.required) is a Skip, said once.
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
    const filtered = (result) => {
      // A filter git could not run is fatal (128), even with --ignore-errors.
      const failure = result.status !== 0 && result.status !== 1 && filterFailure(result.stderr);
      if (failure) throw new Skip(`a clean filter cannot run: ${failure}`, `autosave: not recorded, a clean filter cannot run: ${failure} (${this.root})`);
      return result;
    };
    let added = filtered(await add());
    const unborn = [...added.stderr.matchAll(/'(.+?)\/?' does not have a commit checked out/g)]
      .map((match) => match[1])
      .filter((entry) => !this.excluded.has(entry));
    for (const entry of unborn) {
      this.excluded.add(entry);
      this.once(`unborn ${entry}`, `autosave: ${entry}/ is a repository without a commit, left out of the record (${this.root})`);
    }
    // An older git gives up (128) on a nested repository without a commit
    // even with --ignore-errors: again, with it excluded.
    if (added.status !== 0 && added.status !== 1 && unborn.length > 0) added = filtered(await add());
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
      const forcedAdd = filtered(await this.git(['add', '-f', '--', ...forced.map((file) => `:(literal)${file}`)], { env }));
      if (forcedAdd.status !== 0) throw new Error(`git add -f: ${errorLine(forcedAdd.stderr) || forcedAdd.status}`);
    }
    if (!this.secretsShown) {
      // Once per launch: what the secrets list keeps out of this project,
      // so a name it catches by mistake (id_map.csv) is seen, and how many
      // files in untracked/ the manifest left out (not their names).
      this.secretsShown = true;
      const kept = await this.git(['ls-files', '-z', '-o', '--exclude-standard', '--', ...secretPathspecs('')], { env });
      const names = kept.status === 0 ? nulList(kept.stdout) : [];
      const inUntracked = this.manifestSecrets;
      const more = inUntracked > 0 ? `${inUntracked} ${inUntracked === 1 ? 'file' : 'files'} in ${UNTRACKED}/, left out of its manifest` : '';
      if (names.length > 0 || more) {
        this.log(`autosave: kept out of the record as possible secrets: ${[names.length > 0 ? someOf(names) : '', more].filter(Boolean).join('; ')} (${this.root})`);
      }
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
    if (reason) return this.skip(reason, message);
    await this.prepare();
    if (this.manifest) {
      const written = await writeManifest(this.root, path.join(this.stateDir, 'hashes.json'), {
        unreadable: (file) => this.once(`unhashed ${file}`, `autosave: ${file} cannot be read, so the manifest leaves it out (${this.root})`),
        secrets: (count) => (this.manifestSecrets = count),
      });
      if (written === null) {
        this.manifest = false;
        this.once('manifest', `autosave: ${MANIFEST_PATH} or its folder is a symbolic link or not a file, so untracked/ has no manifest (${this.root})`);
      }
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
          if (parentTree.status === 0 && parentTree.stdout.trim() === tree) {
            this.blockedBy = null;
            return { skipped: 'unchanged', message };
          }
        }
        const made = await this.git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], {
          env: await this.identity(),
        });
        if (made.status !== 0) throw new Error(`git commit-tree: ${errorLine(made.stderr) || made.status}`);
        const hash = made.stdout.trim();
        // The guards again: filling a large tree takes seconds (minutes
        // when untracked/ is hashed for the first time), long enough for
        // the user to check the branch out or start a rebase.
        const late = await this.blocked();
        if (late) return this.skip(late, message);
        const updated = await this.git([
          'update-ref',
          '--no-deref',
          '-m',
          `autosave: ${message}`,
          this.ref,
          hash,
          parent ?? '0'.repeat(tree.length),
        ]);
        if (updated.status === 0) {
          this.blockedBy = null;
          return { committed: true, hash, message };
        }
        if (attempt === 1) throw new Error(`git update-ref: ${errorLine(updated.stderr) || updated.status}`);
      }
      return { skipped: 'the branch moved twice', message };
    } catch (error) {
      if (error instanceof Skip) return this.skip(error.reason, message, error.line);
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
    /** Repositories refused for where their root is, said once each. */
    this.refusedRoots = new Set();
    /** Membership changes, one after another. */
    this.chain = Promise.resolve();
    this.quitting = false;
  }

  get enabled() {
    return this.binary !== null;
  }

  /** The project for a document's folder: the repository it is in, or one
   *  made there when it is in none and is a project's folder; null where
   *  no record is kept (said once per folder): a hidden folder of the home
   *  folder or a secret-named one, repository or not, and a repository
   *  whose root is the home folder or a folder it is in (said once per
   *  repository). */
  async rootFor(dir) {
    if (this.roots.has(dir)) return this.roots.get(dir);
    let root = null;
    try {
      const secret = secretPlace(dir, this.places.home);
      let found = secret ? 'refused' : await repositoryOf(this.binary, dir);
      if (secret) this.log(`autosave: no record for ${dir}: it is in ${secret}, where credentials are kept`);
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
        const above = aboveHome(found.root, this.places.home);
        if (above) {
          if (!this.refusedRoots.has(found.root)) {
            this.refusedRoots.add(found.root);
            this.log(`autosave: no record for the repository at ${found.root}: it is ${above}, and would take in everything under it`);
          }
        } else {
          root = found.root;
          if (!this.projects.has(root)) {
            const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
            this.projects.set(
              root,
              new Project({
                binary: this.binary,
                root,
                gitDir: found.gitDir,
                commonDir: found.commonDir,
                branch: branchFor(found),
                appName: this.appName,
                stateDir: path.join(this.stateDir, key),
                log: this.log,
              }),
            );
          }
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
  secretPlace,
  isSecret,
  writeManifest,
  errorLine,
  filterFailure,
  gitEnvironment,
  BRANCH,
  BRANCH_NAME,
  SECRETS,
  SECRET_FILES,
  SECRET_FOLDERS,
  IDENTITY,
  MANIFEST,
  UNTRACKED,
};
