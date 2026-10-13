import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url)), src = join(root, 'src');
const app = join(src, 'app.ts'), active = join(src, 'display-client.ts'), legacy = join(src, 'client.ts');
const view = join(src, 'display-view.ts'), smoke = join(src, '__display_type_boundary__.ts');
const names = ['ClientError', 'CapturedCommand', 'ClientDependencies'];
const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
assert.deepEqual(parsed.errors, []);
const options = { ...parsed.options, noEmit: true };
const source = file => readFileSync(file, 'utf8');

function program(roots, overrides = new Map()) {
  const host = ts.createCompilerHost(options), original = host.getSourceFile;
  host.getSourceFile = (file, language, ...args) => overrides.has(file)
    ? ts.createSourceFile(file, overrides.get(file), language, true) : original(file, language, ...args);
  return ts.createProgram(roots, options, host);
}
function assertActiveBoundary(overrides = new Map()) {
  const pending = [app], seen = new Set(), retired = ['client.ts', 'state.ts', 'view.ts'].map(file => join(src, file));
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    assert.equal(retired.includes(file), false, 'active static/type graph reaches a legacy module');
    seen.add(file);
    const text = overrides.get(file) ?? source(file);
    assert.deepEqual(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true).parseDiagnostics, []);
    for (const reference of ts.preProcessFile(text, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(reference.fileName, file, options, ts.sys).resolvedModule;
      assert.ok(resolved, 'active dependency must resolve');
      assert.equal(dirname(resolved.resolvedFileName), src, 'active dependency stays in the source directory');
      pending.push(resolved.resolvedFileName);
    }
  }
  assert.ok(seen.has(active) && seen.has(view), 'traverse the actual app controller and renderer');
  return seen;
}
function assertCompatibility(p) {
  const checker = p.getTypeChecker(), display = p.getSourceFile(active), raw = p.getSourceFile(legacy);
  const exports = file => checker.getExportsOfModule(checker.getSymbolAtLocation(file));
  for (const name of names) {
    const declaration = exports(display).find(symbol => symbol.name === name);
    const alias = exports(raw).find(symbol => symbol.name === name);
    assert.ok(declaration && alias, 'both controllers export the shared type');
    assert.ok(alias.flags & ts.SymbolFlags.Alias, 'legacy export is an alias, not a second definition');
    assert.equal(checker.getAliasedSymbol(alias), declaration, 'legacy export resolves to the active declaration');
    assert.equal(raw.statements.length, 1, 'legacy bridge has only the compatibility export');
    const reexports = raw.statements.filter(ts.isExportDeclaration).filter(node => node.moduleSpecifier?.text === './display-client.js');
    assert.equal(reexports.length, 1);
    assert.equal(reexports[0].isTypeOnly, true, 'legacy compatibility export is type-only');
    assert.deepEqual(reexports[0].exportClause.elements.map(node => node.name.text), names);
  }
  for (const name of ['SnapshotValue', 'PendingCommand', 'MutationOutcome', 'CommandReply']) {
    assert.equal(exports(display).some(symbol => symbol.name === name), false, 'legacy-only types stay out of display code');
  }
}
const typing = `
import type { ClientError, CapturedCommand, ClientDependencies } from './display-client.js';
import type { ClientError as LegacyError, CapturedCommand as LegacyCommand, ClientDependencies as LegacyDependencies } from './client.js';
import type { ProtocolError, ErrorView, CreateCommand, RenameCommand, TaskCommand } from './api.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Check<T extends true> = T;
type ExpectedError =
  | { readonly category: 'authentication' | 'invalid_token' | 'network' | 'aborted' | 'unsupported_client'
      | 'not_connected' | 'invalid_action' | 'workspace_forbidden' | 'conflict' }
  | { readonly category: 'protocol'; readonly detail: ProtocolError['category'] }
  | { readonly category: 'http'; readonly status: number;
      readonly server: Pick<ErrorView, 'code' | 'stage' | 'certainty' | 'acceptance' | 'notices'> };
type ExpectedCommand = { readonly id: string } & (
  | { readonly kind: 'create'; readonly session_id: null; readonly body: CreateCommand }
  | { readonly kind: 'rename'; readonly session_id: string; readonly body: RenameCommand }
  | { readonly kind: 'task'; readonly session_id: string; readonly body: TaskCommand }
  | { readonly kind: 'refresh'; readonly session_id: string; readonly body: Readonly<Record<string, never>> });
interface ExpectedDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly crypto?: Pick<Crypto, 'randomUUID'> | null;
}
type Errors = Check<Equal<ClientError, ExpectedError>>;
type Commands = Check<Equal<CapturedCommand, ExpectedCommand>>;
type Dependencies = Check<Equal<ClientDependencies, ExpectedDependencies>>;
type LegacyErrors = Check<Equal<LegacyError, ClientError>>;
type LegacyCommands = Check<Equal<LegacyCommand, CapturedCommand>>;
type LegacyInjection = Check<Equal<LegacyDependencies, ClientDependencies>>;
`;

test('active app static and type dependency graph excludes legacy client/state/view', () => {
  assertActiveBoundary();
  const p = program([app]);
  assert.deepEqual(ts.getPreEmitDiagnostics(p), []);
  for (const file of ['client.ts', 'state.ts', 'view.ts']) assert.equal(p.getSourceFile(join(src, file)), undefined);
});
test('legacy shared type exports alias the active declarations through type-only compatibility', () => {
  assertCompatibility(program([active, legacy]));
});
test('shared types preserve literal branches, readonly members, DTOs and optional dependencies', () => {
  assert.deepEqual(ts.getPreEmitDiagnostics(program([smoke], new Map([[smoke, typing]]))), []);
});

for (const [label, file, added] of [
  ['controller type import', active, "import type { ClientError as RawError } from './client.js';"],
  ['renderer type import', view, "import type { ClientError as RawError } from './client.js';"],
  ['app legacy value import', app, "import { createClient } from './client.js';"],
  ['type reexport', active, "export type { ClientError as RawError } from './client.js';"],
  ['import type expression', view, "type RawError = import('./client.js').ClientError;"],
  ['dynamic import', app, "void import('./client.js');"],
  ['transitive state dependency', join(src, 'display-store.ts'), "import type { HistoryState } from './state.js';"],
  ['transitive raw renderer', join(src, 'display-api.ts'), "export { mountView } from './view.js';"],
]) test(`type boundary guard rejects actual-path ${label}`, () => {
  assert.throws(() => assertActiveBoundary(new Map([[file, source(file) + '\n' + added + '\n']])));
});
for (const [label, before, after] of [
  ['duplicate declaration', "export type { ClientError, CapturedCommand, ClientDependencies } from './display-client.js';", 'export type ClientError = { readonly category: "network" };'],
  ['missing reexport', "export type { ClientError, CapturedCommand, ClientDependencies } from './display-client.js';", ''],
  ['value import', "export type { ClientError, CapturedCommand, ClientDependencies } from './display-client.js';", "import { ClientError, CapturedCommand, ClientDependencies } from './display-client.js';\nexport type { ClientError, CapturedCommand, ClientDependencies } from './display-client.js';"],
  ['value reexport', 'export type { ClientError, CapturedCommand, ClientDependencies }', 'export { ClientError, CapturedCommand, ClientDependencies }'],
]) test(`compatibility guard rejects actual-path ${label}`, () => {
  assert.ok(source(legacy).includes(before));
  assert.throws(() => assertCompatibility(program([active, legacy], new Map([[legacy, source(legacy).replace(before, after)]]))));
});
for (const [label, before, after] of [
  ['error readonly member', 'readonly status: number', 'status: number'],
  ['command DTO', 'readonly body: CreateCommand', 'readonly body: RenameCommand'],
  ['optional dependency', 'readonly fetch?: typeof globalThis.fetch', 'readonly fetch: typeof globalThis.fetch'],
  ['error literal branch', " | 'workspace_forbidden' | 'conflict'", " | 'workspace_forbidden'"],
]) test(`typing guard rejects actual-path ${label}`, () => {
  assert.ok(source(active).includes(before));
  const overrides = new Map([[smoke, typing], [active, source(active).replace(before, after)]]);
  assert.ok(ts.getPreEmitDiagnostics(program([smoke], overrides)).some(diagnostic => diagnostic.code === 2344), 'exact type comparison must fail');
});
