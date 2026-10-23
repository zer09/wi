import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { browserPin, browserEnvironment, browserArchive, browserAdmission, browserLaunchOptions, prepareBrowser } from '../test-support/browser-pin.mjs';
import { run } from '../scripts/prepare-browser.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const NodeAbortSignal = AbortSignal;
// Initialize Node's lazy web primitives before descriptor preservation observations.
new Headers();
new AbortController().abort();
function descriptorsEqual(object, before) {
  const after = Object.getOwnPropertyDescriptors(object);
  assert.deepEqual(Reflect.ownKeys(after), Reflect.ownKeys(before));
  for (const key of Reflect.ownKeys(before)) {
    assert.deepEqual(Reflect.ownKeys(after[key]), Reflect.ownKeys(before[key]));
    for (const field of Reflect.ownKeys(before[key])) assert.equal(after[key][field], before[key][field]);
  }
}
function headers(values) {
  const map = new Map(Object.entries(values));
  return { get: key => map.get(key) ?? null, set: (key, value) => map.set(key, value), delete: key => map.delete(key) };
}
const namespace = 'chrome-headless-shell-linux64';
const contents = [
  { relative: namespace + '/ABOUT', mode: 0o644, body: Buffer.from('synthetic support') },
  { relative: namespace + '/chrome-headless-shell', mode: 0o755, body: Buffer.from('not an executable') },
];
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0x82f63b78 ^ value >>> 1 : value >>> 1; }
  const result = Buffer.alloc(4); result.writeUInt32BE((value ^ 0xffffffff) >>> 0); return result.toString('base64');
}
function zip(entries = contents.map(entry => ({ name: entry.relative, body: entry.body, mode: 0o100000 | entry.mode }))) {
  const locals = [], central = []; let position = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), body = entry.body ?? Buffer.alloc(0), local = Buffer.alloc(30), header = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(0x314, 4); header.writeUInt16LE(20, 6);
    header.writeUInt32LE(body.length, 20); header.writeUInt32LE(body.length, 24); header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); header.writeUInt32LE(position, 42);
    locals.push(local, name, body); central.push(header, name); position += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(position, 16);
  return Buffer.concat([...locals, directory, end]);
}
function archivePin(bytes) {
  return { bytes: bytes.length, archiveSHA256: hash(bytes), md5: createHash('md5').update(bytes).digest('base64'), crc32c: crc(bytes) };
}
function fixture(t) {
  const parent = fs.mkdtempSync(join(process.env.TMPDIR, 'wi-pin-unit-')); fs.chmodSync(parent, 0o700);
  t.after(() => { fs.rmSync(parent, { recursive: true }); assert.equal(fs.existsSync(parent), false); });
  const output = join(parent, 'cache'), archive = zip(), calls = [], before = { ...process.env }, mask = process.umask();
  const globalDescriptors = Object.getOwnPropertyDescriptors(globalThis), processDescriptors = Object.getOwnPropertyDescriptors(process);
  t.after(() => { assert.deepEqual({ ...process.env }, before); assert.equal(process.umask(), mask);
    descriptorsEqual(globalThis, globalDescriptors);
    descriptorsEqual(process, processDescriptors); });
  const inventory = contents.map(entry => ({ relative: entry.relative, bytes: entry.body.length, mode: entry.mode, sha256: hash(entry.body) }));
  const pin = { ...browserPin, ...archivePin(archive), files: contents.length, treeSHA256: hash(JSON.stringify(inventory)), executableSHA256: hash(contents[1].body) };
  const io = { pin, env: { TMPDIR: process.env.TMPDIR }, sdk: () => '1.58.2',
    fetch: async (url, options) => { calls.push('fetch'); assert.equal(url, pin.url); assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof NodeAbortSignal);
      return { status: 200, url, headers: headers({ 'x-goog-generation': pin.generation, 'content-length': String(pin.bytes), 'x-goog-hash': 'md5=' + pin.md5 + ',crc32c=' + pin.crc32c }), body: (async function* () { yield archive; })() }; },
    extract: (archivePath, extraction) => { calls.push('extract'); assert.deepEqual(fs.readFileSync(archivePath), archive);
      assert.equal(fs.existsSync(join(output, 'binding.json')), false);
      fs.mkdirSync(join(extraction, namespace), { mode: 0o755 });
      for (const entry of contents) fs.writeFileSync(join(extraction, entry.relative), entry.body, { flag: 'wx', mode: entry.mode });
    },
  };
  return { parent, output, archive, calls, pin, io, binding: join(output, 'binding.json'),
    prepare: () => prepareBrowser({ output }, io), admission: () => browserAdmission({ WI_BROWSER_BINDING: join(output, 'binding.json') }, io) };
}
function stats(info, changes) {
  return new Proxy(info, { get(target, key) { if (Object.hasOwn(changes, key)) return changes[key]; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; } });
}
function intercept(f, operation, callback) {
  const previous = f.io.fs ?? fs;
  f.io.fs = { ...previous, [operation]: (...args) => callback(previous[operation].bind(previous), ...args) };
}
function rewrite(f, update) {
  const value = JSON.parse(fs.readFileSync(f.binding, 'utf8')); update(value); fs.writeFileSync(f.binding, JSON.stringify(value));
}

test('fixed pin is flat immutable and keeps external browser separate from installed SDK', () => {
  assert.equal(Object.isFrozen(browserPin), true); assert.equal(browserPin.sdk, '1.58.2'); assert.equal(browserPin.version, '157.0.8103.6');
  assert.equal(browserPin.revision, '1717349'); assert.equal(browserPin.files, 287); assert.equal(browserPin.bytes, 127477393);
  assert.match(browserPin.url, /^https:\/\/storage\.googleapis\.com\/.*generation=1792024144268303&alt=media$/);
  for (const key of ['archiveSHA256', 'executableSHA256', 'treeSHA256']) assert.match(browserPin[key], /^[a-f0-9]{64}$/);
  assert.throws(() => { browserPin.version = '145'; }, TypeError);
});
test('synthetic provision reaches extraction, readback, admission and exact launch options without executing bytes', async t => {
  const f = fixture(t), result = await f.prepare();
  assert.deepEqual(f.calls, ['fetch', 'extract']); assert.equal(result.binding, f.binding); assert.equal(result.version, browserPin.version);
  assert.equal(Object.isFrozen(result), true); assert.equal(fs.statSync(f.output).mode & 0o7777, 0o700);
  assert.equal(fs.statSync(f.binding).mode & 0o7777, 0o600); assert.equal(fs.statSync(f.binding).nlink, 1);
  assert.deepEqual(f.admission(), result);
  assert.deepEqual(browserLaunchOptions({ WI_BROWSER_BINDING: f.binding }, f.io), { executablePath: join(f.output, 'package', browserPin.executable) });
  assert.deepEqual(f.calls, ['fetch', 'extract']);
});
for (const key of ['PW_TEST_CONNECT_WS_ENDPOINT', 'PW_TEST_CONNECT_HEADERS', 'PW_TEST_CONNECT_EXPOSE_NETWORK', 'SELENIUM_REMOTE_URL',
  'SELENIUM_REMOTE_CAPABILITIES', 'SELENIUM_REMOTE_HEADERS', 'PWDEBUG', 'DEBUG', 'DEBUG_FILE', 'PWDEBUGIMPL', 'PW_TEST_REUSE_CONTEXT',
  'PW_TEST_REPORTER', 'PW_TEST_SOURCE_TRANSFORM', 'PW_TEST_SOURCE_TRANSFORM_SCOPE', 'PW_CHROMIUM_ATTACH_TO_OTHER',
  'PW_RUNNER_DEBUG', 'PWTEST_CACHE_DIR',
  'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_HOST_PLATFORM_OVERRIDE', 'PLAYWRIGHT_TEST_BASE_URL',
  'UNZIP', 'UNZIPOPT', 'ZIPINFO', 'ZIPINFOOPT', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_DEBUG_OUTPUT']) {
  for (const name of [key, 'npm_config_' + key.toLowerCase(), 'npm_package_config_' + key.toLowerCase()]) {
    test('value-private environment refusal: ' + name, async t => {
      const f = fixture(t); f.io.env[name] = 'synthetic-private-value';
      assert.throws(() => browserEnvironment(f.io.env), /^Error: Browser pin validation failed\.$/);
      await assert.rejects(f.prepare, /^Error: Browser pin validation failed\.$/); assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.output), false);
    });
  }
}
test('legitimate prompt setting is allowed and preserved with all input bytes', () => {
  for (const value of ['1', '0', 'custom', '']) { const env = { PLAYWRIGHT_NO_COPY_PROMPT: value }; browserEnvironment(env); assert.deepEqual(env, { PLAYWRIGHT_NO_COPY_PROMPT: value }); }
});
for (const field of ['version', 'revision', 'platform', 'arch', 'sdk', 'source', 'loader', 'sourceURL', 'generation', 'url', 'bytes', 'md5', 'crc32c',
  'archiveSHA256', 'executableSHA256', 'treeSHA256', 'files', 'executable']) {
  test('receipt fixed provenance rejects changed ' + field, async t => {
    const f = fixture(t); await f.prepare(); rewrite(f, value => { value.pin[field] = 'changed'; });
    let reached = 0; intercept(f, 'readdirSync', (original, path, ...args) => { if (path === join(f.output, 'package', namespace)) reached++; return original(path, ...args); });
    assert.throws(f.admission, /Browser pin validation failed/); assert.ok(reached > 0, 'valid schema prefix reaches actual package');
  });
}
for (const [label, mutate] of [
  ['schema', value => { value.schema = 2; }], ['missing schema', value => { delete value.schema; }], ['extra field', value => { value.extra = true; }],
  ['root', value => { value.root += '-stale'; }], ['executable', value => { value.executablePath += '-stale'; }],
  ['missing pin key', value => { delete value.pin.sdk; }], ['extra pin key', value => { value.pin.extra = true; }],
  ['inventory digest', value => { value.inventory[0].sha256 = '0'.repeat(64); }], ['inventory extra', value => { value.inventory[0].extra = true; }],
  ['inventory missing', value => { value.inventory.pop(); }], ['inventory duplicate', value => { value.inventory.push(value.inventory[0]); }],
]) test('closed receipt refuses ' + label, async t => { const f = fixture(t); await f.prepare(); rewrite(f, mutate); assert.throws(f.admission, /Browser pin validation failed/); });
for (const [label, source] of [
  ['duplicate root', text => text.replace('{', '{"root":"duplicate",')],
  ['escaped duplicate', text => text.replace('{', '{"\\u0073chema":1,')],
  ['nested duplicate', text => text.replace('"pin":{', '"pin":{"sdk":"duplicate",')],
  ['lone surrogate', text => text.replace('"schema":1', '"schema":"\\ud800"')],
  ['NUL', text => text.replace('"schema":1', '"schema":"\\u0000"')],
  ['trailing bytes', text => text + '{}'], ['invalid UTF8', () => Buffer.from([0xff])], ['BOM', text => '\ufeff' + text],
  ['truncated', text => text.slice(0, -4)], ['array', () => '[]'], ['null', () => 'null'],
]) test('strict receipt decoding refuses ' + label, async t => {
  const f = fixture(t); await f.prepare(); fs.writeFileSync(f.binding, source(fs.readFileSync(f.binding, 'utf8'))); assert.throws(f.admission, /Browser pin validation failed/);
});
test('receipt property order and whitespace do not replace canonical inventory hashing', async t => {
  const f = fixture(t); await f.prepare(); const value = JSON.parse(fs.readFileSync(f.binding, 'utf8'));
  value.inventory = value.inventory.map(record => Object.fromEntries(Object.entries(record).reverse()));
  fs.writeFileSync(f.binding, JSON.stringify(Object.fromEntries(Object.entries(value).reverse()), null, 3)); assert.ok(f.admission());
});
for (const [label, mutate] of [
  ['missing binding', f => fs.unlinkSync(f.binding)], ['missing archive', f => fs.unlinkSync(join(f.output, 'browser.zip'))],
  ['archive bytes', f => fs.appendFileSync(join(f.output, 'browser.zip'), 'x')],
  ['support bytes', f => fs.appendFileSync(join(f.output, 'package', contents[0].relative), 'x')],
  ['executable bytes', f => fs.appendFileSync(join(f.output, 'package', contents[1].relative), 'x')],
  ['extra file', f => fs.writeFileSync(join(f.output, 'package', namespace, 'extra'), 'x')],
  ['extra empty directory', f => fs.mkdirSync(join(f.output, 'package', namespace, 'extra'))],
  ['extra root file', f => fs.writeFileSync(join(f.output, 'extra'), 'x')],
  ['missing support', f => fs.unlinkSync(join(f.output, 'package', contents[0].relative))],
  ['root mode', f => fs.chmodSync(f.output, 0o755)], ['receipt mode', f => fs.chmodSync(f.binding, 0o644)],
  ['executable mode', f => fs.chmodSync(join(f.output, 'package', contents[1].relative), 0o644)],
  ['directory mode', f => fs.chmodSync(join(f.output, 'package', namespace), 0o777)],
  ['support hardlink', f => fs.linkSync(join(f.output, 'package', contents[0].relative), join(f.parent, 'link'))],
  ['receipt hardlink', f => fs.linkSync(f.binding, join(f.parent, 'link'))],
  ['receipt symlink', f => { fs.renameSync(f.binding, join(f.parent, 'original')); fs.symlinkSync(join(f.parent, 'original'), f.binding); }],
  ['support symlink', f => { const path = join(f.output, 'package', contents[0].relative); fs.renameSync(path, join(f.parent, 'original')); fs.symlinkSync(join(f.parent, 'original'), path); }],
  ['support directory', f => { const path = join(f.output, 'package', contents[0].relative); fs.unlinkSync(path); fs.mkdirSync(path); }],
]) test('success-shaped cache refusal reaches changed filesystem: ' + label, async t => {
  const f = fixture(t); await f.prepare(); assert.ok(f.admission()); mutate(f); assert.throws(f.admission, /Browser pin validation failed/); assert.deepEqual(f.calls, ['fetch', 'extract']);
});
for (const pathKind of ['root', 'receipt', 'support', 'archive']) test('wrong owner refuses at actual stat: ' + pathKind, async t => {
  const f = fixture(t); await f.prepare();
  const path = { root: f.output, receipt: f.binding, support: join(f.output, 'package', contents[0].relative), archive: join(f.output, 'browser.zip') }[pathKind];
  let reached = 0; intercept(f, 'lstatSync', (original, name, ...args) => { const info = original(name, ...args); if (name === path) { reached++; return stats(info, { uid: info.uid + 1 }); } return info; });
  assert.throws(f.admission, /Browser pin validation failed/); assert.ok(reached > 0);
});
for (const field of ['ino', 'dev', 'size', 'mode', 'mtimeMs', 'ctimeMs', 'nlink']) test('stable read detects changed ' + field, async t => {
  const f = fixture(t); await f.prepare(); let reached = 0;
  intercept(f, 'fstatSync', (original, fd) => { const info = original(fd); reached++; return stats(info, { [field]: info[field] + 1 }); });
  assert.throws(f.admission, /Browser pin validation failed/); assert.ok(reached > 0);
});
for (const binding of [undefined, '', 'relative', '/tmp/../bad', '/tmp/bad\0', '/tmp/\ud800', '/']) test('invalid binding path refuses without repair: ' + JSON.stringify(String(binding)), () => {
  assert.throws(() => browserAdmission({ WI_BROWSER_BINDING: binding }), /Browser pin validation failed/);
});
for (const [label, overrides] of [['platform', { platform: 'darwin' }], ['arch', { arch: 'arm64' }], ['SDK', { sdk: () => '1.64.0' }]]) {
  test('host admission refuses wrong ' + label, async t => { const f = fixture(t); Object.assign(f.io, overrides); await assert.rejects(f.prepare); assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.output), false); });
}
test('occupied root is not adopted, overwritten or deleted', async t => {
  const f = fixture(t); fs.mkdirSync(f.output, { mode: 0o700 }); fs.writeFileSync(join(f.output, 'owner'), 'retain');
  await assert.rejects(f.prepare, { code: 'EEXIST' }); assert.equal(fs.readFileSync(join(f.output, 'owner'), 'utf8'), 'retain'); assert.deepEqual(f.calls, []);
});
test('nonprivate parent rejects before creation', async t => { const f = fixture(t); fs.chmodSync(f.parent, 0o755); await assert.rejects(f.prepare); assert.equal(fs.existsSync(f.output), false); assert.deepEqual(f.calls, []); });
test('parent symlink rejects without following it for creation', async t => {
  const f = fixture(t), alias = join(f.parent, 'alias'); fs.symlinkSync(f.parent, alias); await assert.rejects(() => prepareBrowser({ output: join(alias, 'cache') }, f.io)); assert.deepEqual(f.calls, []);
});
test('privacy collisions reject before output publication or download', async t => {
  const f = fixture(t); f.io.env.SYNTHETIC_TOKEN = browserPin.generation; await assert.rejects(f.prepare); assert.equal(fs.existsSync(f.output), false); assert.deepEqual(f.calls, []);
});
for (const [label, change] of [
  ['status', response => { response.status = 302; }], ['url', response => { response.url += '&other=1'; }],
  ['generation', response => response.headers.set('x-goog-generation', '1')], ['missing generation', response => response.headers.delete('x-goog-generation')],
  ['length', response => response.headers.set('content-length', '1')], ['encoding', response => response.headers.set('content-encoding', 'gzip')],
  ['hash', response => response.headers.set('x-goog-hash', 'md5=incorrect,crc32c=incorrect')], ['body', response => { response.body = null; }],
]) test('download response refuses ' + label + ' before extraction', async t => {
  const f = fixture(t), fetch = f.io.fetch; f.io.fetch = async (...args) => { const response = await fetch(...args); change(response); return response; };
  await assert.rejects(f.prepare); assert.deepEqual(f.calls, ['fetch']); assert.equal(fs.existsSync(f.binding), false);
});
for (const [label, bytes] of [['partial', Buffer.from('x')], ['cap', Buffer.alloc(1000)], ['corrupt', Buffer.alloc(zip().length)]]) test('download ' + label + ' cannot publish readiness', async t => {
  const f = fixture(t), fetch = f.io.fetch; f.io.fetch = async (...args) => { const response = await fetch(...args); response.body = (async function* () { yield bytes; })(); return response; };
  await assert.rejects(f.prepare); assert.deepEqual(f.calls, ['fetch']); assert.equal(fs.existsSync(f.binding), false);
});
for (const field of ['archiveSHA256', 'md5', 'crc32c']) test('download checks actual ' + field, async t => {
  const f = fixture(t); f.pin[field] = 'incorrect'; await assert.rejects(f.prepare); assert.deepEqual(f.calls, ['fetch']); assert.equal(fs.existsSync(f.binding), false);
});
for (const operation of ['fetch', 'extract']) test('original ' + operation + ' failure stays first and retains partial cache without readiness', async t => {
  const f = fixture(t), failure = Error('synthetic first failure'); f.io[operation] = () => { f.calls.push(operation); throw failure; };
  await assert.rejects(f.prepare, error => error === failure); assert.equal(fs.existsSync(f.output), true); assert.equal(fs.existsSync(f.binding), false);
});
for (const operation of ['mkdirSync', 'openSync', 'writeSync', 'writeFileSync', 'linkSync']) test('filesystem ' + operation + ' failure cannot publish readiness', async t => {
  const f = fixture(t), failure = Error('synthetic IO failure'); let reached = 0;
  intercept(f, operation, () => { reached++; throw failure; }); await assert.rejects(f.prepare, error => error === failure); assert.ok(reached > 0); assert.equal(fs.existsSync(f.binding), false);
});
test('download failure is not replaced by a secondary close failure', async t => {
  const f = fixture(t), first = Error('synthetic primary'), secondary = Error('synthetic close');
  f.io.fetch = () => { throw first; };
  intercept(f, 'closeSync', (original, fd) => { original(fd); throw secondary; });
  await assert.rejects(f.prepare, error => error === first); assert.equal(fs.existsSync(f.binding), false);
});
test('read failure is not replaced by a secondary close failure', async t => {
  const f = fixture(t), first = Error('synthetic primary'), secondary = Error('synthetic close');
  let closes = 0;
  intercept(f, 'readFileSync', () => { throw first; });
  intercept(f, 'closeSync', (original, fd) => { original(fd); if (++closes > 1) throw secondary; });
  await assert.rejects(f.prepare, error => error === first); assert.equal(closes, 2); assert.equal(fs.existsSync(f.binding), false);
});
test('short writes are completed without duplicating bytes', async t => {
  const f = fixture(t); let reached = 0;
  intercept(f, 'writeSync', (original, fd, bytes, offset, length) => { reached++; return original(fd, bytes, offset, Math.min(3, length)); });
  await f.prepare(); assert.ok(reached > 1); assert.ok(f.admission());
});
test('zero writes refuse instead of spinning', async t => { const f = fixture(t); intercept(f, 'writeSync', () => 0); await assert.rejects(f.prepare); assert.equal(fs.existsSync(f.binding), false); });
test('pending readback failure prevents exclusive publication', async t => {
  const f = fixture(t); let reached = 0, links = 0;
  intercept(f, 'readFileSync', (original, fd, ...args) => { const result = original(fd, ...args); if (Buffer.isBuffer(result) && result[0] === 123) { reached++; return Buffer.from('{}'); } return result; });
  intercept(f, 'linkSync', (original, ...args) => { links++; return original(...args); });
  await assert.rejects(f.prepare); assert.ok(reached > 0); assert.equal(links, 0); assert.equal(fs.existsSync(f.binding), false);
});
test('late extra support file is found before publication', async t => {
  const f = fixture(t); intercept(f, 'writeFileSync', (original, path, ...args) => { const result = original(path, ...args); if (path.endsWith('binding.pending')) fs.writeFileSync(join(f.output, 'package', namespace, 'extra'), 'retain'); return result; });
  await assert.rejects(f.prepare); assert.equal(fs.existsSync(f.binding), false); assert.equal(fs.readFileSync(join(f.output, 'package', namespace, 'extra'), 'utf8'), 'retain');
});
test('late occupied receipt is preserved by exclusive publication', async t => {
  const f = fixture(t); intercept(f, 'linkSync', (original, from, to) => { fs.writeFileSync(to, 'owner bytes', { flag: 'wx', mode: 0o600 }); return original(from, to); });
  await assert.rejects(f.prepare, { code: 'EEXIST' }); assert.equal(fs.readFileSync(f.binding, 'utf8'), 'owner bytes');
});

for (const [label, change] of [
  ['status', response => { response.status = 302; }], ['url', response => { response.url += '&other=1'; }],
  ['body', response => { response.body = null; }],
  ['generation', response => response.headers.set('x-goog-generation', '1')],
  ['missing generation', response => response.headers.delete('x-goog-generation')],
  ['length', response => response.headers.set('content-length', '1')],
  ['encoding', response => response.headers.set('content-encoding', 'gzip')],
  ['stored length', response => response.headers.set('x-goog-stored-content-length', '1')],
  ['stored encoding', response => response.headers.set('x-goog-stored-content-encoding', 'gzip')],
  ['hash', response => response.headers.set('x-goog-hash', 'md5=incorrect,crc32c=incorrect')],
  ['fetch'], ['stream'], ['write'], ['zero write'], ['cap'], ['partial'], ['success'],
]) test('owned download release: ' + label, async t => {
  const f = fixture(t), fetch = f.io.fetch, first = Error('synthetic download primary'), secondary = Error('synthetic close secondary');
  let signal, active = false, aborts = 0, iterations = 0, closes = 0;
  f.io.fetch = async (url, options) => {
    const response = await fetch(url, options); signal = options.signal; active = true;
    assert.equal(signal.aborted, false);
    signal.addEventListener('abort', () => { aborts++; active = false; }, { once: true });
    if (label === 'fetch') throw first;
    response.body = (async function* () {
      iterations++;
      if (label === 'stream') { yield f.archive.subarray(0, 3); throw first; }
      if (label === 'cap') yield Buffer.alloc(f.pin.bytes + 1);
      else if (label === 'partial') yield f.archive.subarray(0, 3);
      else yield f.archive;
      active = false;
    })();
    if (change) change(response);
    return response;
  };
  if (label === 'write') intercept(f, 'writeSync', () => { throw first; });
  if (label === 'zero write') intercept(f, 'writeSync', () => 0);
  intercept(f, 'closeSync', (original, fd) => {
    original(fd); closes++;
    if (['status', 'fetch', 'stream', 'write'].includes(label)) throw secondary;
  });
  if (label === 'success') {
    assert.ok(await f.prepare()); assert.ok(f.admission());
    assert.deepEqual(f.calls, ['fetch', 'extract']); assert.equal(aborts, 0); assert.equal(signal.aborted, false);
  } else {
    await assert.rejects(f.prepare, error => ['fetch', 'stream', 'write'].includes(label)
      ? error === first : error.message === 'Browser pin validation failed.');
    assert.deepEqual(f.calls, ['fetch']); assert.equal(fs.existsSync(f.binding), false);
    assert.throws(f.admission); assert.throws(() => browserLaunchOptions({ WI_BROWSER_BINDING: f.binding }, f.io));
    assert.equal(closes, 1); assert.equal(signal.aborted, true); assert.equal(aborts, 1, 'caller releases its owned fetch on failure');
  }
  assert.equal(iterations, change || label === 'fetch' ? 0 : 1); assert.equal(active, false);
});
for (const kind of ['known inode', 'unknown replacement', 'rollback failure']) test('pending unlink rollback: ' + kind, async t => {
  const f = fixture(t), pending = join(f.output, 'binding.pending'), first = Error('synthetic pending unlink'), secondary = Error('synthetic rollback');
  let links = 0, rollback = 0, inspected = 0, published;
  intercept(f, 'linkSync', (original, from, to) => {
    const result = original(from, to); links++; published = fs.lstatSync(to);
    assert.equal(published.ino, fs.lstatSync(from).ino); assert.equal(published.nlink, 2); return result;
  });
  intercept(f, 'lstatSync', (original, path, ...args) => { if (path === f.binding) inspected++; return original(path, ...args); });
  intercept(f, 'unlinkSync', (original, path, ...args) => {
    if (path === pending) {
      if (kind === 'unknown replacement') {
        // Keep the published inode alive so the new file cannot reuse it.
        fs.renameSync(f.binding, join(f.output, 'old-binding'));
        fs.writeFileSync(f.binding, 'unknown replacement', { flag: 'wx', mode: 0o600 });
        assert.notEqual(fs.lstatSync(f.binding).ino, published.ino);
      }
      throw first;
    }
    assert.equal(path, f.binding); rollback++;
    if (kind === 'rollback failure') throw secondary;
    return original(path, ...args);
  });
  await assert.rejects(f.prepare, error => error === first);
  assert.equal(links, 1); assert.equal(inspected, 1, 'post-link failure checks rollback authority');
  assert.equal(rollback, kind === 'unknown replacement' ? 0 : 1);
  assert.equal(fs.existsSync(pending), true); assert.deepEqual(fs.readFileSync(join(f.output, 'browser.zip')), f.archive);
  for (const entry of contents) assert.deepEqual(fs.readFileSync(join(f.output, 'package', entry.relative)), entry.body);
  if (kind === 'known inode') { assert.equal(fs.existsSync(f.binding), false); assert.equal(fs.lstatSync(pending).nlink, 1); }
  if (kind === 'unknown replacement') assert.equal(fs.readFileSync(f.binding, 'utf8'), 'unknown replacement');
  if (kind === 'rollback failure') {
    assert.equal(fs.lstatSync(f.binding).ino, published.ino); assert.equal(fs.lstatSync(pending).nlink, 2);
    assert.deepEqual(fs.readFileSync(f.binding), fs.readFileSync(pending));
  }
  assert.throws(f.admission); assert.throws(() => browserLaunchOptions({ WI_BROWSER_BINDING: f.binding }, f.io));
  assert.deepEqual(f.calls, ['fetch', 'extract']);
});
for (const name of ['PW_CHROMIUM_ATTACH_TO_OTHER', 'npm_config_pw_chromium_attach_to_other', 'npm_package_config_pw_chromium_attach_to_other']) {
  for (const value of ['0', 'false', '']) test('target attachment guard preserves input: ' + name + '=' + JSON.stringify(value), async t => {
    const f = fixture(t); f.io.env[name] = value; f.io.env.PLAYWRIGHT_NO_COPY_PROMPT = 'retained';
    Object.defineProperty(f.io.env, Symbol('synthetic descriptor'), { value: 'retained', enumerable: false });
    const before = Object.getOwnPropertyDescriptors(f.io.env);
    t.after(() => descriptorsEqual(f.io.env, before));
    if (value === '') { browserEnvironment(f.io.env); assert.ok(await f.prepare()); assert.ok(f.admission()); }
    else {
      assert.throws(() => browserEnvironment(f.io.env), /^Error: Browser pin validation failed\.$/);
      await assert.rejects(f.prepare, /^Error: Browser pin validation failed\.$/);
      assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.output), false);
    }
  });
}

for (const key of ['PW_RUNNER_DEBUG', 'PWTEST_CACHE_DIR', 'PWPAUSE', 'PWTEST_WATCH', 'PWTEST_PROFILE_DIR']) {
  for (const name of [key, 'npm_config_' + key.toLowerCase(), 'npm_package_config_' + key.toLowerCase()]) {
    for (const value of ['0', 'false', '/synthetic/runner-cache', '', undefined]) test('runner output guard preserves plain input: ' + name + '=' + JSON.stringify(value), async t => {
      const f = fixture(t), cached = fixture(t); await cached.prepare(); assert.ok(cached.admission());
      const env = f.io.env; env.WI_BROWSER_BINDING = cached.binding; env.PLAYWRIGHT_NO_COPY_PROMPT = 'retained';
      if (value !== undefined) env[name] = value;
      Object.defineProperty(env, 'syntheticHidden', { value: 'retained', enumerable: false });
      Object.defineProperty(env, Symbol('synthetic descriptor'), { value: 'retained', enumerable: false });
      const before = Object.getOwnPropertyDescriptors(env), filesystem = [], traversal = [];
      t.after(() => descriptorsEqual(env, before));
      for (const operation of ['lstatSync', 'realpathSync', 'readdirSync', 'openSync', 'readFileSync', 'mkdirSync']) {
        intercept(f, operation, (original, ...args) => { filesystem.push(operation); return original(...args); });
        intercept(cached, operation, (original, ...args) => { traversal.push(operation); return original(...args); });
      }
      if (value === '' || value === undefined) {
        browserEnvironment(env); assert.ok(await f.prepare());
        assert.ok(browserAdmission(env, cached.io));
        assert.deepEqual(browserLaunchOptions(env, cached.io), { executablePath: join(cached.output, 'package', browserPin.executable) });
        assert.deepEqual(f.calls, ['fetch', 'extract']); assert.ok(filesystem.length > 0); assert.ok(traversal.length > 0);
      } else {
        assert.throws(() => browserEnvironment(env), /^Error: Browser pin validation failed\.$/);
        await assert.rejects(f.prepare, /^Error: Browser pin validation failed\.$/);
        assert.throws(() => browserAdmission(env, cached.io), /^Error: Browser pin validation failed\.$/);
        assert.throws(() => browserLaunchOptions(env, cached.io), /^Error: Browser pin validation failed\.$/);
        assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.output), false);
        assert.deepEqual(filesystem, []); assert.deepEqual(traversal, []);
      }
      assert.deepEqual(cached.calls, ['fetch', 'extract']); assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, 'retained');
    });
  }
}

const centralOffset = bytes => bytes.readUInt32LE(bytes.length - 6);
for (const [label, mutate] of [
  ['split', bytes => bytes.writeUInt16LE(1, bytes.length - 18)], ['count', bytes => bytes.writeUInt16LE(513, bytes.length - 12)],
  ['Zip64 needed', bytes => bytes.writeUInt16LE(45, centralOffset(bytes) + 6)],
  ['encryption', bytes => bytes.writeUInt16LE(1, centralOffset(bytes) + 8)],
  ['unsupported method', bytes => bytes.writeUInt16LE(99, centralOffset(bytes) + 10)],
  ['member size', bytes => bytes.writeUInt32LE(256 * 1024 * 1024 + 1, centralOffset(bytes) + 24)],
  ['symlink', bytes => bytes.writeUInt32LE((0o120777 << 16) >>> 0, centralOffset(bytes) + 38)],
  ['special', bytes => bytes.writeUInt32LE((0o010644 << 16) >>> 0, centralOffset(bytes) + 38)],
  ['suid', bytes => bytes.writeUInt32LE((0o104755 << 16) >>> 0, centralOffset(bytes) + 38)],
  ['group write', bytes => bytes.writeUInt32LE((0o100664 << 16) >>> 0, centralOffset(bytes) + 38)],
  ['local method', bytes => bytes.writeUInt16LE(8, 8)], ['local name', bytes => { bytes[30] ^= 1; }],
  ['local size', bytes => bytes.writeUInt32LE(12345, 22)], ['overlap', bytes => bytes.writeUInt32LE(0xffffffff, centralOffset(bytes) + 42)],
  ['invalid UTF8', bytes => { bytes[centralOffset(bytes) + 46] = 0xff; }],
]) test('bounded archive refuses ' + label + ' after matching download digests', async t => {
  const f = fixture(t), bytes = Buffer.from(f.archive); mutate(bytes); Object.assign(f.pin, archivePin(bytes));
  const fetch = f.io.fetch; f.io.fetch = async (...args) => { const response = await fetch(...args); response.body = (async function* () { yield bytes; })(); return response; };
  await assert.rejects(f.prepare); assert.deepEqual(f.calls, ['fetch']); assert.equal(fs.existsSync(f.binding), false);
  assert.throws(() => browserArchive(bytes));
});
for (const name of ['../escape', '/absolute', namespace + '/../escape', namespace + '/a\\b', namespace + '/a\0b', namespace + '/a\nb', namespace + '//a', namespace + '/./a', 'other/file', namespace + '/' + 'a'.repeat(256)]) {
  test('archive namespace refuses ' + JSON.stringify(name), () => assert.throws(() => browserArchive(zip([{ name }]))));
}
test('archive rejects duplicate and file-directory collisions', () => {
  for (const entries of [[{ name: namespace + '/a' }, { name: namespace + '/a' }], [{ name: namespace + '/a' }, { name: namespace + '/a/b' }],
    [{ name: namespace + '/a' }, { name: namespace + '/a/', mode: 0o040755 }]]) assert.throws(() => browserArchive(zip(entries)));
});
test('archive accepts bounded files and explicit directories without execution', () => {
  assert.equal(browserArchive(zip()).length, 2);
  assert.equal(browserArchive(zip([{ name: namespace + '/', mode: 0o040755 }, { name: namespace + '/a' }])).length, 2);
  assert.equal(crc(Buffer.from('123456789')), '4waSgw==');
});
test('same-user cache relocation does not authorize a stale receipt', async t => {
  const f = fixture(t); await f.prepare(); const moved = f.output + '-moved'; fs.renameSync(f.output, moved);
  assert.throws(() => browserAdmission({ WI_BROWSER_BINDING: join(moved, 'binding.json') }, f.io), /Browser pin validation failed/);
});
test('same-user rewritten tree claims cannot replace the fixed digest', async t => {
  const f = fixture(t); await f.prepare(); fs.appendFileSync(join(f.output, 'package', contents[0].relative), 'replacement');
  rewrite(f, value => { value.inventory[0].sha256 = hash(fs.readFileSync(join(f.output, 'package', contents[0].relative))); value.pin.treeSHA256 = hash(JSON.stringify(value.inventory)); });
  assert.throws(f.admission, /Browser pin validation failed/);
});
test('receipt alias rejects even when its target bytes are valid', async t => {
  const f = fixture(t); await f.prepare(); const alias = join(f.parent, 'alias'); fs.symlinkSync(f.output, alias);
  assert.throws(() => browserAdmission({ WI_BROWSER_BINDING: join(alias, 'binding.json') }, f.io));
});
test('receipt file is nonblocking, nofollow and rechecked after reading', async t => {
  const f = fixture(t); await f.prepare(); let reads = 0;
  intercept(f, 'openSync', (original, path, flags, ...args) => {
    if (path === f.binding) { reads++; assert.ok(flags & fs.constants.O_NONBLOCK); assert.ok(flags & fs.constants.O_NOFOLLOW); }
    return original(path, flags, ...args);
  });
  assert.ok(f.admission()); assert.equal(reads, 2);
});
test('changed receipt identity during read rejects unchanged claimed bytes', async t => {
  const f = fixture(t); await f.prepare(); let reached = 0;
  intercept(f, 'readFileSync', (original, fd, ...args) => {
    const bytes = original(fd, ...args);
    if (Buffer.isBuffer(bytes) && bytes[0] === 123) { reached++; fs.unlinkSync(f.binding); fs.writeFileSync(f.binding, bytes, { flag: 'wx', mode: 0o600 }); }
    return bytes;
  });
  assert.throws(f.admission); assert.equal(reached, 1);
});
for (const kind of ['missing', 'extra', 'mode', 'empty directory']) test('extraction result cannot publish ' + kind + ' inventory', async t => {
  const f = fixture(t), extract = f.io.extract; f.io.extract = (...args) => {
    extract(...args); const root = join(f.output, 'package', namespace);
    if (kind === 'missing') fs.unlinkSync(join(root, 'ABOUT'));
    if (kind === 'extra') fs.writeFileSync(join(root, 'extra'), 'extra');
    if (kind === 'mode') fs.chmodSync(join(root, 'ABOUT'), 0o600);
    if (kind === 'empty directory') fs.mkdirSync(join(root, 'empty'));
  };
  await assert.rejects(f.prepare); assert.deepEqual(f.calls, ['fetch', 'extract']); assert.equal(fs.existsSync(f.binding), false);
});
test('final failed readback retires only the owned published receipt', async t => {
  const f = fixture(t); let published = false, reached = 0;
  intercept(f, 'linkSync', (original, ...args) => { const result = original(...args); published = true; return result; });
  intercept(f, 'readFileSync', (original, fd, ...args) => { const bytes = original(fd, ...args); if (published && Buffer.isBuffer(bytes) && bytes[0] === 123) { reached++; return Buffer.from('{}'); } return bytes; });
  await assert.rejects(f.prepare); assert.equal(reached, 1); assert.equal(fs.existsSync(f.binding), false); assert.equal(fs.existsSync(join(f.output, 'browser.zip')), true);
});
test('final failed readback never removes an unknown replacement receipt', async t => {
  const f = fixture(t); let published = false;
  intercept(f, 'linkSync', (original, ...args) => { const result = original(...args); published = true; return result; });
  intercept(f, 'readFileSync', (original, fd, ...args) => {
    const bytes = original(fd, ...args);
    if (published && Buffer.isBuffer(bytes) && bytes[0] === 123) {
      // Keep the first inode alive, so the replacement cannot reuse its identity.
      fs.renameSync(f.binding, join(f.output, 'old-binding')); fs.writeFileSync(f.binding, 'unknown replacement', { flag: 'wx', mode: 0o600 });
    }
    return bytes;
  });
  await assert.rejects(f.prepare); assert.equal(fs.readFileSync(f.binding, 'utf8'), 'unknown replacement');
});
test('ZIP entry count and aggregate uncompressed bounds reject before extraction', () => {
  assert.throws(() => browserArchive(zip(Array.from({ length: 513 }, (_, index) => ({ name: namespace + '/' + index })))));
  const sized = count => {
    const bytes = zip(Array.from({ length: count }, (_, index) => ({ name: namespace + '/' + index })));
    let offset = centralOffset(bytes);
    for (let index = 0; index < count; index++) {
      const local = bytes.readUInt32LE(offset + 42);
      bytes.writeUInt16LE(8, local + 8); bytes.writeUInt16LE(8, offset + 10);
      bytes.writeUInt32LE(256 * 1024 * 1024, local + 22); bytes.writeUInt32LE(256 * 1024 * 1024, offset + 24);
      offset += 46 + bytes.readUInt16LE(offset + 28);
    }
    return bytes;
  };
  assert.equal(browserArchive(sized(2)).length, 2); assert.throws(() => browserArchive(sized(3)));
});
for (const id of [1, 0x000d, 0x5855]) test('ZIP link or Zip64 extra is refused before extraction: ' + id, () => {
  const bytes = zip(), offset = centralOffset(bytes), nameLength = bytes.readUInt16LE(offset + 28), at = offset + 46 + nameLength;
  const extra = Buffer.alloc(4); extra.writeUInt16LE(id);
  const changed = Buffer.concat([bytes.subarray(0, at), extra, bytes.subarray(at)]);
  changed.writeUInt16LE(4, offset + 30); changed.writeUInt32LE(bytes.readUInt32LE(bytes.length - 10) + 4, changed.length - 10);
  assert.throws(() => browserArchive(changed));
});
test('CLI validates only explicit canonical output and never accepts a pin or executable override', async () => {
  const messages = [], stderr = { write: text => messages.push(text) }; let calls = 0;
  const prepare = async () => { calls++; };
  for (const argv of [[], ['--output'], ['--output', 'relative'], ['--output', '/'], ['--output', '/a/../b'], ['--output', '/a\0b'],
    ['--output', '/a\ud800'], ['--output', '/a', '--pin', 'other'], ['--executable', '/a']]) assert.equal(await run(argv, prepare, stderr), 2);
  assert.equal(calls, 0); assert.equal(await run(['--output', '/synthetic/cache'], prepare, stderr), 0); assert.equal(calls, 1);
  assert.equal(await run(['--output', '/synthetic/cache'], async () => { throw Error('synthetic private exception'); }, stderr), 1);
  assert.ok(messages.every(text => !text.includes('/synthetic') && !text.includes('private exception')));
});

// Use real compressed bytes and ZIP CRC32 so descriptor positives have valid framing.
function hintZip(method, flags, signed = false, name = namespace + '/hint') {
  const body = Buffer.from('synthetic compression hint'), nameBytes = Buffer.from(name);
  const payload = method === 0 ? body : deflateRawSync(body), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  crc = (crc ^ 0xffffffff) >>> 0;
  const needed = method === 0 && !(flags & 8) ? 10 : 20;
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(needed, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt16LE(nameBytes.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(needed, 6);
  central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const descriptor = Buffer.alloc(flags & 8 ? (signed ? 16 : 12) : 0);
  if (flags & 8) {
    if (signed) descriptor.writeUInt32LE(0x08074b50);
    const at = signed ? 4 : 0;
    descriptor.writeUInt32LE(crc, at); descriptor.writeUInt32LE(payload.length, at + 4); descriptor.writeUInt32LE(body.length, at + 8);
  } else {
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(body.length, 22);
  }
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(local.length + nameBytes.length + payload.length + descriptor.length, 16);
  return Buffer.concat([local, nameBytes, payload, descriptor, central, nameBytes, end]);
}
for (const method of [0, 8]) {
  for (const [flags, signed] of [[4, false], [0x804, false], [0xc, false], [0xc, true], [0x80c, false], [0x80c, true]]) {
    test(`compression hint admits method ${method} flags ${flags} signed ${signed}`, () => {
      const name = namespace + (flags & 0x800 ? '/hint-λ' : '/hint'), bytes = hintZip(method, flags, signed, name);
      assert.equal(bytes.readUInt16LE(6), flags); assert.equal(bytes.readUInt16LE(centralOffset(bytes) + 8), flags);
      assert.equal(bytes.readUInt16LE(8), method); assert.equal(bytes.readUInt16LE(centralOffset(bytes) + 10), method);
      assert.deepEqual(browserArchive(bytes), [{ name, directory: false, bytes: Buffer.byteLength('synthetic compression hint'), mode: 0o644 }]);
    });
  }
  test('matching hinted digests reach only synthetic extraction for method ' + method, async t => {
    const f = fixture(t), bytes = hintZip(method, 4), fetch = f.io.fetch, stop = Error('synthetic extraction boundary');
    Object.assign(f.pin, archivePin(bytes));
    f.io.fetch = async (...args) => { const response = await fetch(...args); response.body = (async function* () { yield bytes; })(); return response; };
    f.io.extract = (archive, output) => {
      f.calls.push('extract'); assert.deepEqual(fs.readFileSync(archive), bytes); assert.equal(output, join(f.output, 'package'));
      assert.equal(fs.existsSync(f.binding), false); throw stop;
    };
    await assert.rejects(f.prepare, error => error === stop); assert.deepEqual(f.calls, ['fetch', 'extract']); assert.equal(fs.existsSync(f.binding), false);
  });
  for (const field of ['archiveSHA256', 'md5', 'crc32c']) test(`hinted method ${method} still rejects corrupt ${field} before extraction`, async t => {
    const f = fixture(t), bytes = hintZip(method, 4), fetch = f.io.fetch;
    Object.assign(f.pin, archivePin(bytes)); f.pin[field] = 'incorrect';
    f.io.fetch = async (...args) => { const response = await fetch(...args); response.body = (async function* () { yield bytes; })(); return response; };
    await assert.rejects(f.prepare, /^Error: Browser pin validation failed\.$/); assert.deepEqual(f.calls, ['fetch']); assert.equal(fs.existsSync(f.binding), false);
  });
  for (const flags of [1, 5, 2, 6, 0x44, 0x14, 0x1004, 0x2004, 0x8004]) test(`compression hint refuses unsafe method ${method} flags ${flags}`, () => {
    assert.throws(() => browserArchive(hintZip(method, flags)), /^Error: Browser pin validation failed\.$/);
  });
  for (const [central, local] of [[4, 0], [0, 4], [0x804, 4]]) test(`compression hint refuses method ${method} flag mismatch ${central}/${local}`, () => {
    const bytes = hintZip(method, central); bytes.writeUInt16LE(local, 6);
    assert.throws(() => browserArchive(bytes), /^Error: Browser pin validation failed\.$/);
  });
  for (const field of ['missing', 'crc', 'compressed', 'size']) test(`compression hint requires method ${method} descriptor ${field}`, () => {
    let bytes = hintZip(method, 0xc); const at = centralOffset(bytes) - 12;
    if (field === 'missing') {
      bytes = Buffer.concat([bytes.subarray(0, at), bytes.subarray(at + 12)]); bytes.writeUInt32LE(at, bytes.length - 6);
    } else {
      const offset = at + ['crc', 'compressed', 'size'].indexOf(field) * 4;
      bytes.writeUInt32LE((bytes.readUInt32LE(offset) + 1) >>> 0, offset);
    }
    assert.throws(() => browserArchive(bytes), /^Error: Browser pin validation failed\.$/);
  });
}
for (const method of [9, 12, 99]) test('compression hint does not admit unsupported method ' + method, () => {
  const bytes = hintZip(0, 4); bytes.writeUInt16LE(method, 8); bytes.writeUInt16LE(method, centralOffset(bytes) + 10);
  assert.throws(() => browserArchive(bytes), /^Error: Browser pin validation failed\.$/);
});
