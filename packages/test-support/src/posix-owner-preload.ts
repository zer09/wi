import { spawn } from "node:child_process";
import { readSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

const readyDescriptor = process.env.WI_TEST_SUPPORT_POSIX_READY_FD;
const acknowledgementDescriptor = process.env.WI_TEST_SUPPORT_POSIX_ACKNOWLEDGEMENT_FD;

async function startProcessGroupAnchor(): Promise<void> {
  const anchorPath = fileURLToPath(new URL("./posix-process-anchor.js", import.meta.url));
  const anchor = spawn(process.execPath, [anchorPath], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      anchor.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      anchor.off("spawn", onSpawn);
      reject(error);
    };
    anchor.once("spawn", onSpawn);
    anchor.once("error", onError);
  });
  anchor.unref();
}

if (process.platform === "linux" && readyDescriptor !== undefined) {
  delete process.env.WI_TEST_SUPPORT_POSIX_READY_FD;
  delete process.env.WI_TEST_SUPPORT_POSIX_ACKNOWLEDGEMENT_FD;
  if (acknowledgementDescriptor === undefined) {
    throw new Error("POSIX owner preload has no acknowledgement pipe");
  }
  // The anchor joins the detached fixture group before user code can run. As
  // long as ownership is retained, Linux cannot allocate its PGID as a PID.
  await startProcessGroupAnchor();
  writeSync(Number(readyDescriptor), "ready");
  const acknowledged = readSync(
    Number(acknowledgementDescriptor),
    Buffer.alloc(1),
    0,
    1,
    null,
  );
  if (acknowledged !== 1) {
    throw new Error("POSIX owner preload was not acknowledged");
  }
}
