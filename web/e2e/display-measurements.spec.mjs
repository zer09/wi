import { test, expect, chromium } from '@playwright/test';
import { browserPin, browserLaunchOptions } from '../test-support/browser-pin.mjs';
import { readFile, writeFile, mkdir, rm, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { discoverFixture } from '../test-support/fixture.mjs';
import { nativeBinding, createRestartRoot, rootProof, terminalProof } from '../test-support/restart-display.mjs';
import { sid, head, title, facts, previous, digest, seedLegacy, snapshot, legacyProof, upgradedProof, catalogProof,
  expectedPage, pageProof, domProof, sameDom, newRecord, newFaults, observerWork, handleFacts, boundary, publicPrivacy } from '../test-support/upgrade-display-parity.mjs';
import { displayedBlock, normalizedDom } from '../test-support/rich-display-parity.mjs';
import { measurementCollector, installColdObserver, coldProof, identity, retirement, memoryProbe, sampler, memorySummary,
  resources, acquireResource, acquireObserver, sourceGuard } from '../test-support/display-measurements.mjs';

async function exact(locator, value) { await expect(locator).toHaveCount(1); await expect.poll(async () => (await locator.textContent()) === value).toBe(true); }

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('finite original cold warm older transport and qualified owned Linux memory measurements', async ({}, testInfo) => {
  const owned = resources(() => { firstFailure ??= freeze(); }), record = newRecord(), faults = newFaults(), assetReads = [];
  let fixture, observer, server, browser, context, probe, sampling, network, seed, held, nativeIdentity, browserIdentity;
  let nativeRetired = [], browserRetired = [], rootRemoved = false, fallback = false, phase = 'preflight', firstFailure = null;
  let transport, coldDom, memory, newestDom, geometry, binding, browserVersion, evidenceRoot, evidenceOwned = false, executable;
  const publicationFailures = [];
  async function save(name, value) {
    if (!evidenceOwned) return;
    try { await writeFile(join(evidenceRoot, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }
    catch (error) { publicationFailures.push(name); throw error; }
  }
  const freeze = () => ({ phase, network: network?.facts() ?? null,
    counts: { latest: record.snapshots.length, streams: record.streams.length, older: record.older.length }, faults: { ...faults } });
  try {
    browserLaunchOptions();
    evidenceRoot = process.env.WI_C52_EVIDENCE ?? testInfo.outputPath('c52-evidence');
    if (!isAbsolute(evidenceRoot)) throw new Error('Evidence directory rejected');
    // Exclusive reservation prevents even failure reporting from touching historical or unowned output.
    await mkdir(evidenceRoot, { mode: 0o700 }); evidenceOwned = true;
    await save('C52.once.json', { consumed: true });
    sourceGuard(await readFile(new URL(import.meta.url), 'utf8'), await readFile(new URL('../test-support/display-measurements.mjs', import.meta.url), 'utf8'));
    executable = process.env.WI_C3A_FIXTURE;
    if (executable === undefined) {
      executable = await discoverFixture();
      process.env.WI_C3A_FIXTURE = executable;
    }
    binding = await nativeBinding(executable);
    fixture = await acquireResource(owned, 'root', 90, () => {
      const parent = process.env.WI_BROWSER_FIXTURE_PARENT;
      if (parent === undefined) throw new Error('Browser fixture parent required');
      return createRestartRoot(parent);
    }, async value => {
      await rootProof(value, 'observe');
      if (owned.cleanupFailed() || fallback || handleFacts().active || handleFacts().opens !== handleFacts().closes
        || observer && (!nativeRetired.length || nativeRetired.some(i => !['absent', 'reused'].includes(i.retirement)))
        || server && (!browserRetired.length || browserRetired.some(i => !['absent', 'reused'].includes(i.retirement)))) throw new Error('Root retained');
      if (held) { upgradedProof(snapshot(value), seed, held); catalogProof(value); }
      await rm(value.root, { recursive: true });
      try { await lstat(value.root); } catch (error) { if (error.code === 'ENOENT') rootRemoved = true; }
      expect(rootRemoved).toBe(true);
    });
    phase = 'seed'; seed = await seedLegacy(fixture); legacyProof(snapshot(fixture), seed); catalogProof(fixture);
    await save('SEED.json', { version: 2, head, projection_tables: 0, canonical: digest(JSON.stringify(seed.canonical)),
      definitions: digest(JSON.stringify(seed.definitions)), fixture_hashes: seed.fixture_hashes, handles: handleFacts(), actual_tool_executions: 0 });
    phase = 'native-acquisition'; expect(await nativeBinding(executable)).toEqual(binding);
    observer = await acquireResource(owned, 'native-stop', 60, () => acquireObserver(binding, fixture), async value => { await value.stop(); });
    owned.register('native-emergency', 65, async () => {
      if (!observer.evidence().closed || !observer.evidence().input_ended) {
        try { await observer.emergency(); } finally { fallback ||= observer.evidence().fallback; }
      }
    });
    owned.register('native-retirement', 70, async () => {
      const known = nativeIdentity ?? observer.evidence().identity;
      if (!known || known.state !== 'present') { nativeRetired = [{ pid: observer.pid, retirement: 'unknown' }]; throw new Error('Native identity unknown'); }
      nativeRetired = [await retirement(known)]; expect(['absent', 'reused']).toContain(nativeRetired[0].retirement);
    });
    nativeIdentity = await observer.initialize(); legacyProof(snapshot(fixture), seed);
    phase = 'browser-server-acquisition';
    server = await acquireResource(owned, 'browser-server-close', 40,
      () => chromium.launchServer({ host: '127.0.0.1', headless: true, ...browserLaunchOptions() }), value => value.close());
    owned.register('browser-emergency', 41, async () => {
      if (!browserIdentity) return;
      const current = await retirement(browserIdentity);
      if (current.retirement === 'alive') { fallback = true; await server.kill(); }
    });
    owned.register('browser-retirement', 50, async () => {
      const known = probe?.known() ?? (browserIdentity ? [browserIdentity] : []);
      if (!known.length) { browserRetired = [{ pid: server.process()?.pid, retirement: 'unknown' }]; throw new Error('Browser identity unknown'); }
      await expect.poll(async () => {
        browserRetired = await Promise.all(known.map(i => retirement(i)));
        return browserRetired.every(i => ['absent', 'reused'].includes(i.retirement));
      }).toBe(true);
    });
    browserIdentity = await identity(server.process().pid);
    expect(browserIdentity.state).toBe('present'); expect(browserIdentity.ppid).toBe(process.pid);
    phase = 'browser-connect';
    browser = await acquireResource(owned, 'browser-connection-close', 30, () => chromium.connect(server.wsEndpoint()), value => value.close());
    browserVersion = browser.version(); expect(browserVersion).toBe(browserPin.version);
    phase = 'context-acquisition';
    context = await acquireResource(owned, 'context-close', 20,
      () => browser.newContext({ serviceWorkers: 'block', viewport: { width: 1000, height: 700 } }), value => value.close());
    context.setDefaultTimeout(10_000); context.setDefaultNavigationTimeout(10_000);
    network = measurementCollector({ origin: observer.origin, owner: fixture.owner, record, faults, assetReads });
    await context.route('**/*', network.route);
    context.on('request', network.request); context.on('response', network.response); context.on('requestfinished', network.finished);
    const page = await context.newPage(); page.on('console', () => faults.console++); page.on('pageerror', () => faults.page++);
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
    const heading = page.getByRole('heading', { name: 'Canonical session title', exact: true });
    const run = index => transcript.locator(`.run[data-run="${facts[index].run}"]`);
    async function display(index) {
      await expect(run(index)).toHaveCount(1);
      await expect.poll(async () => { try { return domProof(await displayedBlock(run(index)), index); } catch { return false; } }).toBe(true);
      return normalizedDom(run(index));
    }
    phase = 'fresh-page'; await page.goto(`${observer.origin}/#session=${sid}`);
    await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue(''); await expect(page.getByLabel('Task', { exact: true })).toHaveValue('');
    await expect(page.locator('.run,.command')).toHaveCount(0); expect(record.requests.every(q => !q.path.startsWith('/v1/'))).toBe(true);
    await boundary(page, context, fixture.owner);
    probe = memoryProbe(nativeIdentity, browserIdentity);
    sampling = await acquireResource(owned, 'sampler-stop', 10, () => sampler(probe), value => value.stop());
    sampling.start(); await sampling.sample('baseline');
    phase = 'cold'; network.begin('cold'); await sampling.sample('before-cold');
    await page.evaluate(installColdObserver, { title, run: facts[1].run });
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue('');
    await expect.poll(() => network.ready('cold')).toBe(true);
    newestDom = await display(1); await exact(heading, title); await expect(transcript.locator('.run')).toHaveCount(1);
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    coldDom = coldProof(await page.evaluate(() => { const value = globalThis.__c52Cold.finish(); delete globalThis.__c52Cold; return value; }));
    await sampling.sample('after-cold'); record.newest = true;
    held = snapshot(fixture); upgradedProof(held, seed); catalogProof(fixture); expect(record.older.length).toBe(0);
    publicPrivacy(expectedPage(1), fixture.owner); pageProof(expectedPage(1), 1); await observer.sample();
    phase = 'warm'; network.begin('warm'); await sampling.sample('before-warm');
    await page.getByRole('button', { name: 'Reconnect latest', exact: true }).click();
    await expect.poll(() => network.ready('warm')).toBe(true);
    await display(1); await exact(heading, title); await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    sameDom(await normalizedDom(run(1)), newestDom); await expect(transcript.locator('.run')).toHaveCount(1);
    await sampling.sample('after-warm'); upgradedProof(snapshot(fixture), seed, held); expect(record.older.length).toBe(0); await observer.sample();
    phase = 'older-setup'; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await transcript.evaluate(n => n.scrollHeight > n.clientHeight)).toBe(true);
    await transcript.evaluate(n => { n.scrollTop = 0; }); await transcript.focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    geometry = await transcript.evaluate(n => ({ focused: document.activeElement === n, top: n.scrollTop, height: n.scrollHeight, viewport: n.clientHeight }));
    expect(geometry.focused && geometry.top >= 0 && geometry.top <= 96 && geometry.height > geometry.viewport).toBe(true);
    expect(record.older.length).toBe(0); record.setup_reads = 0; record.prekey = geometry;
    phase = 'older'; network.begin('older'); await sampling.sample('before-older'); record.intent = true;
    await page.keyboard.press('Home'); await expect.poll(() => network.ready('older')).toBe(true);
    await display(0); domProof(await displayedBlock(run(1)), 1); sameDom(await normalizedDom(run(1)), newestDom);
    expect(await transcript.locator('.run').evaluateAll(ns => ns.map(n => n.dataset.run))).toEqual(facts.map(f => f.run));
    expect(record.older[0].request.url()).toBe(`${observer.origin}/v1/sessions/${sid}/conversation?before=${encodeURIComponent(previous)}`);
    await sampling.sample('after-older'); upgradedProof(snapshot(fixture), seed, held); catalogProof(fixture); await observer.sample();
    phase = 'privacy'; await boundary(page, context, fixture.owner); await expect(page.locator('.command')).toHaveCount(0);
    await expect(page.getByLabel('Task', { exact: true })).toHaveValue(''); await Promise.all(assetReads); await network.drain();
    transport = network.proof(); expect(record.snapshots.length).toBe(2); expect(record.streams.length).toBe(2); expect(record.older.length).toBe(1);
    expect(record.assets.size).toBe(9); expect(record.requests.every(q => q.method === 'GET')).toBe(true); expect(Object.values(faults).every(n => n === 0)).toBe(true);
    phase = 'cleanup';
  } catch (error) {
    firstFailure = freeze(); owned.fail(error);
    try { await save('FAILURE_BEFORE_CLEANUP.json', firstFailure); } catch (publication) { owned.fail(publication); }
  } finally {
    const cleanup = await owned.cleanup();
    if (network) {
      try { await network.drain(); } catch (error) { cleanup.error ??= error; firstFailure ??= freeze(); }
    }
    if (!cleanup.error) {
      try {
        expect(fallback).toBe(false); terminalProof(observer.evidence(), false); observerWork(observer.evidence().samples);
        memory = memorySummary(probe, sampling.facts());
      } catch (error) { cleanup.error = error; firstFailure ??= freeze(); }
    }
    const bindingAfter = binding ? await nativeBinding(executable).catch(() => null) : null;
    const cleanupFacts = { pass: !cleanup.error && rootRemoved && !fallback, steps: cleanup.steps, fallback, root_removed: rootRemoved,
      native: observer?.evidence() ?? null, native_retirement: nativeRetired, browser_identity: browserIdentity ?? null,
      browser_retirement: browserRetired, sampler: sampling?.facts() ?? null, handles: handleFacts(), faults,
      binding_unchanged: JSON.stringify(bindingAfter) === JSON.stringify(binding), first_failure: firstFailure, publication_failures: publicationFailures };
    try { await save('CLEANUP.json', cleanupFacts); } catch (error) { cleanup.error ??= error; firstFailure ??= freeze(); }
    try { await save('MEASUREMENTS.json', { transport: transport ?? network?.facts() ?? null, cold_dom: coldDom ?? null, memory: memory ?? null,
      original_api_body_read: false, helper_http_reads: 0, expected_independent: { head, schema: 3, runs: 2, entries: 6, fields: 8, chunks: 8,
        pages: [digest(JSON.stringify(expectedPage(1))), digest(JSON.stringify(expectedPage(0)))], dom: newestDom ? digest(newestDom) : null }, geometry: geometry ?? null,
      definitions: { cold: 'First original Latest includes explicit open, migration, validation, encoding, transport, browser and harness; not SQL-only or CPU.',
        warm: 'Explicit Reconnect latest transport and post-response DOM verification only; retained B/title is not installation timing.',
        older: 'One genuine near-top Home Before A. No helper API body evidence.', sse: 'Two original header handshakes only, no completion/size/live-change latency.' } });
    } catch (error) { cleanup.error ??= error; firstFailure ??= freeze(); }
    try { await save('BROWSER_RESULT.json', { status: !cleanup.error && cleanupFacts.pass && cleanupFacts.binding_unchanged ? 'PASS' : 'FAILED', fresh_cases: 1,
      counts: { latest: record.snapshots.length, sse: record.streams.length, before: record.older.length, setup_before: record.setup_reads, mutations: record.requests.filter(q => q.method !== 'GET').length },
      chromium: browserVersion ?? null, first_failure: firstFailure, cleanup: cleanupFacts.pass, no_retry: true, binding, binding_after: bindingAfter,
      publication_failures: publicationFailures });
    } catch (error) { cleanup.error ??= error; firstFailure ??= freeze(); }
    if (cleanup.error || !cleanupFacts.pass || !cleanupFacts.binding_unchanged) throw new Error('C52 measurement case failed; sanitized evidence saved');
  }
});
