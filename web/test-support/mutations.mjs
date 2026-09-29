// Drop only a completed real HTTP reply. Never inspect headers or request/response bodies.
export async function armReplyLoss(session, url, expectedStatus) {
  let paused = null;
  let invalid = false;
  let closed = false;
  let resolvePaused;
  const received = new Promise(resolve => { resolvePaused = resolve; });
  const releases = [];
  const listener = event => {
    if (paused !== null || event.request.method !== 'POST' || event.responseStatusCode !== expectedStatus) {
      invalid = true;
      releases.push(session.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => { invalid = true; }));
      resolvePaused();
      return;
    }
    paused = event.requestId;
    resolvePaused();
  };
  session.on('Fetch.requestPaused', listener);
  async function stop() {
    if (closed) return;
    closed = true;
    try {
      if (paused !== null) await session.send('Fetch.continueRequest', { requestId: paused });
      await Promise.all(releases);
    } finally {
      try { await session.send('Fetch.disable'); }
      finally { session.off('Fetch.requestPaused', listener); await session.detach(); }
    }
  }
  try {
    await session.send('Fetch.enable', { patterns: [{ urlPattern: url, requestStage: 'Response' }] });
  } catch {
    await stop();
    throw new Error('reply-loss setup failed');
  }
  return {
    async wait() {
      let timer;
      try {
        await Promise.race([received, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('reply-loss response unavailable')), 10_000);
        })]);
      } finally { clearTimeout(timer); }
      if (invalid || paused === null) throw new Error('reply-loss response rejected');
      return expectedStatus;
    },
    async drop() {
      if (closed || invalid || paused === null) throw new Error('reply-loss response rejected');
      const requestId = paused;
      paused = null;
      try { await session.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }); }
      finally { await stop(); }
    },
    stop,
  };
}
