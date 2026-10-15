// Chromium's spellchecker runs in every window, as in a browser tab (the
// page's `spellcheck` attribute decides what is checked): a misspelling
// typed into the fixture's editable line is marked, and the shell's
// right-click menu on it (spellingMenu in main.js) leads with Chromium's
// suggestions, the first of which replaces the word, then Add to
// Dictionary, then Cut, Copy and Paste. A right-click on a correct word in
// editable text has the three alone; one on the page's plain text has
// Copy (Chromium on a Mac selects the word under a right-click, as Chrome
// does); one on the page's empty room shows nothing. Since 0.2.13.
//
//   node test/spellcheck.mjs
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.join(here, '..');
const fixture = path.join(here, 'fixture');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claerbout-spellcheck-'));
const docs = path.join(work, 'docs');
fs.mkdirSync(docs);
const note = path.join(docs, 'note.txt');
fs.writeFileSync(note, 'note\n');

// The fixture's config, with paths made absolute so it can live in `work`.
const base = JSON.parse(fs.readFileSync(path.join(fixture, 'app.json'), 'utf8'));
const configFile = path.join(work, 'app.json');
fs.writeFileSync(configFile, JSON.stringify({ ...base, web: path.join(fixture, base.web), icon: path.join(fixture, base.icon) }));

let failed = false;
const check = (ok, message) => {
  if (!ok) {
    failed = true;
    console.error(`spellcheck: FAIL ${message}`);
  }
};

const env = {
  ...process.env,
  CLAERBOUT_APP: configFile,
  FIXTURE_CONFIG_DIR: path.join(work, 'config'),
  FIXTURE_CHOOSE: 'browser',
  FIXTURE_AUTOSAVE_INTERVAL: '3600',
  CLAERBOUT_UV_DIR: path.join(work, 'uv-claerbout'),
  CLAERBOUT_PRESENCE_DIR: path.join(work, 'presence'),
};
const app = await electron.launch({ args: [shellDir, note], env, timeout: 120_000 });
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('load');
  // The menus the shell pops are caught here instead of shown: what the
  // test reads is their items, and it presses the first one itself.
  await app.evaluate(({ Menu }) => {
    global.__popped = [];
    Menu.prototype.popup = function () {
      global.__popped.push(this);
    };
  });
  // Items by label (a role item has Electron's label for it: Cut, Copy,
  // Paste), a separator by its type.
  const popped = () => app.evaluate(() => global.__popped.map((menu) => menu.items.map((item) => item.label || item.type)));
  const rectOf = (word) =>
    page.evaluate((wanted) => {
      const walker = document.createTreeWalker(document.getElementById('room'), NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const at = node.data.indexOf(wanted);
        if (at === -1) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        const box = range.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
      return null;
    }, word);
  const rightClick = async (word) => {
    const at = await rectOf(word);
    check(at !== null, `"${word}" is not on the page`);
    if (!at) return;
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.waitForTimeout(400);
  };

  // A misspelling, marked once typing pauses.
  await page.click('#prose');
  await page.keyboard.press('End');
  await page.keyboard.type(' spellng ');
  await page.waitForTimeout(1500);
  await rightClick('spellng');
  let menus = await popped();
  check(menus.length === 1, `a right-click on the misspelling popped ${menus.length} menus`);
  const items = menus[0] ?? [];
  const first = items[0];
  check(first && !['separator', 'Add to Dictionary', 'No Guesses Found', 'Cut'].includes(first), `no suggestion leads the menu: ${JSON.stringify(items)}`);
  check(items.includes('Add to Dictionary'), `the menu lacks Add to Dictionary: ${JSON.stringify(items)}`);
  check(JSON.stringify(items.slice(-3)) === '["Cut","Copy","Paste"]', `the menu does not end with Cut, Copy, Paste: ${JSON.stringify(items)}`);
  // The first suggestion replaces the word on the page.
  await app.evaluate(() => global.__popped[0].items[0].click());
  await page.waitForTimeout(300);
  const text = await page.evaluate(() => document.getElementById('prose').textContent);
  check(!text.includes('spellng') && text.includes(first ?? '\0'), `after "${first}" the line reads ${JSON.stringify(text)}`);
  console.log(`spellcheck: "spellng" marked, the menu offered ${JSON.stringify(items)}, "${first}" replaced it`);

  // A correct word in editable text: the roles alone.
  await app.evaluate(() => { global.__popped = []; });
  await rightClick('line');
  menus = await popped();
  check(JSON.stringify(menus) === '[["Cut","Copy","Paste"]]', `a right-click on a correct word popped ${JSON.stringify(menus)}`);

  // Plain text: the word under the click is selected, and Copy offered.
  await app.evaluate(() => { global.__popped = []; });
  await rightClick('Python');
  menus = await popped();
  check(JSON.stringify(menus) === '[["Copy"]]', `a right-click on plain text popped ${JSON.stringify(menus)}`);

  // The empty room: nothing.
  await app.evaluate(() => { global.__popped = []; });
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const room = await page.evaluate(() => {
    const box = document.getElementById('room').getBoundingClientRect();
    return { x: box.right - 24, y: box.bottom - 24 };
  });
  await page.mouse.click(room.x, room.y, { button: 'right' });
  await page.waitForTimeout(400);
  menus = await popped();
  check(menus.length === 0, `a right-click on the empty room popped ${JSON.stringify(menus)}`);
  console.log('spellcheck: a correct word offers Cut, Copy and Paste; plain text Copy; the empty room nothing');
} finally {
  await app.close().catch(() => {});
}

fs.rmSync(work, { recursive: true, force: true });
if (failed) process.exit(1);
console.log('spellcheck: ok');
