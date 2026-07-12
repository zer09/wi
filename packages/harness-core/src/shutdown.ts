export class ShutdownTimeoutError extends Error {
  constructor(readonly component: string) {
    super(`${component} did not stop before the shutdown deadline`);
    this.name = "ShutdownTimeoutError";
  }
}

export type ShutdownWait = (completion: Promise<void>) => Promise<boolean>;

export function timeoutShutdownWait(timeoutMs: number): ShutdownWait {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("Shutdown timeout must be a nonnegative safe integer");
  }
  return async (completion) =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      void completion.then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        },
      );
    });
}

export const defaultShutdownWait = timeoutShutdownWait(5_000);
