// A smoke test of a Claerbout app: launch it on a document in a throwaway
// config folder, wait for the page to say it is ready, press its "run"
// control, and check what that wrote beside the document; then check
// that quitting stops the engine (uv). What to look for comes from the
// config's `smoke` section (README.md); without one, the launch and the
// document's title are all that is checked.
//
//   node smoke.mjs --config app/knuth.json browser              # the checkout, Pyodide
//   node smoke.mjs --config app/knuth.json uv                   # the checkout, uv's Python
//   node smoke.mjs --config app/knuth.json uv path/to/Knuth.app # a built app, complete or not
//
// With one Python in the config, the mode may be left out. The uv run
// installs Python into the throwaway folder (and uv itself into
// ~/.local/bin if the machine has none), as a first launch would.

import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const at = args.indexOf('--config');
const configPath = at !== -1 ? args.splice(at, 2)[1] : null;
if (!configPath) {
  console.error('usage: node smoke.mjs --config app.json [browser|uv] [App.app]');
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const pythons = Array.isArray(config.pythons) && config.pythons.length > 0 ? config.pythons : ['uv', 'browser'];
let mode = args[0];
let bundle = args[1];
if (mode && mode.endsWith('.app')) {
  bundle = mode;
  mode = undefined;
}
mode ??= pythons.length === 1 ? pythons[0] : undefined;
if (!pythons.includes(mode)) {
  console.error(`usage: node smoke.mjs --config app.json ${pythons.join('|')} [App.app]`);
  process.exit(2);
}
const smoke = config.smoke ?? {};
const NAME = config.name;
const PREFIX = config.envPrefix;

const work = fs.mkdtempSync(path.join(os.tmpdir(), `${NAME.toLowerCase()}-smoke-${mode}-`));
const doc = path.join(work, 'docs', smoke.document ?? config.defaultDocument ?? 'document.txt');
fs.mkdirSync(path.dirname(doc));
fs.writeFileSync(doc, smoke.text ?? '');
const port = String(5400 + Math.floor(Math.random() * 400));

const app = await electron.launch({
  ...(bundle
    ? { executablePath: path.join(bundle, 'Contents', 'MacOS', NAME), args: [doc] }
    : { args: [here, doc] }),
  env: {
    ...process.env,
    ...(bundle ? {} : { CLAERBOUT_APP: path.resolve(configPath) }),
    [`${PREFIX}_CONFIG_DIR`]: path.join(work, 'config'),
    [`${PREFIX}_CHOOSE`]: mode,
    [`${PREFIX}_PORT`]: port,
  },
  // A slim app completes itself before Electron starts: allow for
  // Electron's download.
  timeout: 300_000,
});
// What a failure on a CI runner needs to say, since its log is not always
// readable: the windows, the page, its console, and the app's own log.
const consoleLines = [];
const logPath = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Logs', `${NAME}.log`)
  : path.join(work, 'config', `${NAME}.log`);
const fail = async (message) => {
  const details = [`windows: ${app.windows().map((window) => window.url()).join(', ') || 'none'}`];
  if (page) {
    details.push(`title: ${await page.title().catch(() => '?')}`);
    details.push(`page text: ${(await page.evaluate(() => document.body?.innerText ?? '').catch(() => '?')).slice(0, 400).replace(/\s+/g, ' ')}`);
  }
  if (consoleLines.length) details.push(`console: ${consoleLines.slice(-8).join(' | ')}`);
  try {
    details.push(`${path.basename(logPath)}: ${fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-8).join(' | ')}`);
  } catch {
    details.push(`${path.basename(logPath)}: not written`);
  }
  const report = `smoke (${NAME}, ${mode}): ${message}\n  ${details.join('\n  ')}`;
  console.error(report);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${report.replace(/\n/g, '%0A')}`);
  await app.close().catch(() => {});
  process.exit(1);
};

// The setup window turns into the document's once the Python is ready.
const deadline = Date.now() + 600_000;
let page = null;
while (!page && Date.now() < deadline) {
  page = app.windows().find((window) => !window.url().includes('setup.html') && window.url() !== 'about:blank') ?? null;
  if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!page) await fail('no document window');
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') consoleLines.push(`${message.type()}: ${message.text()}`);
});
page.on('pageerror', (error) => consoleLines.push(`pageerror: ${error.message}`));
if (smoke.ready) {
  const want = smoke.readyText?.[mode] ?? smoke.readyText ?? null;
  await page
    .waitForFunction(
      ([selector, text]) => {
        const element = document.querySelector(selector);
        return element !== null && (text === null || element.textContent === text);
      },
      [smoke.ready, want],
      { timeout: Math.max(1000, deadline - Date.now()) },
    )
    .catch(() => fail(`the page never became ready (${smoke.ready}${want ? ` = ${want}` : ''})`));
}
const title = await page.title();
if (title !== path.basename(doc)) await fail(`the document did not open (title: ${title})`);
if (smoke.run) {
  await page.click(smoke.run);
  if (smoke.written) {
    const written = path.join(path.dirname(doc), smoke.written);
    for (let i = 0; i < 120 && !fs.existsSync(written); i++) await page.waitForTimeout(500);
    if (!fs.existsSync(written)) await fail(`${smoke.run} wrote no ${smoke.written}`);
    const text = fs.readFileSync(written, 'utf8');
    if (smoke.json) {
      const parsed = JSON.parse(text);
      for (const [key, value] of Object.entries(smoke.json)) {
        if (JSON.stringify(parsed[key]) !== JSON.stringify(value)) await fail(`${smoke.written} holds ${text}`);
      }
    }
    if (smoke.contains && !text.includes(smoke.contains)) await fail(`${smoke.written} holds ${text}`);
  }
}

await app.close();
if (mode === 'uv') {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  let engines = '';
  try {
    engines = execFileSync('pgrep', ['-f', `serve --port ${port}`], { encoding: 'utf8' });
  } catch {
    // pgrep exits 1 when nothing matches: the engine is gone.
  }
  if (engines.trim()) {
    console.error(`smoke (${mode}): the engine outlived the app`);
    process.exit(1);
  }
}
fs.rmSync(work, { recursive: true, force: true });
console.log(`smoke (${NAME}, ${mode}${bundle ? `, ${path.basename(bundle)}` : ''}): ok`);
