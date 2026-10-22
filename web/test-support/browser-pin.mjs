import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { preparationRedactor, sanitizeRecord } from './browser-fixture-preparation.mjs';

export const browserPin = Object.freeze({
  version: '157.0.8103.6', revision: '1717349', platform: 'linux64', arch: 'x64', sdk: '1.58.2',
  source: '41520584daa68d0040db7746ae562a0ff82187f6', loader: '40bc0f095e25466f0309cdc2513217a77d38270e',
  sourceURL: 'https://chromium.googlesource.com/chromium/src/+/41520584daa68d0040db7746ae562a0ff82187f6',
  generation: '1792024144268303',
  url: 'https://storage.googleapis.com/download/storage/v1/b/chrome-for-testing-public/o/157.0.8103.6%2Flinux64%2Fchrome-headless-shell-linux64.zip?generation=1792024144268303&alt=media',
  bytes: 127477393, md5: 'iONlSGXncR5lDluOpJTafw==', crc32c: 'hUxe1A==',
  archiveSHA256: '191f2a4f36421ae40f49913e3937dbee923071c985b96831f89dd2b51e14624d',
  executableSHA256: '7903f2536bf4342e1b1a6f6e64b722713ccfdfeb2fa3d8592acd2ca8e3986630',
  treeSHA256: 'cacf2332f4e01efd76afeddf558784257ee6d7dd38775b264c1adfa9ad8a04aa',
  files: 287, executable: 'chrome-headless-shell-linux64/chrome-headless-shell',
});
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const SDK = fileURLToPath(new URL('../node_modules/playwright-core/package.json', import.meta.url));
const reject = () => { throw Error('Browser pin validation failed.'); };
const check = value => { if (!value) reject(); };
const same = (a, b) => check(isDeepStrictEqual(a, b));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const absolute = path => typeof path === 'string' && path.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(path)
  && isAbsolute(path) && resolve(path) === path && path !== '/';
const within = (path, base) => path === base || path.startsWith(base + sep);
const snapshot = info => Object.fromEntries(['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'nlink', 'mtimeMs', 'ctimeMs'].map(key => [key, info[key]]));
const stable = (a, b) => same(snapshot(a), snapshot(b));

// These SDK inputs select remote browsers, inject code, or expose private diagnostics.
export function browserEnvironment(env = process.env) {
  const keys = ['PW_TEST_CONNECT_WS_ENDPOINT', 'PW_TEST_CONNECT_HEADERS', 'PW_TEST_CONNECT_EXPOSE_NETWORK',
    'SELENIUM_REMOTE_URL', 'SELENIUM_REMOTE_CAPABILITIES', 'SELENIUM_REMOTE_HEADERS', 'PWDEBUG', 'DEBUG', 'DEBUG_FILE',
    'PWDEBUGIMPL', 'PW_TEST_REUSE_CONTEXT', 'PW_TEST_REPORTER', 'PW_TEST_SOURCE_TRANSFORM', 'PW_TEST_SOURCE_TRANSFORM_SCOPE',
    'PW_CHROMIUM_ATTACH_TO_OTHER', 'PW_RUNNER_DEBUG', 'PWTEST_CACHE_DIR', 'PWPAUSE', 'PWTEST_WATCH', 'PWTEST_PROFILE_DIR',
    'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_HOST_PLATFORM_OVERRIDE', 'PLAYWRIGHT_TEST_BASE_URL',
    'UNZIP', 'UNZIPOPT', 'ZIPINFO', 'ZIPINFOOPT', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_DEBUG_OUTPUT'];
  for (const key of keys) {
    for (const name of [key, `npm_config_${key.toLowerCase()}`, `npm_package_config_${key.toLowerCase()}`]) {
      check(env[name] === undefined || env[name] === '');
    }
  }
}

// Reject duplicate JSON names before JSON.parse can discard the earlier value.
function strictJSON(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let i = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(text[i] ?? '') && i < text.length) i++; };
  function string() {
    const start = i++; check(text[start] === '"');
    while (i < text.length) {
      const char = text[i++];
      if (char === '\\') { i++; continue; }
      if (char === '"') { const value = JSON.parse(text.slice(start, i)); check(value.isWellFormed() && !value.includes('\0')); return value; }
    }
    reject();
  }
  function value(depth = 0) {
    check(depth < 16); space();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; space(); const result = Object.create(null), keys = new Set();
      if (text[i] === '}') { i++; return result; }
      for (;;) {
        space(); const key = string(); check(!keys.has(key)); keys.add(key); space(); check(text[i++] === ':');
        result[key] = value(depth + 1); space(); const end = text[i++]; if (end === '}') return result; check(end === ',');
      }
    }
    if (text[i] === '[') {
      i++; space(); const result = []; if (text[i] === ']') { i++; return result; }
      for (;;) { result.push(value(depth + 1)); space(); const end = text[i++]; if (end === ']') return result; check(end === ','); }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    check(match); i += match[0].length; return JSON.parse(match[0]);
  }
  value(); space(); check(i === text.length);
  return JSON.parse(text);
}

function context(overrides) {
  // Explicit IO seams are for synthetic tests. CLI and environment cannot select them.
  return { fs, pin: browserPin, uid: process.getuid(), platform: process.platform, arch: process.arch,
    sdk: () => JSON.parse(fs.readFileSync(SDK, 'utf8')).version, fetch: (...args) => globalThis.fetch(...args),
    extract: (archive, output) => execFileSync('unzip', ['-q', '-n', archive, '-d', output],
      { timeout: 30000, maxBuffer: 131072, stdio: ['ignore', 'pipe', 'pipe'], shell: false }), ...overrides };
}
function directory(path, io, mode) {
  check(absolute(path)); const info = io.fs.lstatSync(path);
  check(info.isDirectory() && !info.isSymbolicLink() && info.uid === io.uid && (info.mode & 0o7777) === mode);
  same(io.fs.realpathSync(path), path); return info;
}
function read(path, io, mode, limit) {
  check(absolute(path)); const before = io.fs.lstatSync(path);
  check(before.isFile() && !before.isSymbolicLink() && before.uid === io.uid && before.nlink === 1
    && (before.mode & 0o7777) === mode && before.size <= limit);
  same(io.fs.realpathSync(path), path);
  const fd = io.fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let failure;
  try {
    stable(before, io.fs.fstatSync(fd)); const bytes = io.fs.readFileSync(fd);
    check(bytes.length === before.size); stable(before, io.fs.fstatSync(fd)); stable(before, io.fs.lstatSync(path));
    return { bytes, info: before };
  } catch (error) { failure = error; throw error; }
  finally { try { io.fs.closeSync(fd); } catch (error) { if (!failure) throw error; } }
}
function host(io) { check(io.platform === 'linux' && io.arch === 'x64' && io.sdk() === io.pin.sdk); }
function inventory(root, io) {
  const records = [], directories = []; let entries = 0, total = 0;
  function visit(relative) {
    check(++entries <= 512 && Buffer.byteLength(relative) <= 256);
    const path = relative ? join(root, relative) : root, before = io.fs.lstatSync(path);
    same(io.fs.realpathSync(path), path); check(before.uid === io.uid && !before.isSymbolicLink());
    if (before.isDirectory()) {
      directory(path, io, relative ? 0o755 : 0o700); directories.push(relative);
      const names = io.fs.readdirSync(path).sort(); check(names.length > 0);
      for (const name of names) { check(name.isWellFormed() && !/[\u0000-\u001f\u007f\\]/.test(name)); visit(relative ? relative + '/' + name : name); }
      stable(before, io.fs.lstatSync(path)); same(io.fs.readdirSync(path).sort(), names);
    } else {
      check(before.isFile() && [0o600, 0o644, 0o755].includes(before.mode & 0o7777));
      total += before.size; check(total <= 512 * 1024 * 1024);
      const value = read(path, io, before.mode & 0o7777, 256 * 1024 * 1024);
      records.push({ relative, bytes: value.bytes.length, mode: before.mode & 0o7777, sha256: hash(value.bytes) });
    }
  }
  visit(''); check(records.length === io.pin.files);
  same(hash(JSON.stringify(records)), io.pin.treeSHA256);
  const executable = records.find(record => record.relative === io.pin.executable);
  check(executable && executable.mode === 0o755 && executable.sha256 === io.pin.executableSHA256);
  // A directory without a pinned file is an extra, even when it is empty.
  const expected = new Set(['']);
  for (const record of records) { let parent = dirname(record.relative); while (parent !== '.') { expected.add(parent); parent = dirname(parent); } }
  same([...expected].sort(), directories.sort()); return records;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0x82f63b78 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32c(bytes) {
  let crc = 0xffffffff; for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ crc >>> 8;
  const result = Buffer.alloc(4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return result.toString('base64');
}
function archiveDigest(bytes, pin) {
  check(bytes.length === pin.bytes); same(hash(bytes), pin.archiveSHA256);
  same(createHash('md5').update(bytes).digest('base64'), pin.md5); same(crc32c(bytes), pin.crc32c);
}

// Bound the ZIP before invoking unzip, including its local-header interpretation.
export function browserArchive(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length >= 22);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  check(end >= Math.max(0, bytes.length - 65557));
  check(end + 22 + bytes.readUInt16LE(end + 20) === bytes.length);
  check(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0);
  const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  check(count > 0 && count <= 512 && bytes.readUInt16LE(end + 8) === count && length <= 512 * 1024 && offset + length === end);
  const names = new Map(), members = [], spans = []; let at = offset, total = 0;
  function extras(start, length) {
    const end = start + length; check(end <= bytes.length);
    while (start < end) {
      check(start + 4 <= end);
      // Only timestamp and UID/GID metadata are needed. Unix link extras are unsafe.
      check([0x5455, 0x7875].includes(bytes.readUInt16LE(start)));
      const size = bytes.readUInt16LE(start + 2); start += 4 + size; check(start <= end);
    }
  }
  for (let index = 0; index < count; index++) {
    check(at + 46 <= end && bytes.readUInt32LE(at) === 0x02014b50);
    const needed = bytes.readUInt16LE(at + 6), flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10);
    const compressed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24), nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30), commentLength = bytes.readUInt16LE(at + 32), mode = bytes.readUInt32LE(at + 38) >>> 16;
    const localAt = bytes.readUInt32LE(at + 42), next = at + 46 + nameLength + extraLength + commentLength;
    // The pinned CfT ZIP uses hint 0x4 even for its stored entry.
    // This does not enable encryption or change the extraction method.
    check(next <= end && needed < 45 && !(flags & ~0x80c) && [0, 8].includes(method) && bytes.readUInt16LE(at + 34) === 0);
    check(nameLength > 0 && nameLength <= 256 && size <= 256 * 1024 * 1024); total += size; check(total <= 512 * 1024 * 1024);
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes), dir = name.endsWith('/'), normalized = dir ? name.slice(0, -1) : name;
    check(name.isWellFormed() && !/[\u0000-\u001f\u007f\\]/.test(name) && name.startsWith('chrome-headless-shell-linux64/'));
    check(normalized.split('/').every(part => part && part !== '.' && part !== '..') && !names.has(normalized));
    check((mode & 0xf000) === (dir ? 0x4000 : 0x8000) && !(mode & 0o7022)); check(!dir || size === 0);
    names.set(normalized, dir); extras(at + 46 + nameLength, extraLength);
    check(localAt + 30 <= offset && bytes.readUInt32LE(localAt) === 0x04034b50);
    check(bytes.readUInt16LE(localAt + 4) === needed && bytes.readUInt16LE(localAt + 6) === flags && bytes.readUInt16LE(localAt + 8) === method);
    const localName = bytes.readUInt16LE(localAt + 26), localExtra = bytes.readUInt16LE(localAt + 28), dataAt = localAt + 30 + localName + localExtra;
    check(localName === nameLength && dataAt + compressed <= offset && bytes.subarray(localAt + 30, localAt + 30 + localName).equals(nameBytes));
    extras(localAt + 30 + localName, localExtra);
    if (!(flags & 8)) {
      for (const [localField, centralField] of [[14, 16], [18, 20], [22, 24]]) same(bytes.readUInt32LE(localAt + localField), bytes.readUInt32LE(at + centralField));
    }
    let dataEnd = dataAt + compressed;
    if (flags & 8) {
      check(dataEnd + 12 <= offset);
      if (bytes.readUInt32LE(dataEnd) === 0x08074b50) dataEnd += 4;
      check(dataEnd + 12 <= offset);
      for (const [localField, centralField] of [[0, 16], [4, 20], [8, 24]]) same(bytes.readUInt32LE(dataEnd + localField), bytes.readUInt32LE(at + centralField));
      dataEnd += 12;
    }
    spans.push([localAt, dataEnd]); members.push({ name, directory: dir, bytes: size, mode: mode & 0o7777 }); at = next;
  }
  check(at === end); spans.sort((a, b) => a[0] - b[0]); let previous = 0;
  for (const [start, end] of spans) { check(start === previous); previous = end; } check(previous === offset);
  for (const [name] of names) { let parent = dirname(name); while (parent !== '.') { check(!names.has(parent) || names.get(parent)); parent = dirname(parent); } }
  return members;
}
function receiptValue(root, records, pin) {
  return { schema: 1, pin: { ...pin }, root, executablePath: join(root, 'package', pin.executable), inventory: records };
}
function admitted(binding, io) {
  check(absolute(binding) && binding === join(dirname(binding), 'binding.json'));
  const root = dirname(binding), rootInfo = directory(root, io, 0o700);
  same(io.fs.readdirSync(root).sort(), ['binding.json', 'browser.zip', 'package']);
  const receipt = read(binding, io, 0o600, 256 * 1024), parsed = strictJSON(receipt.bytes);
  const archive = read(join(root, 'browser.zip'), io, 0o600, io.pin.bytes); archiveDigest(archive.bytes, io.pin);
  const records = inventory(join(root, 'package'), io), expected = receiptValue(root, records, io.pin);
  same(parsed, expected); stable(receipt.info, io.fs.lstatSync(binding));
  same(read(binding, io, 0o600, 256 * 1024).bytes, receipt.bytes); stable(rootInfo, io.fs.lstatSync(root));
  return Object.freeze({ binding, bindingSHA256: hash(receipt.bytes), root, executablePath: expected.executablePath,
    version: io.pin.version, sdk: io.pin.sdk, treeSHA256: io.pin.treeSHA256, executableSHA256: io.pin.executableSHA256 });
}
export function browserAdmission(env = process.env, overrides = {}) {
  try { const io = context(overrides); browserEnvironment(env); host(io); return admitted(env.WI_BROWSER_BINDING, io); }
  catch { reject(); }
}
export function browserLaunchOptions(env = process.env, overrides = {}) {
  return { executablePath: browserAdmission(env, overrides).executablePath };
}

export async function prepareBrowser({ output }, overrides = {}) {
  const io = context(overrides), env = { ...(overrides.env ?? process.env) };
  browserEnvironment(env); host(io); check(absolute(output) && absolute(env.TMPDIR));
  const scratch = io.fs.realpathSync(env.TMPDIR); same(scratch, env.TMPDIR);
  check(within(output, scratch) && output !== scratch && !within(output, ROOT) && !within(ROOT, output)
    && !within(output, join(ROOT, 'target')));
  const parent = dirname(output), parentInfo = directory(parent, io, 0o700);
  const redact = preparationRedactor(env);
  const safe = value => { same(sanitizeRecord(value, redact), value); return Buffer.from(JSON.stringify(value) + '\n'); };
  // Refuse privacy collisions and occupied destinations before any download.
  safe({ ...io.pin, root: output });
  io.fs.mkdirSync(output, { mode: 0o700 }); directory(output, io, 0o700);
  // Creating our child changes parent timestamps and link counts, not its identity.
  const parentAfter = io.fs.lstatSync(parent);
  for (const key of ['dev', 'ino', 'mode', 'uid', 'gid']) same(parentAfter[key], parentInfo[key]);
  const archive = join(output, 'browser.zip'), extraction = join(output, 'package'), pending = join(output, 'binding.pending'), binding = join(output, 'binding.json');
  const download = new AbortController(), fd = io.fs.openSync(archive, 'wx', 0o600);
  let failure;
  try {
    const response = await io.fetch(io.pin.url, { redirect: 'error', signal: AbortSignal.any([download.signal, AbortSignal.timeout(180000)]) });
    check(response.status === 200 && response.url === io.pin.url && response.body);
    same(response.headers.get('x-goog-generation'), io.pin.generation);
    for (const [key, expected] of [['content-length', String(io.pin.bytes)], ['content-encoding', 'identity'],
      ['x-goog-stored-content-length', String(io.pin.bytes)], ['x-goog-stored-content-encoding', 'identity']]) {
      const value = response.headers.get(key); check(value === null || value === expected);
    }
    const suppliedHash = response.headers.get('x-goog-hash');
    if (suppliedHash !== null) {
      const fields = suppliedHash.split(',').map(value => value.trim());
      check(fields.length === 2 && fields.includes('md5=' + io.pin.md5) && fields.includes('crc32c=' + io.pin.crc32c));
    }
    let size = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk); size += bytes.length; check(size <= io.pin.bytes);
      let offset = 0; while (offset < bytes.length) { const written = io.fs.writeSync(fd, bytes, offset, bytes.length - offset); check(written > 0); offset += written; }
    }
    same(size, io.pin.bytes);
  } catch (error) {
    failure = error;
    // Refused headers and failed writes must release our fetch, not wait for its timeout.
    try { download.abort(); } catch { /* Keep the original failure. */ }
    throw error;
  }
  finally { try { io.fs.closeSync(fd); } catch (error) { if (!failure) throw error; } }
  const downloaded = read(archive, io, 0o600, io.pin.bytes); archiveDigest(downloaded.bytes, io.pin);
  const members = browserArchive(downloaded.bytes);
  io.fs.mkdirSync(extraction, { mode: 0o700 });
  io.extract(archive, extraction);
  stable(downloaded.info, io.fs.lstatSync(archive));
  const records = inventory(extraction, io);
  same(records.map(record => ({ name: record.relative, directory: false, bytes: record.bytes, mode: record.mode })).sort((a, b) => a.name.localeCompare(b.name)),
    members.filter(member => !member.directory).sort((a, b) => a.name.localeCompare(b.name)));
  const value = receiptValue(output, records, io.pin), bytes = safe(value);
  io.fs.writeFileSync(pending, bytes, { flag: 'wx', mode: 0o600 });
  const pendingRead = read(pending, io, 0o600, 256 * 1024); same(pendingRead.bytes, bytes); same(strictJSON(pendingRead.bytes), value);
  same(inventory(extraction, io), records); archiveDigest(read(archive, io, 0o600, io.pin.bytes).bytes, io.pin);
  directory(output, io, 0o700); same(io.fs.readdirSync(output).sort(), ['binding.pending', 'browser.zip', 'package']);
  // A hard link publishes without replacing any existing destination.
  io.fs.linkSync(pending, binding);
  try { io.fs.unlinkSync(pending); return admitted(binding, io); }
  catch (error) {
    // Retire only our published inode. Never remove an unknown replacement or cache.
    try { const info = io.fs.lstatSync(binding); if (info.dev === pendingRead.info.dev && info.ino === pendingRead.info.ino) io.fs.unlinkSync(binding); } catch { /* Keep the original failure. */ }
    throw error;
  }
}
