import { isAbsolute, resolve } from 'node:path';
import { prepareBrowser } from '../test-support/browser-pin.mjs';

export async function run(argv, prepare = prepareBrowser, stderr = process.stderr) {
  if (argv.length !== 2 || argv[0] !== '--output' || typeof argv[1] !== 'string'
    || !argv[1].isWellFormed() || /[\u0000-\u001f\u007f]/.test(argv[1]) || !isAbsolute(argv[1])
    || resolve(argv[1]) !== argv[1] || argv[1] === '/') {
    stderr.write('browser_preparation: invalid invocation.\n');
    return 2;
  }
  try { await prepare({ output: argv[1] }); }
  catch {
    stderr.write('browser_preparation: preparation failed; owned partial cache is retained.\n');
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
