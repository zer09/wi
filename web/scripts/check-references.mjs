// Parse source, not fixture strings. TypeScript is already a locked dev dependency.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const key = (source, target) => `${source}\0${target}`;
const installed = new Set([
  key('web/scripts/assets.mjs', '../node_modules/typescript/bin/tsc'),
  key('web/test-support/browser-pin.mjs', '../node_modules/playwright-core/package.json'),
  key('web/test/browser-case-diagnostics.test.mjs', '../node_modules/playwright/package.json'),
  key('web/test/browser-case-diagnostics.test.mjs', '../node_modules/playwright/lib/runner/taskRunner.js'),
  ...['lib/reporters/base.js', 'lib/util.js', 'package.json'].map(name =>
    key('web/test/browser-suite-launch.test.mjs', `../node_modules/playwright/${name}`)),
  ...['index.mjs', 'cli.js', 'package.json'].map(name =>
    key('web/test/browser-case-diagnostics.test.mjs', `../node_modules/@playwright/test/${name}`)),
]);
const retired = new Set([
  key('web/test/fixed-head-retirement.test.mjs', '../test-support/fixed-head.mjs'),
  key('web/test/fixed-head-retirement.test.mjs', './fixed-head-observer.test.mjs'),
]);

export function references(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error(`${path}: source parse failed`);
  const refs = [];
  const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
  function add(node, value, kind, absent = false) {
    if (!value.startsWith('./') && !value.startsWith('../')) return;
    refs.push({ source: path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      target: value, kind, absent });
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && literal(node.moduleSpecifier)) {
      add(node, node.moduleSpecifier.text, 'module-import');
    } else if (ts.isCallExpression(node) && literal(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
      add(node, node.arguments[0].text, 'module-import');
    } else if (ts.isNewExpression(node) && node.expression.getText(source) === 'URL'
      && node.arguments?.length === 2 && literal(node.arguments[0])
      && node.arguments[1].getText(source) === 'import.meta.url') {
      const target = node.arguments[0].text;
      // These two actual assertions require absence. Do not restore the retired files.
      const absent = retired.has(key(path, target)) && ts.isCallExpression(node.parent)
        && node.parent.expression.getText(source) === 'assertRetired';
      add(node, target, 'module-url', absent);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return refs;
}

export function audit(files, available = new Set(files.keys()), installedFile = () => false) {
  const dirs = new Set(['.']);
  for (const path of available) {
    for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent)) dirs.add(parent);
  }
  const errors = [], counts = { modules: 0, references: 0, installed: 0, generated: 0, absent: 0 };
  for (const [path, text] of files) {
    if (!/\.(?:mjs|js|ts)$/.test(path)) continue;
    counts.modules++;
    for (const ref of references(path, text)) {
      counts.references++;
      const target = posix.normalize(posix.join(posix.dirname(path), ref.target.split(/[?#]/, 1)[0])).replace(/\/+$/, '') || '.';
      const present = available.has(target) || dirs.has(target);
      if (ref.absent) {
        counts.absent++;
        if (present) errors.push(`${path}:${ref.line}: retired target unexpectedly exists: ${ref.target}`);
        continue;
      }
      if (ref.kind === 'module-url' && key(path, ref.target) === key('scripts/cli_retest.mjs', '../target/debug/wi')) {
        counts.generated++; // cargo build produces this binary; no source file is omitted.
        continue;
      }
      if (installed.has(key(path, ref.target))) {
        counts.installed++;
        if (!installedFile(target)) errors.push(`${path}:${ref.line}: installed input missing: ${ref.target}`);
        continue;
      }
      const tsSource = ref.kind === 'module-import' && path.endsWith('.ts') && target.endsWith('.js')
        && available.has(target.slice(0, -3) + '.ts');
      if (!present && !tsSource) errors.push(`${path}:${ref.line}: missing ${ref.kind}: ${ref.target}`);
    }
  }
  return { errors, counts };
}

export function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  if (!tracked.length) throw new Error('no tracked files');
  const files = new Map();
  const within = path => path === root || path.startsWith(root + sep);
  for (const path of tracked) {
    if (!/\.(?:mjs|js|ts)$/.test(path)) continue;
    const full = resolve(root, path);
    if (!within(realpathSync(full)) || !statSync(full).isFile()) throw new Error(`${path}: invalid tracked input`);
    files.set(path, readFileSync(full, 'utf8'));
  }
  const result = audit(files, new Set(tracked), path => {
    const full = resolve(root, path);
    return existsSync(full) && within(realpathSync(full)) && statSync(full).isFile();
  });
  console.log('Module reference audit:', JSON.stringify(result.counts));
  for (const error of result.errors) console.error(error);
  console.log(`Broken module references: ${result.errors.length}`);
  console.log('Scope: parsed imports and static import.meta.url paths; embedded code and dynamic paths require their own execution tests.');
  return result.errors.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
