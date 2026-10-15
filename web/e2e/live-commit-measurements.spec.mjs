import { test, expect, chromium } from '@playwright/test';
import { readFile, writeFile, rm, rmdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRoot, rootProof, launchNative, nativeBinding, terminalProof, removeRoot, texts, telemetryProof } from '../test-support/live-commit-native.mjs';
import { resources, acquireResource, identity, retirement } from '../test-support/display-measurements.mjs';
import { browserTree, retireTree } from '../test-support/content-measurements.mjs';
import { boundary } from '../test-support/interrupted-display-parity.mjs';
import { allocationProgress, resolveAllocation, allocationProof, removeAllocation, resolveBinding, reserveOutput, modesProof, browserProgram, browserProof, phaseDrive, liveCollector, diagnostics, newFaults, sourceGuard } from '../test-support/live-commit-measurements.mjs';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('one genuine Task live append, authoritative replacement and terminal commit measurements', async ({}, testInfo) => {
  let output, binding, fixture, native, server, browser, context, network, browserIdentity;
  let bodySucceeded = false, rootRemoved = false, finalDiscovery = false, fallback = false, browserVersion = null;
  let nativeRetired = [], browserRetired = [], browserMembers = [], treeFacts = [], nativeMeasurement = null, browserMeasurement = null;
  let first, appended, authority, terminal, bindingUnchanged = false;
  const faults = newFaults(), preparationFailures = [], publicationFailures = [];
  const diagnostic = diagnostics(() => network?.facts()), operation = diagnostic.operation;
  const owned = resources(() => diagnostic.freeze('cleanup'));
  const allocation = allocationProgress();
  function collectorProof() {
    if (!network) throw new Error('Collector unavailable');
    if (bodySucceeded) network.proof(); else network.cleanupProof();
    if (Object.values(faults).some(n => n !== 0)) throw new Error('Collector rejected');
  }
  async function save(name, value) {
    if (!output) return;
    let bytes;
    try { bytes = JSON.stringify(value, null, 2) + '\n'; }
    catch (error) { publicationFailures.push({ artifact: name, phase: 'serialization' }); throw error; }
    try { await writeFile(join(output, name), bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { publicationFailures.push({ artifact: name, phase: 'write' }); throw error; }
  }
  async function discoverOwned() {
    let tree;
    try { tree = await browserTree(browserIdentity); }
    catch (error) { diagnostic.discoveryRejected(); throw error; }
    treeFacts.push({ members: tree.members.length, errors: tree.errors });
    if (Object.values(tree.errors).some(n => n !== 0)) throw new Error('Browser discovery rejected');
    for (const member of tree.members) if (!browserMembers.some(i => i.pid === member.pid && i.start_ticks === member.start_ticks)) browserMembers.push(member);
  }
  try {
    sourceGuard(await readFile(new URL(import.meta.url), 'utf8'), await readFile(new URL('../test-support/live-commit-measurements.mjs', import.meta.url), 'utf8'));
    binding = await operation('binding', () => resolveBinding(process.env));
    await operation('allocation', () => resolveAllocation(process.env, allocation));
    owned.register('allocation-parent', 95, () => operation('allocation_cleanup', () => removeAllocation(allocation, process.env.TMPDIR,
      { root_removed: rootRemoved, prior_cleanup_safe: !owned.cleanupFailed() }, { rmdir: async path => {
        await network.drain(); collectorProof();
        return rmdir(path);
      } })));
    output = await operation('output', () => reserveOutput(testInfo, process.env));
    fixture = await operation('root', () => acquireResource(owned, 'root', 90, async () => {
      allocation.nested = 'partial_unknown';
      const value = await createRoot(allocation.path);
      allocation.nested = 'acquired'; allocation.phase = 'nested_fixture_acquired'; return value;
    }, value => operation('root_cleanup', async () => {
      if (!bodySucceeded || !finalDiscovery || fallback || owned.cleanupFailed() || !native || !browserRetired.length
        || [...nativeRetired, ...browserRetired].some(i => !['absent', 'reused'].includes(i.retirement))) throw new Error('Root retained');
      const facts = native.evidence(); terminalProof(facts);
      await modesProof(value.root);
      await allocationProof(allocation.identity, process.env.TMPDIR);
      // A checks binding, root identity and native retirement before invoking this final callback.
      await removeRoot(value, [facts], binding, { remove: async (path, options) => {
        await network.drain(); collectorProof();
        // No await or fallible work can intervene between the final proof and rm admission.
        return rm(path, options);
      } });
      try { await lstat(value.root); } catch (error) { if (error.code === 'ENOENT') rootRemoved = true; else throw error; }
      expect(rootRemoved).toBe(true);
    })));
    native = await operation('native', () => acquireResource(owned, 'native-stop', 60, () => launchNative({ fixture, binding, onDiagnostic: diagnostic.native }), value => operation('native_stop', () => value.stop())));
    owned.register('native-abandon', 65, () => operation('native_abandon', async () => {
      const value = native.evidence(); fallback ||= value.fallback;
      if (!value.closed || !value.input_ended) { try { await native.abandon(); } finally { fallback ||= native.evidence().fallback; } }
    }));
    owned.register('native-retirement', 70, () => operation('native_retirement', async () => {
      const value = native.evidence(); terminalProof(value);
      nativeRetired = [await retirement({ state: 'present', ...value.identity })];
      expect(['absent', 'reused']).toContain(nativeRetired[0].retirement);
      await rootProof(fixture); expect(await nativeBinding(binding)).toEqual(binding);
    }));
    expect(native.head).toBe(1);
    const drive = phaseDrive(native);
    server = await operation('server', () => acquireResource(owned, 'browser-server-close', 40,
      () => chromium.launchServer({ host: '127.0.0.1', headless: true }), value => operation('server_close', () => value.close())));
    owned.register('browser-final-discovery', 10, () => operation('browser_discovery', async () => { await discoverOwned(); finalDiscovery = true; }));
    owned.register('browser-emergency', 41, () => operation('browser_emergency', async () => {
      if (browserIdentity?.state !== 'present') return;
      const current = await retirement(browserIdentity);
      if (current.retirement === 'alive') { fallback = true; await server.kill(); }
      else if (current.retirement === 'unknown') throw new Error('Browser retirement unknown');
    }));
    owned.register('browser-retirement', 50, () => operation('browser_retirement', async () => {
      if (!browserMembers.length) throw new Error('Browser ownership unknown');
      await expect.poll(async () => { try { browserRetired = await retireTree(browserMembers); return true; } catch { return false; } }).toBe(true);
    }));
    await operation('identity', async () => {
      const candidate = await identity(server.process().pid);
      expect(candidate.state).toBe('present'); expect(candidate.ppid).toBe(process.pid);
      browserIdentity = candidate; await discoverOwned();
    });
    browser = await operation('browser', () => acquireResource(owned, 'browser-connection-close', 30,
      () => chromium.connect(server.wsEndpoint()), value => operation('browser_close', () => value.close())));
    browserVersion = browser.version(); expect(browserVersion).toBe('145.0.7632.6');
    context = await operation('context', () => acquireResource(owned, 'context-close', 20,
      () => browser.newContext({ serviceWorkers: 'block', viewport: { width: 1000, height: 700 } }), value => operation('context_close', () => {
        // Discovery remains observation. Only this actual close admits established-SSE cancellation.
        network?.closing(); return value.close();
      })));
    network = liveCollector({ origin: native.origin, owner: fixture.owner, session: native.session_id, head: native.head, faults,
      onReject: name => diagnostic.freeze(name), onRequestFailed: diagnostic.requestFailed });
    owned.register('collector-drain', 55, () => operation('collector_drain', async () => { await network.drain(); collectorProof(); }));
    await context.route('**/*', network.route);
    context.on('request', network.request); context.on('response', network.response);
    context.on('requestfinished', network.finished); context.on('requestfailed', network.failed);
    const page = await operation('page', () => context.newPage());
    page.on('console', () => { faults.console++; diagnostic.freeze('privacy'); });
    page.on('pageerror', () => { faults.page++; diagnostic.freeze('privacy'); });
    await operation('goto', () => page.goto(`${native.origin}/#session=${native.session_id}`));
    await operation('fresh', async () => {
      await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue('');
      await expect(page.getByLabel('Task', { exact: true })).toHaveValue('');
      await expect(page.locator('.run,.command')).toHaveCount(0); await boundary(page, context, fixture.owner);
    });
    await operation('connect', async () => {
      await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue('');
    });
    await operation('handshake', async () => {
      await expect.poll(() => network.ready('latest') && network.ready('sse')).toBe(true);
      await expect(page.locator('.topbar [role="status"]')).toHaveText('connected; observation: streaming');
      await expect(page.getByRole('heading', { name: 'Canonical session title', exact: true })).toHaveText('Live measurement');
      await expect(page.locator('.run')).toHaveCount(0);
    });
    await operation('task', async () => {
      network.armTask(); await page.getByLabel('Task', { exact: true }).fill(texts.task);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => network.ready('task')).toBe(true);
    });
    first = await operation('first', () => drive.first()); expect(first.run_id).toBe(network.taskRun());
    await operation('first_dom', async () => {
      let dom;
      await expect.poll(async () => { dom = await page.evaluate(browserProgram, { action: 'read', first, texts }); return dom !== null; }).toBe(true);
      browserProof(dom, first, 'first'); drive.observed('first', first, dom);
    });
    await operation('browser_arm', () => page.evaluate(browserProgram, { action: 'arm', first, texts }));
    await operation('native_arm', () => drive.arm());
    const captured = await operation('second', () => drive.second()); appended = captured.saved;
    nativeMeasurement = await operation('pages', async () => {
      const pages = [];
      for (let page = 0; page < captured.pages; page++) pages.push(await native.request({ command: 'page', page }));
      return telemetryProof(pages);
    });
    async function observed(kind, saved) {
      let dom;
      await expect.poll(async () => { dom = await page.evaluate(browserProgram, { action: 'poll', kind }); return dom !== null; }).toBe(true);
      drive.observed(kind, saved, dom);
    }
    // Captured already closed the independent reader and released SessionMutex. Never wait while paused.
    await operation('append_dom', () => observed('append', appended));
    authority = await operation('authority', () => drive.authority());
    await operation('authority_dom', () => observed('authority', authority));
    terminal = await operation('terminal', () => drive.terminal());
    await operation('terminal_dom', () => observed('terminal', terminal));
    await operation('complete', () => drive.complete());
    browserMeasurement = await operation('observer_finish', () => page.evaluate(browserProgram, { action: 'finish' }));
    await operation('privacy', () => boundary(page, context, fixture.owner));
    await operation('body_proof', async () => { await network.drain(); network.proof(); collectorProof(); });
    bodySucceeded = true;
  } catch (error) {
    diagnostic.freeze('cleanup'); owned.fail(error);
    try { await save('FAILURE_BEFORE_CLEANUP.json', diagnostic.packet()); } catch (publication) { owned.fail(publication); }
  } finally {
    const cleanup = await owned.cleanup();
    if (network) { try { await network.drain(); collectorProof(); } catch (error) { cleanup.error ??= error; diagnostic.freeze('cleanup'); } }
    try { if (binding) { expect(await nativeBinding(binding)).toEqual(binding); bindingUnchanged = true; } }
    catch (error) { cleanup.error ??= error; diagnostic.freeze('cleanup'); }
    const cleanupSafe = cleanup.steps.every(step => step.ok) && rootRemoved && allocation.removed && !fallback && bindingUnchanged;
    function prepare(artifact, field, read) {
      try { return read(); } catch (error) { preparationFailures.push({ artifact, field }); cleanup.error ??= error; diagnostic.freeze('publication'); return null; }
    }
    for (const [name, build] of [
      ['CLEANUP.json', () => {
        const nativeFacts = native ? prepare('CLEANUP.json', 'native', () => native.evidence()) : null;
        let nativeAvailability = 'not_acquired';
        if (native) nativeAvailability = nativeFacts === null ? 'unavailable' : 'available';
        return { pass: cleanupSafe, body_success: bodySucceeded, steps: cleanup.steps, root_removed: rootRemoved,
          allocation: structuredClone(allocation), parent_removed: allocation.removed,
          nested_availability: fixture ? 'acquired' : allocation.nested,
          retained_root: fixture && !rootRemoved ? fixture.root : null, final_discovery: finalDiscovery, fallback, native: nativeFacts,
          availability: { native: nativeAvailability },
          native_retirement: nativeRetired, browser_retirement: browserRetired, browser_discovery: treeFacts,
          binding_unchanged: bindingUnchanged, first_failure: diagnostic.packet(), diagnostics: prepare('CLEANUP.json', 'diagnostics', () => diagnostic.facts()), preparation_failures: preparationFailures };
      }],
      ['MEASUREMENTS.json', () => {
        const networkFacts = network ? prepare('MEASUREMENTS.json', 'network', () => network.facts()) : null;
        return { body_success: bodySucceeded, native: bodySucceeded ? nativeMeasurement : null, browser: bodySucceeded ? browserMeasurement : null, network: networkFacts,
        availability: { network: networkFacts === null ? 'unavailable' : 'available', native: bodySucceeded ? 'available' : 'not_claimed', browser: bodySucceeded ? 'available' : 'not_claimed' },
        original_api_body_read: false, helper_http_reads: 0, independent_clocks: true,
        limits: ['One instrumented case, not ordinary latency, SLA, variance, scaling, memory, disk or SQL/CPU measurement.',
          'Browser arm-to-callback includes control, deliberate pause, storage/lock, SSE polling, transport, parser, store, render and callback costs.',
          'Native stage21: run row; projector plus DisplayApplied hook tail; receipt/manifest/command. Not pure projector SQL.',
          'Native head/epoch and response/run event existence are native facts, not DOM attributes.',
          'SSE identity/status/headers only; no frame, body size or stream completion measurement.'] };
      }],
      ['ACCEPTANCE.json', () => ({ pass: bodySucceeded && cleanupSafe && !cleanup.error && !preparationFailures.length && !publicationFailures.length,
        native_states: bodySucceeded ? { first, append: appended, authority, terminal } : null,
        original_latest_sse_task_only: bodySucceeded, no_retry: true, accepted: false })],
      ['BROWSER_RESULT.json', () => {
        const counts = network ? prepare('BROWSER_RESULT.json', 'counts', () => network.facts().counts) : null;
        // Preparation can freeze a failure, so finish it before choosing the verdict and first packet.
        const diagnosticFacts = prepare('BROWSER_RESULT.json', 'diagnostics', () => diagnostic.facts());
        return { status: bodySucceeded && cleanupSafe && !cleanup.error && !preparationFailures.length && !publicationFailures.length ? 'PASS' : 'FAILED',
          fresh_cases: 1, chromium: browserVersion, counts, availability: { counts: counts === null ? 'unavailable' : 'available' },
          body_success: bodySucceeded, cleanup: cleanupSafe, parent_removed: allocation.removed, allocation: structuredClone(allocation), first_failure: diagnostic.packet(),
          diagnostics: diagnosticFacts, preparation_failures: preparationFailures,
          publication_failures: publicationFailures, binding: binding ? { executable: binding.executable, sha256: binding.sha256, selector: binding.selector, inputs: Object.keys(binding.sources).length } : null,
          ordinary_testinfo_output: true, no_retry: true };
      }],
    ]) {
      try { await save(name, build()); } catch (error) { cleanup.error ??= error; diagnostic.freeze('publication'); }
    }
    if (cleanup.error) throw cleanup.error;
    if (!bodySucceeded || !cleanupSafe || preparationFailures.length || publicationFailures.length) throw new Error('Live measurement failed; sanitized evidence saved');
  }
});
