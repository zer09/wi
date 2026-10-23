// CLI: node -- scripts/agent_env.mjs --env-file <absolute-approved-json> -- <program> [args...]
// The first -- keeps Node from consuming the launcher's --env-file option.
import { isUtf8 } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';

const KEYS = ['TMPDIR', 'CARGO_TARGET_DIR', 'RUSTFLAGS', 'GIT_OPTIONAL_LOCKS', 'NODE_OPTIONS', 'PATH'];
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const DIAGNOSTICS = {
  invocation: 'agent_env: rejected before execution: invalid invocation.\n',
  environment: 'agent_env: rejected before execution: invalid approved environment.\n',
  launch: 'agent_env: rejected before execution: command could not start.\n',
  control: 'agent_env: failure after child start: process control failed.\n',
  unknown: 'agent_env: execution state unknown: process control failed.\n',
};
const diagnostic = kind => process.stderr.write(DIAGNOSTICS[kind]);

function invocation(argv) {
  if (argv.length < 4 || argv.some(v => typeof v !== 'string' || v.includes('\0'))
    || argv[0] !== '--env-file' || !isAbsolute(argv[1]) || argv[2] !== '--' || argv[3] === '') {
    throw new Error('invalid invocation');
  }
  return { envFile: argv[1], program: argv[3], args: argv.slice(4) };
}

function environment(envFile) {
  const bytes = readFileSync(envFile);
  // Reject invalid bytes so decoding cannot silently change approved values.
  if (!isUtf8(bytes)) throw new Error('invalid approved environment');
  const values = JSON.parse(bytes.toString('utf8'));
  // Node replaces unpaired surrogates when exporting the child environment.
  if (values === null || typeof values !== 'object' || Object.getPrototypeOf(values) !== Object.prototype
    || Object.keys(values).length !== KEYS.length
    || KEYS.some(k => !Object.hasOwn(values, k) || typeof values[k] !== 'string'
      || !values[k].isWellFormed() || values[k].includes('\0'))
    || !isAbsolute(values.TMPDIR) || !isAbsolute(values.CARGO_TARGET_DIR)
    || !values.PATH.split(delimiter).every(p => p !== '' && isAbsolute(p))
    || values.GIT_OPTIONAL_LOCKS !== '0' || values.NODE_OPTIONS !== '') {
    throw new Error('invalid approved environment');
  }
  return values;
}

export async function run(argv, spawnCommand = spawn) {
  let command, approved;
  try { command = invocation(argv); } catch {
    diagnostic('invocation');
    return { code: 2, signal: null };
  }
  try { approved = environment(command.envFile); } catch {
    diagnostic('environment');
    return { code: 2, signal: null };
  }
  let child;
  try {
    child = spawnCommand(command.program, command.args, {
      env: { ...process.env, ...approved }, shell: false, stdio: 'inherit',
    });
  } catch {
    diagnostic('launch');
    return { code: 2, signal: null };
  }

  return new Promise(resolve => {
    let started = false, rejected = false, controlFailed = false;
    const onSpawn = () => { started = true; };
    const failControl = () => {
      if (!controlFailed) diagnostic(started ? 'control' : 'unknown');
      controlFailed = true;
    };
    const onError = () => {
      if (controlFailed || rejected) return;
      if (started) failControl();
      else {
        rejected = true;
        diagnostic('launch');
      }
    };
    const listeners = SIGNALS.map(signal => {
      const forward = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try { if (!child.kill(signal)) failControl(); } catch { failControl(); }
      };
      process.on(signal, forward);
      return [signal, forward];
    });
    child.once('spawn', onSpawn);
    child.on('error', onError);
    child.once('close', (code, signal) => {
      for (const [name, listener] of listeners) process.removeListener(name, listener);
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
      if (rejected) resolve({ code: 2, signal: null });
      else if (!started || (code === null && signal === null)) {
        if (!controlFailed) diagnostic('unknown');
        resolve({ code: 1, signal: null });
      } else {
        // A control error must not turn a child's successful exit into a passing launch.
        resolve({ code: controlFailed && code === 0 ? 1 : code, signal });
      }
    });
  });
}

if (import.meta.main) {
  const result = await run(process.argv.slice(2));
  if (result.signal !== null) {
    // Terminate this wrapper by the same signal, rather than replacing it with a number.
    try { process.kill(process.pid, result.signal); } catch {
      diagnostic('control');
      process.exitCode = 1;
    }
  } else process.exitCode = result.code;
}
