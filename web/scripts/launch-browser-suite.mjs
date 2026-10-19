import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { launchBrowserSuite } from '../test-support/browser-suite-launch.mjs';

export async function run(argv, launch = launchBrowserSuite, stderr = process.stderr,
  terminate = signal => process.kill(process.pid, signal)) {
  if (argv.length !== 2 || argv[0] !== '--bundle' || typeof argv[1] !== 'string' || !argv[1].isWellFormed()
    || argv[1].includes('\0') || !isAbsolute(argv[1]) || resolve(argv[1]) !== argv[1]
    || basename(argv[1]) !== 'suite-ready.json' || basename(dirname(argv[1])) !== 'control') {
    stderr.write('browser_suite_launch: invalid invocation.\n'); return 2;
  }
  try {
    const result = await launch({ bundle: argv[1] });
    if (result.signal !== null) {
      // The launcher has finished safe recording and removed its temporary signal listeners.
      terminate(result.signal); return 1;
    }
    return result.code;
  } catch {
    stderr.write('browser_suite_launch: launch control failed; consumed records are retained.\n'); return 1;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
