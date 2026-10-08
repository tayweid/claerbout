// No page is zoomed by Chromium (holdZoom in main.js): the fixture, which
// has no `window.zoom`, has no zoom items in its View menu and a level set
// on its page is put back at the next load; the same fixture with
// `window.zoom: "page"` has them, and each tells the page a `zoom` event
// while the page stays at zoom 1. Since 0.2.11.
//
//   node test/zoom.mjs
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.join(here, '..');
const fixture = path.join(here, 'fixture');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claerbout-zoom-'));
const docs = path.join(work, 'docs');
fs.mkdirSync(docs);
const note = path.join(docs, 'note.txt');
fs.writeFileSync(note, 'note\n');

// The fixture's config, with paths made absolute so it can live in `work`.
const base = JSON.parse(fs.readFileSync(path.join(fixture, 'app.json'), 'utf8'));
function configWith(window) {
  const config = { ...base, web: path.join(fixture, base.web), icon: path.join(fixture, base.icon), setupPage: base.setupPage, window: { ...base.window, ...window } };
  const file = path.join(work, `app-${Object.keys(window).join('-') || 'plain'}.json`);
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

let failed = false;
const check = (ok, message) => {
  if (!ok) {
    failed = true;
    console.error(`zoom: FAIL ${message}`);
  }
};

async function run(name, window, body) {
  const env = {
    ...process.env,
    CLAERBOUT_APP: configWith(window),
    FIXTURE_CONFIG_DIR: path.join(work, `config-${name}`),
    FIXTURE_CHOOSE: 'browser',
    FIXTURE_AUTOSAVE_INTERVAL: '3600',
    CLAERBOUT_UV_DIR: path.join(work, 'uv-claerbout'),
    CLAERBOUT_PRESENCE_DIR: path.join(work, 'presence'),
  };
  const app = await electron.launch({ args: [shellDir, note], env, timeout: 120_000 });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('load');
    await body(app, page);
  } finally {
    await app.close().catch(() => {});
  }
}

const viewItems = (app) =>
  app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu().items.find((item) => item.label === 'View');
    return view.submenu.items.filter((item) => item.visible && item.type !== 'separator').map((item) => item.label || item.role);
  });
const zoomFactor = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());

await run('plain', {}, async (app, page) => {
  const items = await viewItems(app);
  check(!items.some((label) => /zoom|actual size/i.test(label)), `the View menu without window.zoom has ${JSON.stringify(items)}`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomLevel(2));
  check((await zoomFactor(app)) > 1, 'setZoomLevel(2) did not zoom the page (the check below would prove nothing)');
  await page.reload();
  await page.waitForLoadState('load');
  await page.waitForTimeout(250);
  check((await zoomFactor(app)) === 1, `after a reload the page is at zoom ${await zoomFactor(app)}, not 1`);
  console.log('zoom: without window.zoom, no zoom items, and a zoomed page is put back to 1 at its next load');
});

await run('page', { zoom: 'page' }, async (app, page) => {
  const items = await viewItems(app);
  for (const label of ['Actual Size', 'Zoom In', 'Zoom Out']) check(items.includes(label), `the View menu with window.zoom "page" lacks ${label}: ${JSON.stringify(items)}`);
  await page.evaluate(() => {
    window.__zooms = [];
    window.claerbout.on('zoom', (detail) => window.__zooms.push(detail.step));
  });
  for (const label of ['Zoom In', 'Zoom In', 'Zoom Out', 'Actual Size']) {
    await app.evaluate(({ Menu, BrowserWindow }, wanted) => {
      const view = Menu.getApplicationMenu().items.find((item) => item.label === 'View');
      view.submenu.items.find((item) => item.label === wanted && item.visible).click(undefined, BrowserWindow.getAllWindows()[0]);
    }, label);
  }
  await page.waitForTimeout(250);
  const heard = await page.evaluate(() => window.__zooms);
  check(JSON.stringify(heard) === '[1,1,-1,0]', `the page heard ${JSON.stringify(heard)}, not [1,1,-1,0]`);
  check((await zoomFactor(app)) === 1, `the menu zoomed the page to ${await zoomFactor(app)}`);
  console.log('zoom: with window.zoom "page", the View menu tells the page {step} and zooms nothing');
});

fs.rmSync(work, { recursive: true, force: true });
if (failed) process.exit(1);
console.log('zoom: ok');
