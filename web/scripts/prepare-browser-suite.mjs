import { isAbsolute, resolve } from 'node:path';
import { prepareBrowserSuite } from '../test-support/browser-suite-preparation.mjs';

export async function run(argv, prepare = prepareBrowserSuite, stderr = process.stderr) {
  if (argv.length !== 2 || argv[0] !== '--output' || typeof argv[1] !== 'string'
    || !argv[1].isWellFormed() || argv[1].includes('\0') || !isAbsolute(argv[1])
    || resolve(argv[1]) !== argv[1] || argv[1] === '/') {
    stderr.write('browser_suite_preparation: invalid invocation.\n');
    return 2;
  }
  try { await prepare({ output: argv[1] }); }
  catch {
    stderr.write('browser_suite_preparation: preparation failed; owned partial records are retained.\n');
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
