import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));

function compile(root, flags) {
  const result = spawnSync(process.execPath, [
    compiler, '--project', join(root, 'tsconfig.json'), '--pretty', 'false', ...flags,
  ], { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`TypeScript compilation failed.\n${result.stdout}${result.stderr}`);
  }
}

function readAssets(directory) {
  const files = new Map();
  const info = lstatSync(directory, { throwIfNoEntry: false });
  if (info === undefined) return files;
  if (!info.isDirectory()) throw new Error('Asset output must be a regular directory.');

  function visit(relative) {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) {
        visit(name);
      } else if (entry.isFile()) {
        files.set(name, readFileSync(join(directory, name)));
      } else {
        throw new Error(`Asset output contains a nonregular entry: ${name}`);
      }
    }
  }
  visit('');
  return files;
}

function compareAssets(expected, actual) {
  const differences = [];
  for (const name of [...expected.keys()].sort()) {
    if (!actual.has(name)) {
      differences.push(`missing: ${name}`);
    } else if (!expected.get(name).equals(actual.get(name))) {
      differences.push(`stale: ${name}`);
    }
  }
  for (const name of [...actual.keys()].sort()) {
    if (!expected.has(name)) differences.push(`extra: ${name}`);
  }
  if (differences.length > 0) {
    throw new Error(`Generated assets differ:\n${differences.join('\n')}`);
  }
}

export function runAssets(mode, root = webRoot) {
  if (process.versions.node.split('.')[0] !== '24') {
    throw new Error('Asset tooling requires Node 24.x.');
  }
  if (!['build', 'typecheck', 'verify'].includes(mode)) {
    throw new Error('Use build, typecheck, or verify.');
  }
  if (mode === 'typecheck') {
    compile(root, ['--noEmit']);
    return 'TypeScript typecheck passed.';
  }

  // Keep staging on the same filesystem so publication moves the complete directory.
  const temporary = mkdtempSync(join(root, '.assets-'));
  const output = join(temporary, 'dist');
  const dist = join(root, 'dist');
  let retainTemporary = false;
  try {
    compile(root, ['--outDir', output]);
    const generated = readAssets(output);
    if (generated.size === 0) throw new Error('TypeScript emitted no assets.');
    if (mode === 'verify') {
      // Walk the filesystem, not Git, so untracked and hidden output files count too.
      compareAssets(generated, readAssets(dist));
      return `Verified ${generated.size} generated asset(s).`;
    }

    const previous = join(temporary, 'previous');
    const current = lstatSync(dist, { throwIfNoEntry: false });
    if (current !== undefined) {
      if (!current.isDirectory()) throw new Error('Asset output must be a regular directory.');
      renameSync(dist, previous);
    }
    try {
      renameSync(output, dist);
    } catch (error) {
      if (current !== undefined) {
        try {
          renameSync(previous, dist);
        } catch {
          // Keep the old assets available if the filesystem also refuses restoration.
          retainTemporary = true;
          throw new Error(`Asset publication failed; previous assets remain at ${previous}.`, { cause: error });
        }
      }
      throw error;
    }
    return `Built ${generated.size} generated asset(s).`;
  } finally {
    if (!retainTemporary) rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('Use build, typecheck, or verify.');
    console.log(runAssets(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
