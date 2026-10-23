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
