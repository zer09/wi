import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const data = JSON.parse(await readFile(new URL('./presentation.json', import.meta.url), 'utf8'));
export const answer = task => `Final ${task + 1}\r\n${data.text}${'W'.repeat(2048)}`;
export const skillOutput = JSON.stringify({ body: data.tool, frontmatter: { description: 'synthetic metadata', name: 'presentation' }, id: 'project:presentation' });
export const labels = ['short-selected', 'long-selected', 'stalled-reader'];
const timingFields = ['first_page_ms', 'durable_acceptance_ms', 'committed_visibility_ms', 'reducer_render_ms', 'rebuild_ms', 'stall_ms'];
const countFields = ['first_page_events', 'history_pages', 'selected_events', 'selected_dom_nodes', 'local_dom_nodes', 'live_updates', 'deltas'];
export function measurement(value) {
  const fail = () => { throw new Error('measurement rejected'); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== ['label', ...timingFields, ...countFields].sort().join(',')
    || !labels.includes(value.label)) fail();
  // These bounds belong to the finite test watchdog and fixture, never the product.
  for (const key of timingFields) if (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > 180_000) fail();
  for (const key of countFields) if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 10_000) fail();
  return Object.fromEntries(Object.entries(value).map(([key, number]) => [key, timingFields.includes(key) ? Math.round(number * 100) / 100 : number]));
}

export async function observe(context, fixture) {
  const secrets = [fixture.owner, 'synthetic-replay-token-', 'synthetic-replay-account',
    createHash('sha256').update('wi.openai-codex.account.v1\0synthetic-replay-account').digest('hex'),
    'private-operator-instructions', 'private-project-browser', 'private-skill-browser', 'private-support-',
    'private-native', 'private-skills', 'private-data', 'private-config-canary',
    'principal_digest', 'encrypted_content', 'opaque_response', 'provider_session_id', 'prepared_request'];
  const leaked = value => secrets.some(secret => value.includes(secret));
  const faults = { external: 0, console: 0, page: 0, secret: 0, asset: 0, response: 0 };
  const requests = [];
  const responseFailures = [];
  const reads = new Set();
  const pages = [];
  const accepted = [];
  const assets = new Set();
  const files = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/assets/wi.css', 'style.css'],
    ...['api', 'app', 'client', 'sse', 'state', 'view'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
  let pageStart = 0;
  let pageEpoch = 0;
  let acceptanceStart = 0;
  let firstPage = null;
  let abortedRead = null;
  let abortConsole = 0;
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== fixture.origin) { faults.external++; await route.abort(); }
    else await route.continue();
  });
  context.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== fixture.origin) faults.external++;
    if (leaked(request.url())) faults.secret++;
    if (requests.length >= 512) { faults.response++; return; }
    // Request logging deliberately excludes headers, body and query strings.
    requests.push({ method: request.method(), path: url.pathname });
  });
  context.on('page', page => {
    page.on('console', message => {
      if (message.type() === 'error') {
        const expected = abortedRead !== null && message.location().url === abortedRead
          && ['Failed to load resource: net::ERR_FAILED', 'Failed to load resource: net::ERR_ABORTED'].includes(message.text());
        if (expected && abortConsole === 0) abortConsole++;
        else faults.console++;
      }
      if (leaked(message.text())) faults.secret++;
    });
    page.on('pageerror', () => { faults.page++; });
  });
  context.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 300) faults.response++;
    const file = files.get(path);
    if (file === undefined) return;
    const read = (async () => {
      const body = await response.body();
      if (leaked(body.toString('utf8'))) faults.secret++;
      if (response.status() !== 200 || !body.equals(await readFile(new URL(`../${file}`, import.meta.url)))) faults.asset++;
      assets.add(path);
    })().catch(() => { faults.asset++; }).finally(() => reads.delete(read));
    reads.add(read);
  });
  await context.exposeBinding('wiPresentationResponse', (_, capture) => {
    if (capture.failed) {
      faults.response++;
      if (responseFailures.length < 8) responseFailures.push('browser JSON capture');
      return;
    }
    if (leaked(capture.body)) faults.secret++;
    try {
      if (capture.kind === 'history' && capture.epoch === pageEpoch) {
        const page = JSON.parse(capture.body);
        if (capture.index === 0) firstPage = { ms: performance.now() - pageStart, events: page.events.length };
        if (capture.index >= 64) faults.response++;
        else pages[capture.index] = page;
      } else if (capture.kind === 'acceptance') {
        accepted.push({ value: JSON.parse(capture.body), ms: performance.now() - acceptanceStart });
      }
    } catch { faults.response++; }
  });
  await context.addInitScript(() => {
    const nativeFetch = globalThis.fetch;
    const capture = { epoch: 0, index: 0, reads: new Set() };
    globalThis.presentationCapture = capture;
    // Chromium can discard no-store streamed bodies before DevTools reads them.
    // Clone finite JSON only; return the original response without awaiting the clone.
    globalThis.fetch = async (...args) => {
      const url = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href);
      let kind = 'api';
      if (url.pathname.endsWith('/history')) kind = 'history';
      else if (url.pathname.endsWith('/runs') && args[1]?.method === 'POST') kind = 'acceptance';
      const stamp = { kind, epoch: capture.epoch, index: kind === 'history' ? capture.index++ : 0 };
      const response = await nativeFetch(...args);
      if (url.origin === location.origin && url.pathname.startsWith('/v1/') && !url.pathname.endsWith('/events')) {
        const read = response.clone().text().then(body => globalThis.wiPresentationResponse({ ...stamp, body }))
          .catch(() => globalThis.wiPresentationResponse({ failed: true })).finally(() => capture.reads.delete(read));
        capture.reads.add(read);
      }
      return response;
    };
  });
  return {
    requests, pages, accepted, faults, assets, secrets, responseFailures,
    expectReadAbort(url) {
      const parsed = new URL(url);
      if (abortedRead !== null || parsed.origin !== fixture.origin || !parsed.pathname.endsWith('/events')) {
        faults.response++; return;
      }
      abortedRead = url;
    },
    async beginPage() {
      pageEpoch++; firstPage = null; pages.length = 0;
      for (const page of context.pages()) await page.evaluate(epoch => {
        globalThis.presentationCapture.epoch = epoch; globalThis.presentationCapture.index = 0;
      }, pageEpoch);
      pageStart = performance.now();
    },
    beginAcceptance() { acceptanceStart = performance.now(); },
    firstPage: () => firstPage,
    async drain() {
      // A later page can arrive while an earlier response body is still being read.
      for (const page of context.pages()) await page.evaluate(async () => {
        const reads = globalThis.presentationCapture.reads;
        while (reads.size !== 0) await Promise.all(reads);
      });
      while (reads.size !== 0) await Promise.all(reads);
    },
    async privateBoundary(page) {
      const clean = await page.evaluate(async secrets => {
        const values = [document.documentElement.outerHTML, location.href, JSON.stringify(history.state),
          JSON.stringify(Object.entries(localStorage)), JSON.stringify(Object.entries(sessionStorage)), document.cookie,
          ...Array.from(document.querySelectorAll('input,textarea,select'), node => node.value)];
        return !secrets.some(secret => values.some(value => value?.includes(secret)))
          && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
          && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
          && (await navigator.serviceWorker.getRegistrations()).length === 0;
      }, secrets);
      return clean && (await context.cookies()).length === 0;
    },
  };
}

// Separate browser-local replay/render sample. These are captured public EventViews,
// not installed history, mocked API replies, or another joined latency measurement.
export async function localRender(page, events, manifest) {
  return page.evaluate(async ({ events, manifest }) => {
    const { createConversation, applyEvent, selectDisplay } = await import('/assets/state.js');
    const { mountView } = await import('/assets/view.js');
    const root = document.createElement('div');
    document.body.append(root);
    try {
      const start = performance.now();
      let state = createConversation(manifest.session_id);
      for (const event of events) state = applyEvent(state, event);
      const view = mountView(root, {}, () => {}, true);
      view.render({ connection: 'connected', settings: { workspaces: [manifest.workspace], provider_id: 'openai-codex', model: 'requested-alias', provider_transport: 'websocket' },
        catalog: null, catalog_loading: false, error: null, draft: '', pending: [], recoveries: [], last_mutation: null,
        selected: { session_id: manifest.session_id, manifest, title: manifest.title, workspace: manifest.workspace,
          applied_cursor: state.applied_cursor, through_sequence: manifest.head_sequence, history_complete: true,
          display: selectDisplay(state), observation: 'streaming', observation_error: null, closed_reason: null,
          run_view: null, cancel: null, cancelling: false } });
      root.getBoundingClientRect();
      const ms = performance.now() - start;
      return { ms, events: state.fingerprints.size, nodes: root.querySelector('.transcript').querySelectorAll('*').length };
    } finally { root.remove(); }
  }, { events, manifest });
}
