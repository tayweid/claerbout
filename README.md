# Claerbout

One Electron shell for a suite of document apps — Knuth, Plass, ManimLive —
built once per app from a config. Each app gets its own name, icon, Dock
entry, menus, file types and install line; the shell is the same code. The
design record is in Knuth's `docs/APP.md` ("Electron, one shell for
Claerbout") and `docs/SHELL_STABILITY.md`; Plass's port is in its
`docs/CLAERBOUT-SHELL.md`, ManimLive's in its `docs/claerbout_experiment.md`.

The shell owns what a native app must: a window per document, the native
open and save dialogs, a first-launch choice of Python and its setup (uv,
or the page running by itself), the engine process's lifetime, files by
absolute path on the page's behalf, and Chromium's permission questions.
Everything else is the app's own page, served from the bundle under
`<scheme>://app/` or by the app's engine over loopback.

An app ships **without Electron's framework** (286 of Electron's 288 MB),
so its download is a few megabytes. The bundle's executable is a small
compiled launcher: with the framework present it becomes Electron; without,
it completes the app first (`complete.sh`), cloning the framework from
another installed Claerbout app on the same Electron version — an APFS
clone, no space used — or downloading Electron's release from GitHub and
checking it against the published sums and the hash the app records. The
install line does the same before moving the app into place.

## Using it from an app

```
npm install https://github.com/tayweid/claerbout/archive/refs/tags/v0.2.1.tar.gz
```

Pin a tag: Electron's version is pinned here, and a sibling clone needs an
exact match, so every app moves to a new Electron together (one tag, one
pull request per app, the same day). Depend on the tag's tarball, not on
`github:tayweid/claerbout#v0.1.0`: npm records that form as git over SSH in
the lockfile, which a CI runner without a key cannot fetch, and rewrites
it back to SSH on every `npm install` even when the lockfile says HTTPS.
The tarball needs no git and carries an integrity hash.

Scripts an app typically has:

```json
"app":        "CLAERBOUT_APP=app/knuth.json electron node_modules/claerbout",
"app:build":  "node node_modules/claerbout/package.mjs --config app/knuth.json",
"app:smoke":  "node node_modules/claerbout/smoke.mjs --config app/knuth.json browser",
"app:install-script": "node node_modules/claerbout/package.mjs --config app/knuth.json --install-script public/install"
```

- `electron node_modules/claerbout` runs the shell from the checkout on the
  config named in `CLAERBOUT_APP`; the page loads from the engine, from
  the config's `web` folder, or from the package's `web/`.
- `package.mjs --config … ` builds the app with `@electron/packager` and
  installs it into Applications; `--install path.app` elsewhere; `--zip
  out/ --arch arm64,x64` writes the deploy's download zips
  (`<Name>-<arch>.zip`, and `<Name>.app.zip` for a page's download
  button); `--web dist` takes the page from a site build. Needs macOS with
  Apple's command-line tools (`swiftc`, `sips`, `iconutil`, `codesign`).
- `--install-script <file>` renders `install.template` for the app: the
  `curl … | bash` line users run. Commit the output (Knuth's
  `public/install`) so the site serves it.
- `smoke.mjs --config … [browser|uv] [App.app]` launches the app (the
  checkout's, or a built bundle, complete or not) on a document in a
  throwaway config folder and checks what the config's `smoke` section
  says; see below. With `CLAERBOUT_SMOKE_SHOTS` naming a folder, it leaves
  there a picture of the window with the History page in its room.

## The config

One JSON file per app (`app/knuth.json`, `app/plass.json`). The build
copies it into the bundle as `app.json`.

| key | meaning |
| --- | --- |
| `name` | The app's name: `Knuth` → `Knuth.app`, the menu, the log. |
| `id` | Bundle identifier. |
| `envPrefix` | Prefix of the environment variables the shell reads for development: `<PREFIX>_CONFIG_DIR`, `_PORT`, `_UV`, `_UV_ARCHIVE`, `_CHOOSE`. |
| `scheme` | The bundled page's scheme: `knuth://app/`. |
| `pythons` | The Pythons offered, in the setup page's order: `"uv"` (the engine on a Python uv installs), `"browser"` (the page from the bundle: Python in the tab, or none). Default `["uv", "browser"]`. One entry means no choice and no setup question. |
| `package` | A Python package holding the engine and, in its `web/`, the page. Set `devPython` to the folder that holds it (relative to the config) for development. |
| `web` | For an app with no package: the page's folder, relative to the config. In the bundle it is `Resources/web`. |
| `webExclude` | Top-level entries of the page's folder left out of the bundle. Default `["install", "app"]`. |
| `engine` | With `"uv"` offered: `args` (after the Python: `["-m", "knuth", "serve"]`; the shell adds `--port` and `--parent`), `marker` (a file in the package that proves the engine is there), `probe` (text the engine's `/` must contain), `python` (the version uv installs), `requirements` (what uv installs beside the package: PEP 508 strings, markers allowed), `requirementsFile` (a requirements file, relative to the config, installed with `-r` beside `requirements`: the place for an exact export of the app's lockfile, `uv export --no-dev --no-emit-project --no-hashes -o app/engine-requirements.txt`, so every install resolves identically; the build copies it into the bundle), `startTimeout` (milliseconds the shell waits for the engine's first answer; default 25000. ManimLive's first start after an install took 14 s on an M-series Mac, reading fresh site-packages). |
| `port` | The engine's preferred port; the next free one if taken. |
| `setupPage` | The first-launch page, inside the page's folder (`setup.html`; a subpath such as `static/setup.html` works). It speaks the protocol itself: `choose` in, `setup` events out. |
| `defaultDocument` | The Save As… panel's suggested name. |
| `openBy` | `"path"` (default): a document opens as `?open=<absolute path>`. `"drop"`: additionally, once the page sends `ready`, the document is dropped on it, so a page that keeps files by handle (File System Access API) gets a real handle. |
| `permissions` | Chromium permissions granted to the app's own pages beyond the defaults (`fileSystem`, `fullscreen`, `clipboard-sanitized-write`): Electron's names, `"clipboard-read"`, `"media"`, `"notifications"`. Everything else is refused. |
| `window` | `width`, `height`, `minWidth`, `minHeight` of a new window; the last size is remembered. `titleBarStyle`: `"default"` (the native title bar), or `"hiddenInset"` / `"hidden"`: no title bar; the page reaches the top of the window and draws the bar itself, with the traffic lights over it. Such a page marks its bar `-webkit-app-region: drag` (with `no-drag` on its controls) so the window still moves by it, and learns where the lights are from the Window Controls Overlay, `navigator.windowControlsOverlay` and CSS `env(titlebar-area-x/y/width/height)`, which the shell publishes whenever the title bar is not native and which is unset (`visible` false, the `env()` fallbacks) when it is — so one page is right under either. `trafficLightPosition`: `{x, y}` (macOS) moves the lights; the overlay's area is 2·y plus the lights tall (14 px on macOS 26, 16 on macOS 15), so a page sets its bar's height from `env(titlebar-area-height)` with the number it wants as the fallback, and y so the band comes out right on the Mac it runs on (y 15 gives 44 or 46). Since 0.2.1; the setup page gets the same bar. `followZoom`: `true` makes the window grow and shrink with View → Zoom In / Out / Actual Size (in one step, on its display; a maximized or fullscreen window is left alone), for a page laid out as a fixed-width paper with a margin (Plass); the page's layout then never changes with the zoom. Since 0.2.1. `scrollBounce`: macOS's rubber band at the end of a scroll, on unless set `false` (Electron leaves it off; a page that stops dead at its edge feels cramped). Since 0.2.1. |
| `icon` | A PNG, 512 px or larger, relative to the config. |
| `copyright` | For the bundle's Info.plist. |
| `documentTypes` | Finder's Open With: `name`, `role`, `rank` (`Alternate` unless you mean to take the type), and `contentTypes` (UTIs) or `extensions`. |
| `site` | The URL the install line downloads from (`https://knuth.tayweid.io`); the zips and `latest.json` live at `<site>/app/`, and the app checks there for updates. |
| `elsewhere` | A sentence the install line adds when run off macOS. |
| `autosave` | `true` keeps the autosave record of every project a window is on (below). Knuth and Plass set it; ManimLive does not. |
| `smoke` | What `smoke.mjs` checks: `document` (name), `text` (contents), `ready` (a selector) and `readyText` (its text, or per mode `{uv, browser}`), `run` (a selector to click), `written` (a file expected beside the document), `json` (keys it must hold) or `contains` (text it must hold), and `autosave` (subjects the document folder's `claerbout-autosave` branch must show by the end, `["knuth: session open", "knuth: cell run [1]"]`), then `history` and `room` (selectors of the page's History tile and of the room it opens over: the History page is opened in the room and checked there before the window form, its "Keep an untracked/ folder here" box ticked and unticked under "Whole project"; without them, only the window form). With `autosave`, the document's folder must hold no `untracked/`, `.claerbout/` or `.gitignore` the record wrote by itself. With `run` and `written`, the record is asked to hold the written file, and the window form's card for the session-open commit must offer the rewind that removes it, its fine print speaking of a kernel's memory only where a `.py` or `.ipynb` is open. |

## What the shell expects of an engine

- It is started as `<python> <engine.args> --port N --parent PID`, serves
  its page at `http://127.0.0.1:N/`, and exits when the parent pid is
  gone. The shell loads pages as `http://127.0.0.1:N/…`, so an engine
  that checks the `Origin` of its socket must accept that origin, not
  only `http://localhost:N`.
- It reads `<PREFIX>_CONFIG_DIR` for its own state (recents, preferences):
  the shell sets it to the app's folder under Application Support, and a
  test sets it to a throwaway folder, so the engine's state follows the
  app's.
- Its Python is a uv-managed interpreter in a virtual environment inside
  uv's data directory, beside uv's own `python/` and `tools/`:
  `~/.local/share/uv/claerbout/<package>` (`%APPDATA%\uv\claerbout\<package>`
  on Windows), made with `uv venv` and filled with `uv pip install
  <requirements>`, so uv owns every Python on the machine and the app's
  folder under Application Support holds only its state. Not uv's
  `tools/`: `uv tool list` calls an environment without a receipt malformed
  and offers to uninstall it. Returning an app to its first launch means
  removing both: the Application Support folder and that environment. A
  test sets `CLAERBOUT_UV_DIR` to a throwaway folder, as `smoke.mjs` does.
- The environment follows the app: the shell stamps what it installed
  (`claerbout-requirements.sha256` in the environment) and, when an update
  of the app changes `requirements` or the requirements file, runs the
  install again on the next launch, behind the setup page's progress
  screen. The engine's own code is never installed: it is the package in
  the bundle, on `PYTHONPATH`, and changes with the app.
- It runs with `PYTHONPATH` set to the bundle's `python/` folder, and
  `PYTHONDONTWRITEBYTECODE=1`: the bundle is not the engine's to write.

## Updating

An installed app updates itself (`update.js`; Knuth's `SHELL_STABILITY.md`,
"An update path for the download button"). `package.mjs --zip` writes
`latest.json` beside the zips — the build the zips are (`CLAERBOUT_BUILD`,
else the deploy's `GITHUB_SHA`, else the working directory's `HEAD`), the
time, the Electron version, the zip names and their SHA-256 — and stamps
the same build into the bundle's `package.json`. The site is the config's
`site`; every deploy publishes `app/latest.json` with the zips. Then:

- **In the menu**, Check for Updates… compares the two builds and offers
  to install: the app downloads the zip, checks it against the site's
  checksum and its own signature, unpacks it beside the bundle, completes
  it with its own `complete.sh` (cloning the framework from the running
  app when the Electron version is unchanged, downloading Electron
  otherwise), swaps the bundles with two renames and relaunches, reopening
  its documents. The bundle it replaced is removed by the next launch.
- **In the page**, an `update` request is the same check, answered
  `{state: 'current' | 'available' | 'development' | 'unsupported' |
  'failed', current, latest, text?}`; `{type: 'update', action: 'install'}`
  starts the install, whose steps every window hears as `update` events
  (`{state: 'downloading' | 'unpacking' | 'completing' | 'installing' |
  'ready' | 'failed', text, percent?}`). The shell also checks quietly
  eight seconds after launch and sends `{state: 'available', latest,
  current}` to every window (and to each opened later), which is when a
  page shows its update button.
- **From a terminal**, the install line updates in place (as before), and
  `curl -fsSL <site>/install | bash -s -- --check` says what is installed
  and what the site has, installing nothing.

Only an installed Mac app replaces itself; a checkout answers
`development`, Windows `unsupported`. `<PREFIX>_SITE` overrides the site
for a test (a URL, or a folder holding `app/latest.json` and the zips), and
`smoke.mjs --config … update App.app site-folder` is that test: it has the
page request the install and checks that the bundle on disk becomes the
site's build, that the app relaunches into it, and that the old bundle is
cleaned up.

A site build that is not newer than the installed one is left alone and said in the log, not offered: both `latest.json` and the bundle's `package.json` carry `built`, so a build installed from a checkout (an app's `npm run install:local`) stays until the site passes it.

## The autosave record

With `"autosave": true` in the config, the shell keeps a full, unpruned
git record of every project a window is on (`autosave.js`; the spec is
Knuth's `docs/AUTOSAVE.md`): a GPX track for research. The shell is the
git runner for every app, since it has the filesystem and knows which
document each window holds; a page only says when something happened.

- **The project.** A document's project is the git repository its folder
  is in (`git rev-parse --show-toplevel`), wherever that repository is. A
  folder in none gets one, quietly, once (`git init`), but only in a
  project's folder: never the home folder or a folder it is in, never
  `~/Desktop`, `~/Documents`, `~/Downloads`, `~/Movies`, `~/Music`,
  `~/Pictures`, `~/Public` or `~/Library` themselves, never a cloud-synced
  root (iCloud Drive and the apps' containers under `~/Library/Mobile
  Documents`, `~/Library/CloudStorage/*` and a Google Drive's `My Drive`,
  `~/Dropbox`, `~/OneDrive…`, `~/Box`), a temporary folder (`os.tmpdir()`,
  `/tmp`, `/var/tmp`) or a volume root (`/`, `/Volumes/*`). A folder at
  least one level below any of those qualifies: `~/Projects/foo`,
  `~/Desktop/week-3`. A document elsewhere has no record, and the log says
  why, once per folder per launch. No record at all, repository or not,
  for a document in a hidden folder of the home folder (`~/.ssh`, `~/.aws`,
  `~/.config/gh`: where credentials live) or in a folder named `.ssh`,
  `.aws`, `.gnupg` or `.env` anywhere, nor for a repository whose root is
  the home folder or a folder it is in (a dotfiles `~/.git` would take in
  everything under home) or, as git reports it, one of those hidden or
  secret-named folders, said once per repository. Every folder is judged
  as the disk keeps it: symbolic links resolved and each name in the
  letter case and Unicode form it is stored in, so `~/DESKTOP/note.txt`,
  which a Mac's case-insensitive volume opens, is a document in `~/Desktop`
  itself, and a path under `/System/Volumes/Data` also as the one it is
  firmlinked to (`/System/Volumes/Data/Users/…` is `/Users/…`). The log
  names the path as it was given.
- **The branch.** One per working tree: `refs/heads/claerbout-autosave`
  in a repository's main working tree, `refs/heads/claerbout-autosave-<name>`
  in a linked worktree (`git worktree add`; `<name>` is the worktree's
  folder name as git keeps it in `.git/worktrees`), so two worktrees open
  at once never write over each other's tip. (A refinement of the spec's
  "one branch per repo"; a hyphen, since git cannot keep
  `claerbout-autosave/<name>` beside `claerbout-autosave`.) Every app on a
  working tree shares its branch.
- **Plumbing only.** A temporary index (`GIT_INDEX_FILE`, kept between
  commits in the app's state folder, `autosave/<project>/index`, for its
  stat cache, and removed at quit) is filled by `git add -A --ignore-errors`
  over the working tree, so `.gitignore` applies, and `.claerbout/ignore`
  (below); entries the ignore rules or the secrets list have come to match
  since are dropped from it; then
  `write-tree`, `commit-tree` with the branch's tip as parent, and
  `update-ref --no-deref` as a compare-and-swap. Every git it runs has
  `core.splitIndex`, `core.fsmonitor` and the add advice off, so nothing
  is written into the user's `.git` but objects and the record's branch
  (and its reflog), and, while a rewind writes the working tree, its lock
  (below), and `core.sparseCheckout` off, so a sparse checkout is
  recorded (git add refuses the manifest outside the cone otherwise); a
  partial clone never fetches (`GIT_NO_LAZY_FETCH`), and git's `PATH` has
  `/opt/homebrew/bin`, `/usr/local/bin` and the system's defaults
  (`/etc/paths`, `/etc/paths.d`) after the app's own, so a clean filter
  such as git-lfs is found from a Finder launch.
- **What it never touches, and what it writes.** The user's HEAD, branch
  and index are never touched. Nothing is committed while the record's
  branch is checked out in any working tree of the repository (an
  `update-ref` would move that HEAD; the log says so once) or being
  rebased in one (its `rebase-merge/head-name` or `rebase-apply/head-name`
  names the branch), while the record's ref is a symbolic ref (the write
  would land on the branch it points at), while `index.lock` exists, while
  another app's rewind is writing the working tree (the lock it holds
  beside `index.lock`, `claerbout-rewind.lock`: "Plass is rewinding this
  project"), or while a merge, rebase, cherry-pick or revert is in
  progress, and nothing when the tree equals the tip's. Each guard's
  reason is a sentence, said once in the log ("autosave: not recorded
  while a merge is in progress on main") and shown as it is in the
  history view. The guards are asked
  again just before the ref moves, so only a few milliseconds of race
  remain after a fill that took seconds. In the working tree it writes
  nothing by itself: a project opened and recorded all day gains no
  folder, no file and no `.gitignore` line. Only where the project has an
  `untracked/` folder (the user's choice: made by hand, or from the
  history view's box, below) does it write a `/untracked/` line in
  `.gitignore` (appended, or a new `.gitignore`; anchored, so a folder
  named `untracked` deeper down, such as `tests/untracked/`, stays in the
  user's git and in the record) and `.claerbout/untracked.json`, with its
  folder. These show in the user's own `git status`, and ride along in a
  `git commit -a` or `git add -A` the user makes. A `.claerbout/ignore`
  the user wrote is read as it is; the record never makes one, nor its
  folder for it. None of them is written through a symbolic link: a link
  (or anything else that is not a folder or a file) at `untracked`,
  `.claerbout`, the manifest or, when the line has to be added,
  `.gitignore` turns the manifest off for that project, said once. No
  line is added while the rules already ignore `untracked/`, so an
  unanchored `untracked/` line an earlier build wrote is left as it is;
  it still ignores every folder of that name at any depth until it is
  changed to `/untracked/` by hand. A project an earlier build wrote into
  (when every project got an empty `untracked/`, the line and the
  manifest) keeps working as it did: the record removes nothing it once
  wrote, and a manifest that is there is kept up even after the folder is
  taken away by hand (it then lists no files), its line left as it is.
  The history view's box puts an empty one away.
- **What git cannot read, or must leave out.** A file git cannot read is
  left out, and the log names it once; the rest is recorded. A nested
  repository without a commit (a fresh `git init` or `uv init` inside the
  project) is left out, said once, until it has one; a nested repository
  with a commit is recorded as a gitlink, as git does. A file named
  `untracked` (not a folder) means no `untracked/` and no manifest for that
  project, said once. A required clean filter that cannot run (git-lfs not
  installed, `filter.lfs.required`) skips the commit, and the log names the
  missing command once; any other failure is said once until a commit
  lands again, never every tick.
- **Messages.** `<app>: <trigger>`: `knuth: cell run [4]`, `plass: timer`,
  `knuth: session open`, `plass: session close`. The author is the
  repository's git identity when it has one, else `Claerbout Autosave
  <autosave@claerbout.local>`; commits are not signed.
- **Triggers.** A page's `autosave {trigger}` request (Knuth sends `cell
  run [n]` once a run's writes have landed); a one-minute timer per open
  project, not per window, whose tick is dropped while a commit is under
  way, so a commit slower than a minute never piles up; `session open`
  when the first window on a project opens and `session close` when the
  last closes. One job at a time per project. Quitting closes every open
  session and waits for every job already queued (a session close from a
  window just shut included), for at most 20 s, so quitting never hangs.
- **`untracked/`**, for large data, caches and scratch, where a project
  keeps one, is ignored but pinned: `.claerbout/untracked.json` lists every file in it with its
  path, size, mtime and SHA-256, rewritten before every commit, and is
  always recorded, as is `.gitignore`, whatever the ignore rules say (a
  `*.json` or `.claerbout/` line cannot make `untracked/` a loophole). A
  file is hashed again only when its size or mtime changed; the hashes
  are cached under the app's state folder (`autosave/<project>/hashes.json`).
  A file in `untracked/` that the secrets list matches is left out of the
  manifest, name and hash (a hash of a short secret can be reversed), and
  only counted in the log. The manifest is made in the app's state folder
  (beside itself only when that folder is on another volume) and renamed
  into place, so it is never half-written, and no fill (another app's
  included) finds the new file in the working tree, not even after a crash;
  what a shell that died left in its state folder (named for its pid) goes
  at the next launch's first fill. Every fill also leaves the top
  `untracked/` folder out by pathspec (and drops it from the kept index),
  not only by the `.gitignore` line, and whether or not the project keeps
  one (where there is none the pathspec matches nothing): the record is
  never pruned, so a moment in which `.gitignore` lacks the line (another
  tool rewriting it, or a folder made by hand since the last fill, whose
  line comes at the next) must not be enough to take it in. The folder's
  contents only, as the line matches: a file named `untracked` put in its
  place mid-session is the project's, and is recorded. The record looks
  for the folder at every fill (an `lstat`), so one made by hand counts
  from the next commit.
- **Secrets.** Kept out of the record by pathspec, in every folder and
  whatever the case (`Server.PEM`, `ID_RSA`): the files `.env`, `.env.*`,
  `*.pem`, `*.key`, `id_*`, `*.p8` (App Store Connect's `AuthKey_*.p8`),
  `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.keychain`, `*.keychain-db`,
  `*.gpg`, `*.asc`, `*.ppk`, `*.kdbx`, `credentials.json`,
  `service-account*.json`, `client_secret*.json`, `kaggle.json`,
  `secrets.toml`, `.git-credentials`, `.pypirc`, `.npmrc`, `.netrc`,
  `.htpasswd`, `.Renviron`, `token`, `token.txt`, `*.token`, `.token*`,
  and everything under a folder named `.env/`, `.aws/`, `.ssh/` or
  `.gnupg/`. Names only: nothing scans file contents, so a key pasted into
  a notebook is recorded. `tokenizer.py` and `tokens.json` are recorded;
  `id_*` also catches `id_map.csv`, and `*.key` a Keynote deck, so the log
  names what the list kept out of a project, once per launch, and such a
  catch is seen.
- **`.claerbout/ignore`**, at the project's root, is the project's own say
  over the record: patterns in `.gitignore`'s syntax (negations, `**`,
  anchored and folder patterns as git reads them) that the record keeps out
  on top of `.gitignore`, the secrets list and `untracked/`, while the
  project's own git never sees them. For files git tracks because they are
  posted, but whose every re-render the record need not keep: `*.mp4`
  keeps a course's rendered videos in the user's index and commits and out
  of the record's tree. It is read again at every fill (it is small), so an
  edit counts from the next commit, and copied into the app's state folder,
  where git reads it, never through a link: it is the excludes file
  (`-c core.excludesFile`, followed by the user's own, which still
  applies) of the record's `git add -A` alone, so a new file it matches is
  never hashed, and what it matches among the paths the kept index holds
  (a tracked file recorded before the pattern was written: git's ignore
  rules never apply to a path an index holds) leaves the index by `git
  ls-files -i -X` before the add, so a re-render is not hashed on the way
  out either. A path the project's own `.gitignore` takes back with a
  negation (`!posted.mp4`, which outranks an excludes file) is dropped
  after the add and left out of every add by name from then on. The file
  itself is always recorded, as `.gitignore` is, and may be tracked by the
  project so it travels. The log says how many patterns it keeps out when
  it is first seen and whenever it changes ("autosave: .claerbout/ignore
  keeps 3 patterns out of the record"), and when it goes. One that is no
  list of patterns (not text, a link, past 256 KB, or a line git could
  never match, such as a `[` never closed or a trailing backslash) is
  named in the log and left aside whole until it is put right: the record
  keeps more, never less. A rewind never writes or removes a file it keeps
  out, nor the file itself, and the card names each ("kept out by
  .claerbout/ignore"; "the record's own rules, left as they are").
- **The log** gets one line per commit (`autosave: knuth: cell run [4] →
  <hash> (<project>)`), and one when a repository is initialised, when
  `.gitignore` gains `/untracked/`, when the history view keeps or puts
  away `untracked/`, when a folder is refused, and when a
  commit is skipped for a new reason. An error is git's last line that is
  not a `hint:`, a `warning:` or a wrap-up (`the remote end hung up
  unexpectedly`, after a filter that never started).
- **Nothing is pushed.** The spec's outside witness (the branch pushed to
  `origin` after every ~10 commits, every 30 minutes with anything
  unpushed, on close and on launch) is not built; see "Built" in Knuth's
  `docs/AUTOSAVE.md`.

`<PREFIX>_AUTOSAVE=0` turns the record off for a test;
`<PREFIX>_AUTOSAVE_INTERVAL` (seconds) sets the timer. Without git on the
machine (on a Mac, without the developer tools) the record is off and the
log says so. The tests (`npm run test:autosave`) run real git in
temporary repositories under `os.tmpdir()`, among them a project opened
and filled three times that gains nothing, the box's two ways
(`keepUntracked`: the folder, the line and the manifest made at once, a
file dropped in pinned by hash and kept out of the tree; put away, exactly
what was added gone), and a project an earlier build wrote into.

## The history view

The record as a path, with a rewind (`history.js`, `history/history.html`;
the design is Knuth's `docs/mockups/history.md`, the look
`history-recommended.html`). The record runs down the window as a river,
oldest at the top and now at the mouth: cell runs bold (a red ring when the
run raised), timer commits faint and folded three or more to a line, earlier
days folded to one reach each; the user's own branches are tributaries
beside it, tied to the record where they hold the same files. Click a node
and a card beside it says what that commit changed (the document's cells lit
in a strip, the changed lines, a figure drawn) and what a rewind would
change against now, file by file, with a box to leave a file out; click the
node again, or the card's button, to rewind.

- **The page.** The shell's own, one copy for every app, served at
  `<scheme>://app/_claerbout/history.html` from the `history/` folder
  beside `main.js` (shipped in `files` and copied by `package.mjs`), checked
  before the app's page folder, so no app's page shadows it or is reached
  through it; the scheme is handled in every mode, so it works beside an
  engine's pages too. It is never given a document, so the record opens no
  session for it. Where there is no project it still opens, and says why:
  `unsaved` (no document path), `refused` (the folder rule, in words),
  `off` (the config or `<PREFIX>_AUTOSAVE=0`), `no-git`.
- **In the room.** The app's History tile (in its bar, after the name
  pill) toggles the page in the room of the document's own window, not a
  window of its own: the shell lays it over the room's box as a
  `WebContentsView` with the document windows' own preferences
  (`win.contentView.addChildView`), at the box the page sends in CSS px
  times the page's zoom factor, rounded, in DIP, and loads
  `history.html?inline=1` for that window's project. The document stays
  loaded underneath, so a rewind's `save` and `reload` reach it as they
  reach any window on the project; the app's bar stays above. The view's
  background is transparent: the page draws its own panel, rounded 12 px,
  and the frame shows at its corners. Inline, the page has no title strip
  (the app's bar names the document and its folder) and no rail: one 44 px
  row at the top of the panel holds the zoom (Days, Runs, Every commit),
  the scope (below), the apps' chips and the paused pill at its left, the rail's tiles and a
  close tile at its right, and the river and the card are below it, as
  in the window. Escape puts the card away, and with no card open, the
  page. A resize of the window moves nothing by itself: the page measures
  its room (a ResizeObserver, coalesced to a frame, and after a zoom step)
  and sends `bounds`. The view goes, destroyed with its listeners, when the
  tile is pressed again, on Escape or the close tile, from View ›
  History…, and when its window closes or its page navigates (a reload, a
  page of another app's), and the page hears it each time it comes or
  goes, so the tile reads pressed exactly while it is up.
  **View › History…** (⇧⌘H) in a document window does what the tile
  does: the page is told `history {kind: 'toggle'}` and sends `open` with
  its room's box, or, with the view up, the shell puts it away itself.
- **The window.** For a window that is not a document page, and for a
  page's `history` request without the room's box (`{type: 'history'}` or
  `{type: 'history', action: 'open', at?}`, answered `{opened: true}`;
  tests and the fixture keep it): one window per project, titled `History
  — <project>` (the page's own title never replaces it, so two projects'
  windows are told apart), with its own remembered size (`historySize`)
  and a hidden title bar in the suite's frame; a second open brings it
  forward with `history {kind: 'focus', at}`.
- **The document's history.** A course keeps many lectures, notebooks and
  scenes in one repository, and a rewind touches the whole tree unless the
  card's ticks say "just this lecture". So the page opened from a document
  (inline, or the window from a document's window; the shell knows the
  window's document, and a window brought forward from another document's
  window is told `history {kind: 'document'}` and reads that one's) opens
  on that document. A switch beside the zoom says which: **This
  document** draws only the commits that changed the document itself;
  **Its folder**, those that changed anything under its folder, at any
  depth (left out for a document at the project's top, where it would be
  the whole project); **Whole project**, every commit, as before.
  Commits outside the scope are not drawn, not dimmed: the river reads as
  the document's history, its days' counts and the bar's ("12 of 340
  commits") follow it, and a commit asked for by `at` outside it widens
  the look to the whole project. The card ticks by the same scope: the
  document and what its runs write beside it (the files changed in the
  same commits as the document, in its folder: Knuth's `values.json` and
  `figs/`; never from a root commit, whose first fill holds everything,
  nor from a "rewind to", which writes whatever differed), or everything
  under the folder, or every file. The other files stay listed, unticked;
  the button says the count ("Rewind 1 file to 14:05", "Rewind all 5
  files to 14:05"), and the fine print says why and offers **all N files**,
  one click that ticks the rest. A box ticked by hand stays so while the
  record moves on; a change of scope ticks afresh. The switch holds for
  as long as the page is open and is not remembered: the page opens on
  "This document" every time, so a look at the whole project from one
  lecture never changes what the next lecture opens on. A window opened with no document (View › History… from a
  window that is not a document page) has no switch: the whole project.
  The ticks are the partial rewind's `paths`, so nothing of the rewind's
  checks changes.
- **Keep an untracked/ folder here.** The record writes nothing into a
  project by itself, so an `untracked/` folder is the user's choice, made
  under **Whole project** (and in a window opened with no document, which
  is the whole project; never under "This document" or "Its folder"): a
  box below the river's mouth, "Keep an untracked/ folder here: large data
  the record pins by name and hash, never by content". It is unchecked
  unless the folder exists, and says how many files it pins. Ticked, the
  shell makes `untracked/`, adds the record's line to `.gitignore` and
  writes the manifest, at once, and the record keeps the folder from then
  on. Unticked, only while the folder is empty (a Finder `.DS_Store`
  aside), it removes the folder, the manifest, `.claerbout/` when nothing
  else is in it (a `.claerbout/ignore` keeps it), and the record's own
  lines from `.gitignore`, those exact lines as this build or an earlier
  one wrote them (the file itself when nothing else was in it); with files
  in it the box is locked, and its tooltip says why ("untracked/ holds 3
  files: move them out to put the folder away"). Nothing is committed
  then: the next fill records the change as usual. The record's guards
  refuse it as they refuse a rewind, and the box says so beside its words
  ("not now: git holds index.lock"). The box is asked again as the record
  grows, so a file dropped in locks it.
- **Its requests,** answered only from a History page, in a window or in
  the room (the shell knows a view by its webContents, and its window and
  project with it), and always for that page's project (the page never
  names a folder; a document page is answered `null`, and the History page
  cannot read or write files):
  - `history {action: 'graph', before?, limit?}`: `{state: 'on' | 'paused'
    | 'none', reason, detail?, project: {root, name, display, branch}, app,
    tip, head: {branch, sha}, branches: [{name, tip, head}], commits, more,
    total, windows, others, scope, untracked}`, `scope` for a page opened
    from a document `{document, folder}` (the document's path in the
    project and its folder's, `''` at the top), else null; `untracked` the
    box as it is, as `untracked` answers it (below). `windows` (this app's
    documents on the project) and `others` (`[{app, documents}]`, another
    app's) name each document by its path in the project, as the record's
    trees do, resolved through any link on the way: a project reached
    through one (`~/Projects/week-3` a link, or macOS's `/var`, which is
    `/private/var`) still finds its documents, and the page never matches
    an absolute path against the root as text. So do `compare`'s `others`,
    the rewind's `silent` and `other-app` `documents`, and the steps'
    `silent`. The commits come from one `git log
    --date-order --parents --source --numstat -z` over `--branches` with the
    records excluded (`--exclude=claerbout-autosave
    --exclude='claerbout-autosave-*'`) and this working tree's record by
    name: not `--all`, which would pull in `refs/stash`, remotes and other
    worktrees' records. `--numstat` reads every blob it counts, so where
    one is not in the repository (a partial clone's, never fetched; a
    crafted commit's) the log is asked again for names only
    (`--name-only`, which reads trees, never a blob; `plus` and `minus` are
    then 0), and where a tree cannot be read at all (an empty name), for no
    names: the page always loads, and such a commit's card says why no
    rewind writes it. Newest first, at most 2000 (`before`, a sha, pages
    back in time). Each is `{sha, parents, line ('record' or the branch it
    was reached by), refs, time, subject, files, plus, minus, changed (the
    first 20 paths)}`; a record commit has its message parsed (`app`,
    `trigger`: `run` with `cells` and `error`, `timer`, `open`, `close`,
    `rewind-from` with `from`, `rewind-to` with `target` and, for a partial
    one, `partial` and `paths`, or `notice`), and a user commit its `author`
    and its `tie`: the newest record commit at or before it that holds every
    file it holds, byte for byte (`{sha, exact: true}`), else the nearest of
    200 (`{sha, exact: false, differs}`), else null; cached by sha for the
    launch. With a document, each commit also has its `scope`
    (`'document'`, `'folder'` or null) and, where it changed the document,
    `beside` (the paths it changed in the document's folder, the
    document's own among them, at most 200), worked out from the same log's
    file lists: no scope costs another git. The record's new commits are
    scoped for each page as they arrive.
  - `history {action: 'commit', sha}`: `{sha, parents, time, subject,
    author, files: [{path, status, plus, minus, binary, patch?, large?,
    size?}]}` against its first parent (the empty tree for a root), from
    `diff-tree` with no external diff and no textconv; a patch is capped at
    400 lines a file and 1 MB in all. Patches are asked only for files whose
    two sides are each 1 MB or less (16 MB read in all), so one huge file
    costs only itself its patch; such a file is `large`, with its `size`.
    Where git cannot read a blob it would count, the files are listed
    without counts or patches.
  - `history {action: 'blob', sha, path}`: `{text}` (UTF-8, at most 1 MB),
    `{binary: true, size}`, `{large: true, size}` or `{missing: true}`. The
    size is asked first: a file past 1 MB is never read, and the card says
    it is too large to look inside. The page shows an SVG as an image, so
    nothing in a figure runs.
  - `history {action: 'compare', sha, paths?}`: what a rewind would do now,
    on the project's job queue like a commit: `{tip, now (the tree of a
    fresh fill of the working tree, not committed, whose files the page can
    read), target, onRecord, unrecorded, write: [{path, status}], remove,
    skipped: [{path, why}], kept, same, untracked, untrackedGone, others,
    blocked}`, and `invalid: {path, why, absent?, partial?}` (with nothing
    to write) for a commit no rewind writes (below): the rewind's own
    checks, git's `read-tree` among them, so the card never offers a rewind
    the click would refuse.
  - `history {action: 'untracked', keep?}`: the box. Without `keep`,
    `{ok: true, kept, files, unusable?}`: `kept` while `untracked/` is a
    folder, `files` how many are in it (a Finder `.DS_Store` aside), and
    `unusable`, why it cannot be kept, where a link or something that is
    not a folder has its name or `.claerbout`'s. With `keep: true` or
    `false`, the folder made or put away (above), on the project's job
    queue like a commit: `{ok: true, kept, files}`, or `{ok: false,
    refused: 'paused', reason}` while a guard holds, `{refused:
    'not-empty'}` with files in it, `{refused: 'unusable', reason}`, or
    `{refused: 'failed', detail}`, each with `kept` and `files` as they
    are now.
  - `rewind {sha, tip, paths?, anyway?}`: the rewind, below.
  - `history {action: 'close'}`: the page put away (Escape, its close
    tile): the view removed and destroyed, or the window closed. Answered
    `{closed: true}`.

  Cells, `values.json` names and words written are the page's, worked out
  from blob text (a percent-format file split on its `# %%` lines); the
  shell knows git, not the apps' formats. The word on a kernel's memory,
  which no rewind touches, is the page's too: the card's fine print and the
  note after a rewind say it only where a kernel runs on the project, a
  `.py` or `.ipynb` open in a window of this app (`windows`) or another
  (`others`); Plass's paper alone has none.
- **The rewind** is a step forward that reproduces an older state, never a
  reset: the record only grows. It runs as one job on the project's queue,
  so the record's timer is dropped meanwhile. Refused first: `{refused:
  'moved', tip}` when the record's tip is not the `tip` the card was drawn
  against (a timer can commit between the card and the click; the page asks
  again and sends it once more when nothing else changed); `{refused:
  'paused', reason}` under the record's guards (a merge, rebase,
  cherry-pick or revert in progress, `index.lock`, the record's branch
  checked out or being rebased in any worktree, a symbolic ref, or another
  app's rewind of this working tree; the reason is a sentence the page
  shows as it is, "a merge is in progress on main", "git holds
  index.lock", "Plass is rewinding this project"); `{refused: 'invalid',
  path, why, absent?, partial?}` for a commit no rewind writes (below);
  and `{refused: 'other-app', app, documents}` when another app's windows
  hold a file it would write or remove, unless the request says `anyway`.
  Nothing to write or remove is `{same: true}`. All of these come before
  anything is recorded, saved or touched. Then the rewind takes the
  working tree's lock: `claerbout-rewind.lock` in its git dir, beside
  git's own `index.lock`, holding `{pid, app}` and made only if no other
  is there. Another app's rewind holding it refuses this one (`paused`,
  "Plass is rewinding this project"), and while it is held every other
  app's commits wait (the guard above), so no two rewinds write over each
  other and no timer records one half written. It goes when the rewind
  ends; one whose pid is gone, or older than ten minutes (a pid the system
  has since given to another process), is stale, and the next rewind
  replaces it. Then:
  - **Save.** Every one of this shell's windows on the project hears `save
    {id, reason: 'rewind'}`, at once, and has 3 seconds to answer `{type:
    'saved', id, ok?, error?}`; one that answers `ok: false` refuses the
    rewind (`{refused: 'unsaved', path, error?}`). One that does not answer
    is passed over (the apps do not answer yet), logged, and named: the
    save step's `done` carries `{silent: [path]}`, the card says in amber
    that it was not saved first, and, a page that does not answer `save`
    being one that does not reload either, the reload step and the note
    after the rewind say to reopen it.
  1. **Record now:** `<app>: rewind from <tip>` through the record's own
     commit path, skipped when the working tree equals the tip.
  2. **Write the target's files.** The set is `diff-tree --raw` between
     the tip (after step 1) and the target: `A`, `M` and `T` paths are
     written through a throwaway index (`read-tree <target>`, then
     `checkout-index -f` on those paths only, never `-a`, so files that did
     not change keep their mtimes), and a `D` path is removed (a file or
     link, never what a link points at; its folders while empty, never past
     the root) only when the target is on the record and the record's tip
     the card was drawn against held it: nothing the record never held is
     removed, and a commit on a user branch writes the files it holds and
     removes nothing it lacks. Removals come first, so a file that became a
     folder, or a folder (or a link to one) that became a file, is written
     once its removal clears the way, and "rewind to" holds the target's
     tree. Left alone and named: a gitlink, and a path with something in
     its way that the set does not remove (a file the record does not keep,
     ignored or kept out as a secret; a folder that still holds one; a link
     or a file where the target has a folder); a file the target holds
     under the name `untracked`, which the record keeps for its folder; and
     whatever the target holds in a folder named `.gitignore` (git would
     read no `.gitignore` then, and `untracked/` would lose its line); a
     file `.claerbout/ignore` keeps out of the record, on either side
     ("kept out by .claerbout/ignore"), and that file itself, so a rewind
     to a day before the rules never lets the next render in. Left
     alone always: `untracked/` and `.claerbout/untracked.json`, compared as
     the volume compares names (`Untracked/` is `untracked/` on a Mac's
     volume, which ignores case). Every removal and every write walks from
     the project's root with `lstat`, name by name, and goes through no
     link: a folder replaced by a link meanwhile is left, and named.
     (Between a removal's walk and its unlink a few microseconds remain in
     which a folder swapped for a link would be gone through, since Node
     has no `unlinkat`; `checkout-index` itself replaces a leading link
     rather than writing through it.) The top `.gitignore` is never
     `checkout-index`'s: the rewind writes the target's itself, with the
     `/untracked/` line appended where the record would append it, to a new
     file made in the app's state folder (beside it only when that folder
     is on another volume) and renamed over the old (a rename replaces a
     link, never follows it), and one the set removes becomes that line
     alone (where the project keeps `untracked/`; elsewhere no line is
     needed, and it goes as any file does). So the working tree never
     holds a `.gitignore` without the line, not for a moment, and another app's fill meanwhile cannot take
     `untracked/` in; a fill leaves `untracked/` out by pathspec as well
     (above). The record's
     `prepared` is cleared before anything is touched, and the record
     prepares again as soon as the step ends, finished or not.
  3. **Record the rewind:** `<app>: rewind to <target>` (the full sha; for
     a partial rewind its paths in brackets, `(a.py, b.json)`, or `(3
     files)` past two), always, even when its tree equals the tip's.

  **A commit no rewind writes.** Before the save step (and in `compare`,
  so the card says so before any click), the target is checked whole,
  whatever files are ticked: git must be able to list its tree; every path
  it holds must have no empty, `.` or `..` name, not be absolute, have no
  `.git` anywhere along it (in any case, or with the code points HFS+
  ignores), and lie under no other of its entries that is a link or a
  nested repository; and every file and link it holds must be in the
  repository as a blob (`cat-file --batch-check`, which never fetches):
  not a tree object under a file's mode, and not a blob the repository
  lacks (`absent: true`; with `partial: true` in a partial clone, where the
  card says it was never fetched, and elsewhere that it was lost).
  `checkout-index` finds those out only as it writes, after it has removed
  the file it replaces. Then git checks it
  again (`read-tree <target>` into the throwaway index the write uses). The
  record never makes such a commit, so one that fails was crafted, reached
  the record some other way, or is a partial clone's: it is refused whole,
  `{refused: 'invalid', path, why, absent?, partial?}` (`path` as git
  names it, a quote or a newline included, and null when git names none),
  before anything is recorded, saved, removed or written, and its
  card says "No rewind to this commit". What comes after the checks can
  still fail (a full disk, a folder that may not be written): that is
  `failed`, below.

  Then every one of this shell's windows on the project hears `reload {id,
  paths, reason: 'rewind', to}`, `paths` every file written or removed
  (absolute), and re-reads its document if its path is among them. Answer:
  `{ok: true, from, to, target, written, removed, skipped, silent}`, `from`
  null when step 1 was skipped; a git failure in step 2 or 3 is `{refused:
  'failed', detail}`, and the next commit records whatever the folder then
  holds. The user's HEAD, branch and index are never touched: the
  throwaway index is the only index, the record's branch the only ref.
  Undo is one more rewind, to the "rewind from" commit.
- **Its events.** To the History page: `rewind {step: 'save' |
  'record-from' | 'write' | 'record-to' | 'reload', state: 'doing' |
  'done', detail?}` as the rewind goes (`save` and `reload` done with
  `{silent: [path]}` when a window did not answer), and `history {kind: 'commit',
  commits}` (the record grew), `{kind: 'refs', branches, head}` (a branch
  or HEAD moved), `{kind: 'state', state, reason}` (paused, or recording
  again), `{kind: 'focus', at}` and `{kind: 'document'}` (the window
  brought forward from another document's window). Every two seconds the shell looks at
  each project a window of its is on: the record's tip (the loose ref file,
  read; `git rev-parse` for a packed one), and with a History page open
  the branches, HEAD and the guards. The History events go to every
  History page on the project, a view's webContents as well as a
  window's; `save` and `reload` go to the document windows, a view's
  among them, whose page answers under it.
- **Two apps on one project.** Each shell writes which documents it has
  open on which project to a folder every Claerbout app shares,
  `~/Library/Application Support/Claerbout/presence/` (one file per app and
  project, `{app, pid, root, documents}`, removed when the last window
  leaves and at quit; a file whose pid is gone is ignored;
  `CLAERBOUT_PRESENCE_DIR` for a test). A rewind reads them for `others`
  and `other-app`. A rewind holds the working tree's lock (above) while it
  writes, so the other app neither rewinds nor commits meanwhile: its
  History window shows the record paused, "Plass is rewinding this
  project". When the two-second look finds another app's "rewind to" on
  the record, this shell's windows on the project hear `reload {id, paths,
  reason: 'rewind', to, app}`.

The tests (`npm run test:history`) run real git in temporary repositories
under `os.tmpdir()`: the graph with the record, a user branch and a fork,
the ties and paging; the graph scoped to one document of a course with
two lectures (each commit's scope, what a run changed beside the document,
nothing from the first fill or a rewind, a document at the top whose
folder is the project, the record's new commits scoped as they arrive,
names compared as the volume compares them); the `untracked` request
(the box as it is, refused under a guard, the folder kept and then
through a rewind to a commit from before, refused with a file in it, and
put away once empty, each recorded at the next fill); documents named by their
paths in a project reached through a link; a commit's detail and a blob, and a file past 1 MB
that is not read and costs no other file its patch; and the rewind, its
three steps and its refusals: a file that becomes a folder and a folder
that becomes a link, both ways, landing on the target's own tree; a folder
that still holds an ignored file; a write step that fails after
`.gitignore` is written, with `untracked/` still out of the next commit;
twelve crafted commits (a tree under a file's mode, a missing blob, an
empty name, and `.gitmodules` links in folders named with a quote and a
newline among them) refused before anything is recorded or touched, their
cards saying so and naming the path whole, and the graph drawing each; a
partial clone's commit whose files were never fetched, refused, nothing
fetched, and the graph and its detail drawn all the same; one rewind at a
time on a working tree, with another app's commit, rewind and card waiting
on it, and a lock whose holder is gone taken over; the new `.gitignore`
made in the state folder, never seen in the working tree or `git status`;
a file named `untracked`, and a folder named `.gitignore`, in a target,
left alone and named on the card and in the rewind, and so a file
`.claerbout/ignore` keeps out, and the file itself; another app
committing whenever `.gitignore` lacks the line during two rewinds, which
never happens, and no record commit holding `untracked/`; `Untracked/`
on a volume that ignores case; folders replaced by links during the
rewind, never gone through; and a window that does not answer save.

## The protocol

The preload exposes `window.claerbout.request(message) → Promise`,
`window.claerbout.on(event, listener) → unsubscribe` and
`window.claerbout.pathOf(file) → string` (the path of a File the page
holds, from a handle's `getFile()`, a picker or a drop: Electron's
`webUtils.getPathForFile`; `''` when Chromium has none). Requests are
answered only from the origin the shell loaded into that window.

Requests: `open` and `saveAs {name}` (the native panels; `{path}` or
`{path: null}`), `read {path}`, `write {path, text}`, `stat {path}`,
`rename {path, name}`, `remove {path}` (files by absolute path, replies
shaped like Knuth's engine's), `choose {python}` (the setup page's
answer), `status {state}` and `error {message}` (logged), `ready` (the
page is listening for a dropped document; see `openBy`), `update` and
`update {action: 'install'}` (above), `focus` (the requesting window
comes forward: shown, unminimized, focused, the app made active;
answered `{focused: true}`. A page that keeps one window per file has the
window holding a file ask this when a second launch of the file finds
it, and the launch's window closes. Since 0.2.1; an older shell answers
`null`, which is how a page tells), `document {path?, name?, size?,
modified?}` (which file this window holds now, or `path: null` for none:
the window's represented file, and the project the autosave record
follows. For a page that keeps files by handle (Plass), which sends it
whenever its open file changes: `path` from `pathOf` when the File has
one, else the handle's `name` and the File's `size` and `lastModified`,
which the shell matches against the files handles have lately touched —
Chromium asks the shell's permission handler about every read and write
of a handle, with the path but no window, and a File from a handle's
`getFile()` is blob-backed, so `pathOf` has nothing for it (both measured
2026-10-02; a dropped File has a path). Newest first, by name and the
file's size and mtime; nothing matching, or a report without the size
and mtime, is none. A `path` is taken only when it is an absolute path to
an existing regular file (a refusal is logged once). A page opened by
path never needs to. Answered `{path}`), `autosave {trigger}` (something
happened in the page worth a commit on the record, `cell run [4]`; a
notice), `history` and `history {action: 'open', at?}` without `inline`
(the History window for this window's project, made or brought forward;
answered `{opened: true}`; see "The history view"), `saved {id, ok?,
error?}` (the answer to a `save` event). A History page has requests of
its own (above).

The History page in the room, from a document page (see "The history
view"):

`history {action: 'open', inline: {x, y, width, height}, at?}`: the room's
box in the page's CSS px (its `getBoundingClientRect()`). The shell lays
the History page for this window's project over that box of the same
window, as a view, at the box times the page's zoom factor, rounded, in
DIP, and answers `{opened: true, inline: true}`; where there is no record
it opens all the same and its page says why, as the window does. A second
`open` while it is up answers the same and changes nothing (`at` still
selects a commit, by `history {kind: 'focus', at}` to the view). A box
that is not four finite numbers with a width and height is answered
`{opened: false, error}`. Since 0.2.3; an older shell answers `{opened:
true}` without `inline` and opens the window, which is how a page tells.

`history {action: 'bounds', inline: {x, y, width, height}}`: the view
moved to the room's box, in the same terms. The page sends it from a
ResizeObserver on the room, coalesced to a frame, and after a zoom step;
the window's own resize moves nothing. Answered `{ok: true}`, and `{ok:
false}` when no view is up or the box is not one.

`history {action: 'close'}`: the view removed and destroyed, from the page
(its tile pressed again) or from the History page itself (Escape, its
close tile). Answered `{closed: true}`, whether or not one was up.

`history {kind: 'inline', state: 'open' | 'closed'}`, an event to the
document page, whenever the view opens or goes, by either side or because
the window closed or its page navigated: the tile reads pressed exactly
while it is up. `history {kind: 'toggle'}`, an event to the document page
from View › History… (⇧⌘H) while the view is not up: the page does what
its tile does, so the box is the page's own.

The History page in the room asks what a History window asks (`graph`,
`commit`, `blob`, `compare`, `rewind`, `close`) and is answered the same,
for its window's project: the shell knows it by its webContents. Its
events (`history {kind: 'commit' | 'refs' | 'state' | 'focus'}`, `rewind
{step, state, detail}`) go to that webContents; a rewind's `save` and
`reload` go to the document windows, its own among them, whose page
answers under it. When the window closes or its page navigates, the view
is destroyed and the shell's listeners on the window go with it.

A request the shell does not know is logged and answered `null`.

Events: `setup {kind: 'progress' | 'failed', text}` on the setup page;
`update {state, …}` (above); `save {id, reason: 'rewind'}` (write the open
document now, and answer `saved`) and `reload {id, paths, reason:
'rewind', to, app?}` (re-read the document from disk if its path is in
`paths`: a rewind wrote or removed it), which the apps' pages answer from
a later version of each; `history {kind: 'inline' | 'toggle'}` (above);
and to the History page, `history` and `rewind` (above).

## Testing here

`npm test` runs the autosave tests (`test/autosave.test.mjs`, real git in
temporary repositories), the history view's (`test/history.test.mjs`,
likewise), the smoke test on `test/fixture`, a page with no Python that
reads its document through the shell and writes a copy beside it (and, the
fixture keeping the record, checks its `session open` commit and that
the record wrote nothing into the document's folder by itself, then
presses the page's History tile and checks the History view over its room:
at the room's box, its page given a graph with that commit and drawing it,
laid out inline, following the room when the window grows, closed by
Escape with the page told, toggled from View › History… and gone with a
reload of its page, nothing left behind; then, with `note.txt` changed
and recorded alone, the view opened again from it: the switch on "This
document" ("Its folder" left out), fewer commits drawn than the whole
project's, the session-open card ticking `note.txt` alone ("Rewind 1
file", "all 2 files" a click away, the fine print saying `note.txt` is
saved first and reloads although the temporary folder is reached through
`/var`), "Whole project" ticking both and showing the untracked/ box
unchecked (never under "This document"): ticked, `untracked/` and the
`.gitignore` line appear, unticked, both are gone; and the view opened once more on
"This document", the switch not remembered; then the History window, the
same graph, and the session-open commit's card, whose rewind's fine print
says nothing of a kernel's memory with `note.txt` open and says it once
another app's presence file lists a notebook on the project), and then the
update test: the fixture built twice under two build ids
(`CLAERBOUT_BUILD`), the first installed and updating itself to the second
from a site folder. `npm run fixture:build` packages it. All need macOS.
