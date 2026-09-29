// Serialized by addInitScript before the application starts. No response content leaves the page.
export function installStaleHistoryObserver({ secrets, initialTitle, renamedTitle }) {
  const nativeFetch = globalThis.fetch;
  const reads = new Set();
  const failures = new Set();
  const counts = { task: 0, rename: 0, manifest: 0 };
  const limits = { task: 1, rename: 1, manifest: 2 };
  const reply = { status: null, decoded: false, validated: false, exact: false };
  let session;
  let renameReceipt;
  let canonicalRename = false;
  globalThis.staleHistoryCapture = {
    select(sid) { session = sid; },
    summary() {
      return { counts: { ...counts }, reply: { ...reply }, rename: renameReceipt !== undefined,
        canonicalRename, failures: [...failures] };
    },
    matchesRename(receipt, operation) {
      return renameReceipt !== undefined && renameReceipt.operation_id === operation
        && Object.keys(renameReceipt).length === Object.keys(receipt).length
        && Object.keys(renameReceipt).every(key => renameReceipt[key] === receipt[key]);
    },
    async drain() {
      // New captures can start while an earlier clone is still being consumed.
      while (reads.size !== 0) await Promise.all(reads);
    },
  };
  globalThis.fetch = async (...args) => {
    const request = args[0];
    const url = new URL(request instanceof Request ? request.url : request, location.href);
    const method = args[1]?.method ?? (request instanceof Request ? request.method : 'GET');
    let kind;
    if (session !== undefined && url.origin === location.origin && url.search === '' && url.hash === '') {
      const path = `/v1/sessions/${session}`;
      if (method === 'POST' && url.pathname === `${path}/runs`) kind = 'task';
      else if (method === 'POST' && url.pathname === `${path}/rename`) kind = 'rename';
      else if (method === 'GET' && url.pathname === path) kind = 'manifest';
    }
    const response = await nativeFetch(...args);
    if (kind === undefined) return response;
    if (counts[kind] === limits[kind]) { failures.add(`${kind}:limit`); return response; }
    counts[kind]++;
    let step = 'status';
    // DevTools can lose a no-store body after the app reads it. Never await this clone on the app's path.
    const read = (async () => {
      const status = kind === 'task' ? 409 : 200;
      if (kind === 'task') reply.status = response.status === status ? status : 0;
      if (response.status !== status) throw new Error();
      step = 'media';
      if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error();
      step = 'body';
      const body = await response.clone().text();
      // These limits belong only to this finite test, never to application history or tasks.
      step = 'size';
      if (body.length > 64 * 1024) throw new Error();
      step = 'secret';
      if (secrets.some(secret => body.includes(secret))) throw new Error();
      step = 'json';
      const value = JSON.parse(body);
      if (kind === 'task') reply.decoded = true;
      step = 'schema';
      const api = await import('/assets/api.js');
      if (kind === 'task') {
        api.validateErrorView(value);
        reply.validated = true;
        step = 'exact';
        reply.exact = value.api_version === 1 && value.code === 'storage.stale_history' && value.stage === 'acceptance'
          && value.certainty === 'not_committed' && value.acceptance === null && value.notices.length === 0;
        if (!reply.exact) throw new Error();
      } else if (kind === 'rename') {
        const rename = api.validateRenameView(value);
        step = 'exact';
        if (rename.receipt.session_id !== session || rename.receipt.run_id !== null
          || rename.receipt.first_sequence !== '2' || rename.receipt.last_sequence !== '2'
          || rename.duplicate !== false || rename.warning_code !== null || rename.catalog_refresh !== 'updated') throw new Error();
        renameReceipt = rename.receipt;
      } else {
        const manifest = api.validateSessionView(value);
        step = 'exact';
        canonicalRename = manifest.session_id === session && manifest.title === renamedTitle && manifest.head_sequence === '2';
        if (!canonicalRename && !(manifest.session_id === session && manifest.title === initialTitle && manifest.head_sequence === '1')) throw new Error();
      }
    })().catch(() => { failures.add(`${kind}:${step}`); }).finally(() => reads.delete(read));
    reads.add(read);
    return response;
  };
}

// Compare real browser-fetched bytes in the page, not a second DevTools body read.
export async function checkEmbeddedAssets({ files, secrets }) {
  const failures = new Set();
  let checked = 0;
  for (const [path, expected] of files) {
    try {
      const response = await fetch(path, { mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error' });
      if (response.status !== 200) failures.add('asset:status');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== expected.length || bytes.some((byte, index) => byte !== expected[index])) failures.add('asset:bytes');
      const text = new TextDecoder().decode(bytes);
      if (secrets.some(secret => text.includes(secret))) failures.add('asset:secret');
      checked++;
    } catch { failures.add('asset:read'); }
  }
  return { checked, failures: [...failures] };
}
