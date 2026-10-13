import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, access, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rustPageFixture } from '../test-support/display-dom.mjs';

// External peers exercise real pipes and process events without a server or provider.
async function peer(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'wi-display-peer-'));
  const metadata = join(root, 'owned.json');
  const executable = join(root, 'peer.mjs');
  await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
fs.writeFileSync(${JSON.stringify(metadata)}, JSON.stringify({ pid: process.pid, sandbox: process.cwd(), home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME, codex: process.env.CODEX_HOME }));
const mode = ${JSON.stringify(mode)};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (mode === 'early0' || mode === 'early7') process.exit(mode === 'early0' ? 0 : 7);
if (mode === 'bad-start') { process.stdout.write('{invalid\\n'); setInterval(() => {}, 1000); }
else {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', line => {
    const request = JSON.parse(line);
    if (!request.command) {
      if (mode === 'stdin') { lines.close(); process.stdin.destroy(); fs.closeSync(0); }
      if (mode === 'cleanup') { fs.mkdirSync('locked'); fs.writeFileSync('locked/owned', 'synthetic'); fs.chmodSync('locked', 0); }
      const ready = { protocol: 1, event: 'ready', id: request.id, origin: 'http://127.0.0.1:1' };
      if (mode === 'bad-ready') process.stdout.write(JSON.stringify(ready) + '\\n{invalid\\n');
      else send(ready);
      if (mode === 'ready-close') process.stdout.end(() => process.exit(0));
      if (mode === 'stdin') setInterval(() => {}, 1000);
    } else {
      if (mode === 'stop-close') process.exit(7);
      if (mode === 'bad-stop') { process.stdout.write('{invalid\\n'); return; }
      send({ protocol: 1, event: 'stopped', id: request.id, cleaned: mode !== 'unclean' });
      if (mode === 'stderr') process.stderr.write('synthetic peer failure\\n');
      if (mode === 'truncated') process.stdout.write('{');
      process.stdout.end(() => process.exit(mode === 'stop7' ? 7 : 0));
    }
  });
}
`, { mode: 0o700 });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { executable, async owned() { return JSON.parse(await readFile(metadata, 'utf8')); } };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function closed(owned) {
  assert.equal(alive(owned.pid), false, 'owned peer must be reaped');
  await assert.rejects(access(owned.sandbox), { code: 'ENOENT' });
}
async function promptFailure(action) {
  const start = performance.now();
  await assert.rejects(action, error => {
    assert.match(error.message, /^synthetic Rust fixture (failed|cleanup failed)$/);
    return true;
  });
  assert.ok(performance.now() - start < 2000, 'terminal failure must reject before the control deadline');
}

test('C fixture healthy Start Stop exit0 removes its owned sandbox', async t => {
  const p = await peer(t, 'healthy');
  const fixture = await rustPageFixture(p.executable);
  const owned = await p.owned();
  assert.equal(fixture.pid, owned.pid);
  assert.equal(owned.home, owned.sandbox); assert.equal(owned.xdg, owned.sandbox); assert.equal(owned.codex, owned.sandbox);
  assert.equal(fixture.origin, 'http://127.0.0.1:1');
  await fixture.stop();
  await closed(owned);
});
for (const mode of ['early0', 'early7', 'bad-start']) test(`C fixture ${mode} rejects pending Start promptly and reaps`, async t => {
  const p = await peer(t, mode);
  await promptFailure(() => rustPageFixture(p.executable));
  await closed(await p.owned());
});
test('C fixture Ready followed by malformed bytes in one write cannot pass startup', async t => {
  const p = await peer(t, 'bad-ready');
  let fixture;
  t.after(async () => { if (fixture) await fixture.stop().catch(() => {}); });
  await promptFailure(async () => { fixture = await rustPageFixture(p.executable); });
  await closed(await p.owned());
});
test('C fixture Ready then early close rejects subsequent Stop without a deadline', async t => {
  const p = await peer(t, 'ready-close');
  const fixture = await rustPageFixture(p.executable);
  const owned = await p.owned();
  const start = performance.now();
  while (alive(owned.pid) && performance.now() - start < 2000) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(alive(owned.pid), false);
  await promptFailure(() => fixture.stop());
  await promptFailure(() => fixture.stop());
  await closed(owned);
});
for (const mode of ['stop-close', 'bad-stop', 'stdin']) test(`C fixture ${mode} rejects pending and later Stop promptly with owned cleanup`, async t => {
  const p = await peer(t, mode);
  const fixture = await rustPageFixture(p.executable);
  const owned = await p.owned();
  await promptFailure(() => fixture.stop());
  await promptFailure(() => fixture.stop());
  await closed(owned);
});
test('C fixture missing executable rejects spawn safely and removes startup sandbox', async () => {
  const sandboxes = async () => (await readdir(tmpdir())).filter(name => name.startsWith('wi-display-browser-')).sort();
  const before = await sandboxes();
  await promptFailure(() => rustPageFixture(join(tmpdir(), 'wi-display-missing-executable', 'not-present')));
  assert.deepEqual(await sandboxes(), before);
});
test('C fixture close rejects all pending Stop waits with one terminal error', async t => {
  const p = await peer(t, 'stop-close');
  const fixture = await rustPageFixture(p.executable);
  const owned = await p.owned();
  const start = performance.now();
  const errors = await Promise.all([fixture.stop().catch(error => error), fixture.stop().catch(error => error)]);
  assert.equal(errors[0].message, 'synthetic Rust fixture failed');
  assert.equal(errors[1], errors[0]);
  assert.ok(performance.now() - start < 2000);
  await promptFailure(() => fixture.stop());
  await closed(owned);
});
test('C fixture cleanup failure cannot become a clean Stop', async t => {
  const p = await peer(t, 'cleanup');
  const fixture = await rustPageFixture(p.executable);
  const owned = await p.owned();
  t.after(async () => { await chmod(join(owned.sandbox, 'locked'), 0o700); await rm(owned.sandbox, { recursive: true, force: true }); });
  await promptFailure(() => fixture.stop());
  assert.equal(alive(owned.pid), false);
  await access(owned.sandbox);
});
for (const mode of ['unclean', 'stop7', 'stderr', 'truncated']) test(`C fixture ${mode} teardown remains a failure and reaps`, async t => {
  const p = await peer(t, mode);
  const fixture = await rustPageFixture(p.executable);
  const owned = await p.owned();
  await promptFailure(() => fixture.stop());
  await closed(owned);
});
