import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { launchBrowserSuite } from '../test-support/browser-suite-launch.mjs';
import { preparationRedactor, sanitizeRecord } from '../test-support/browser-fixture-preparation.mjs';

const fallback = 'browser_suite_launch: failure diagnostics unavailable.\n';
const stages = ['admission', 'guard', 'guard_recheck', 'outer', 'dispatch_recheck', 'stop_before_dispatch',
  'child', 'launch_receipt', 'post_readback', 'markers', 'final_readback', 'outcome_record'];
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL', 'SIGQUIT', 'SIGABRT', 'SIGPIPE', 'SIGUSR1', 'SIGUSR2'];
const boolean = value => typeof value === 'boolean' ? value : null;
const code = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function signal(value) {
  if (typeof value !== 'string') return null;
  return signals.includes(value) ? value : 'unknown';
}
function failureDiagnostic(result) {
  try {
    const outcome = result.outcome;
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return fallback;
    const child = outcome.child, firstFailure = outcome.first_failure;
    // Project observations only. Never enumerate the private outcome or infer case results.
    const projection = { version: 1, scope: 'invocation observations only', consumed: boolean(outcome.consumed),
      first_failure: stages.includes(firstFailure) ? firstFailure : null,
      child: { spawned: boolean(child?.spawned), closed: boolean(child?.closed), error_observed: boolean(child?.error_observed),
        code: code(child?.code), signal: signal(child?.signal) },
      terminal: { code: code(result.code), signal: signal(result.signal) } };
    if (!isDeepStrictEqual(sanitizeRecord(projection, preparationRedactor(process.env)), projection)) return fallback;
    const line = 'browser_suite_launch: failure ' + JSON.stringify(projection) + '\n';
    return Buffer.byteLength(line, 'utf8') <= 1024 ? line : fallback;
  } catch { return fallback; }
}
async function writeDiagnostic(stderr, line) {
  let onError;
  try {
    await new Promise(resolve => {
      let scheduled = false;
      const complete = () => {
        // Writable can emit error after its callback. Keep the observer through that turn.
        if (!scheduled) { scheduled = true; setImmediate(resolve); }
      };
      onError = complete;
      stderr.on?.('error', onError);
      try { stderr.write(line, complete); } catch { complete(); }
    });
  } catch { /* Failed diagnostics must not replace the known terminal. */ }
  finally { try { stderr.removeListener?.('error', onError); } catch {} }
}

export async function run(argv, launch = launchBrowserSuite, stderr = process.stderr,
  terminate = signal => process.kill(process.pid, signal)) {
  if (argv.length !== 2 || argv[0] !== '--bundle' || typeof argv[1] !== 'string' || !argv[1].isWellFormed()
    || argv[1].includes('\0') || !isAbsolute(argv[1]) || resolve(argv[1]) !== argv[1]
    || basename(argv[1]) !== 'suite-ready.json' || basename(dirname(argv[1])) !== 'control') {
    stderr.write('browser_suite_launch: invalid invocation.\n'); return 2;
  }
  try {
    const result = await launch({ bundle: argv[1] });
    if (result.code !== 0 || result.signal !== null) await writeDiagnostic(stderr, failureDiagnostic(result));
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
