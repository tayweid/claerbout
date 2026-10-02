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
  says; see below.

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
| `window` | `width`, `height`, `minWidth`, `minHeight` of a new window; the last size is remembered. `titleBarStyle`: `"default"` (the native title bar), or `"hiddenInset"` / `"hidden"`: no title bar; the page reaches the top of the window and draws the bar itself, with the traffic lights over it. Such a page marks its bar `-webkit-app-region: drag` (with `no-drag` on its controls) so the window still moves by it, and learns where the lights are from the Window Controls Overlay, `navigator.windowControlsOverlay` and CSS `env(titlebar-area-x/y/width/height)`, which the shell publishes whenever the title bar is not native and which is unset (`visible` false, the `env()` fallbacks) when it is — so one page is right under either. `trafficLightPosition`: `{x, y}` (macOS) moves the lights; the overlay's area is 2·y + 14 px tall, so a page with a 60 px bar sets y to 23. Since 0.2.1; the setup page gets the same bar. `followZoom`: `true` makes the window grow and shrink with View → Zoom In / Out / Actual Size (in one step, on its display; a maximized or fullscreen window is left alone), for a page laid out as a fixed-width paper with a margin (Plass); the page's layout then never changes with the zoom. Since 0.2.1. |
| `icon` | A PNG, 512 px or larger, relative to the config. |
| `copyright` | For the bundle's Info.plist. |
| `documentTypes` | Finder's Open With: `name`, `role`, `rank` (`Alternate` unless you mean to take the type), and `contentTypes` (UTIs) or `extensions`. |
| `site` | The URL the install line downloads from (`https://knuth.tayweid.io`); the zips and `latest.json` live at `<site>/app/`, and the app checks there for updates. |
| `elsewhere` | A sentence the install line adds when run off macOS. |
| `autosave` | `true` keeps the autosave record of every project a window is on (below). Knuth and Plass set it; ManimLive does not. |
| `smoke` | What `smoke.mjs` checks: `document` (name), `text` (contents), `ready` (a selector) and `readyText` (its text, or per mode `{uv, browser}`), `run` (a selector to click), `written` (a file expected beside the document), `json` (keys it must hold) or `contains` (text it must hold), and `autosave` (subjects the document folder's `claerbout-autosave` branch must show by the end, `["knuth: session open", "knuth: cell run [1]"]`). |

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

## The autosave record

With `"autosave": true` in the config, the shell keeps a full, unpruned
git record of every project a window is on (`autosave.js`; the spec is
Knuth's `docs/AUTOSAVE.md`): a GPX track for research. The shell is the
git runner for every app, since it has the filesystem and knows which
document each window holds; a page only says when something happened.

- A document's project is the git repository its folder is in (`git
  rev-parse --show-toplevel`). A folder in none gets one, quietly, once
  (`git init`, with `untracked/` in its `.gitignore`).
- The record is one branch per repository, `refs/heads/claerbout-autosave`,
  shared by every app on it, written with plumbing only: a temporary
  index (`GIT_INDEX_FILE`) filled by `git add -A` over the working tree,
  so `.gitignore` applies, then `write-tree`, `commit-tree` with the
  branch's tip as parent, and `update-ref`. The user's HEAD, branch,
  index and working tree are never touched. Nothing is committed while
  `.git/index.lock` exists or a merge, rebase, cherry-pick or revert is
  in progress, and nothing when the tree equals the tip's.
- Commits are `<app>: <trigger>`: `knuth: cell run [4]`, `plass: timer`,
  `knuth: session open`, `plass: session close`. The author is the
  repository's git identity when it has one, else `Claerbout Autosave
  <autosave@claerbout.local>`; commits are not signed.
- Triggers: a page's `autosave {trigger}` request (Knuth sends `cell run
  [n]` once a run's writes have landed); a one-minute timer per open
  project; `session open` when the first window on a project opens and
  `session close` when the last closes; quitting flushes.
- `untracked/` in the project, for large data, caches and scratch, is
  ignored but pinned: `.claerbout/untracked.json` lists every file in it
  with its path, size, mtime and SHA-256, rewritten before every commit
  so the manifest is inside the track. A file is hashed again only when
  its size or mtime changed; the hashes are cached under the app's state
  folder (`autosave/<project>/hashes.json`).
- Common secret files are kept out of the temporary index by pathspec,
  in every folder: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`,
  `credentials.json`, `.npmrc`, `.netrc`. Nothing scans file contents.
- The log gets one line per commit (`autosave: knuth: cell run [4] →
  <hash> (<project>)`), and one when a repository is initialised or
  `.gitignore` gains `untracked/`.
- Nothing is pushed. The spec's outside witness (the branch pushed to a
  remote on a schedule) is not built; see "Built" in Knuth's
  `docs/AUTOSAVE.md`.

`<PREFIX>_AUTOSAVE=0` turns the record off for a test;
`<PREFIX>_AUTOSAVE_INTERVAL` (seconds) sets the timer. Without git on the
machine (on a Mac, without the developer tools) the record is off and the
log says so. The tests (`npm run test:autosave`) run real git in
temporary repositories.

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
file's size and mtime; nothing matching is none. A page opened by path
never needs to. Answered `{path}`), `autosave {trigger}` (something
happened in the page worth a commit on the record, `cell run [4]`; a
notice).

A request the shell does not know is logged and answered `null`.

Events: `setup {kind: 'progress' | 'failed', text}` on the setup page;
`update {state, …}` (above).

## Testing here

`npm test` runs the autosave tests (`test/autosave.test.mjs`, real git in
temporary repositories), the smoke test on `test/fixture`, a page with no
Python that reads its document through the shell and writes a copy beside
it (and, the fixture keeping the record, checks its `session open`
commit), and then the update test: the fixture built twice under two
build ids (`CLAERBOUT_BUILD`), the first installed and updating itself to
the second from a site folder. `npm run fixture:build` packages it. All
need macOS.
