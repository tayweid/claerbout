// The update test on the fixture: built twice under two build ids, the
// first installed into a scratch folder, then updating itself to the
// second from a site folder (smoke.mjs --config … update --unsaved: a
// window holding unsaved work Cancels the first relaunch, which stops
// after the install; the second goes through).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = path.join(here, 'fixture', 'app.json');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claerbout-update-'));
const bundle = path.join(work, 'Fixture.app');
const site = path.join(work, 'site');
const quiet = { stdio: ['ignore', 'ignore', 'inherit'] };
try {
  execFileSync(process.execPath, [path.join(here, '..', 'package.mjs'), '--config', config, '--arch', 'arm64', '--install', bundle], {
    ...quiet,
    env: { ...process.env, CLAERBOUT_BUILD: 'first' },
  });
  execFileSync(process.execPath, [path.join(here, '..', 'package.mjs'), '--config', config, '--arch', 'arm64', '--zip', path.join(site, 'app')], {
    ...quiet,
    env: { ...process.env, CLAERBOUT_BUILD: 'second' },
  });
  execFileSync(process.execPath, [path.join(here, '..', 'smoke.mjs'), '--config', config, 'update', '--unsaved', bundle, site], { stdio: 'inherit' });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
