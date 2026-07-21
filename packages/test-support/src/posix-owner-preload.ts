import { readSync, writeSync } from "node:fs";

const readyDescriptor = process.env.WI_TEST_SUPPORT_POSIX_READY_FD;
const acknowledgementDescriptor = process.env.WI_TEST_SUPPORT_POSIX_ACKNOWLEDGEMENT_FD;

if (process.platform !== "win32" && readyDescriptor !== undefined) {
  delete process.env.WI_TEST_SUPPORT_POSIX_READY_FD;
  delete process.env.WI_TEST_SUPPORT_POSIX_ACKNOWLEDGEMENT_FD;
  if (acknowledgementDescriptor === undefined) {
    throw new Error("POSIX owner preload has no acknowledgement pipe");
  }
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
