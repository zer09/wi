import { readSync, writeSync } from "node:fs";

const jobName = process.env.WI_TEST_SUPPORT_WINDOWS_JOB_NAME;
const readyDescriptor = process.env.WI_TEST_SUPPORT_WINDOWS_JOB_READY_FD;
const acknowledgementDescriptor =
  process.env.WI_TEST_SUPPORT_WINDOWS_JOB_ACKNOWLEDGEMENT_FD;
const gracefulControlToken = process.env.WI_TEST_SUPPORT_WINDOWS_GRACEFUL_TOKEN;

if (process.platform === "win32" && jobName !== undefined) {
  const { assignCurrentProcessToWindowsJob } = await import("./windows-process-job.js");
  assignCurrentProcessToWindowsJob(jobName);
  delete process.env.WI_TEST_SUPPORT_WINDOWS_JOB_NAME;
  delete process.env.WI_TEST_SUPPORT_WINDOWS_JOB_READY_FD;
  delete process.env.WI_TEST_SUPPORT_WINDOWS_JOB_ACKNOWLEDGEMENT_FD;
  delete process.env.WI_TEST_SUPPORT_WINDOWS_GRACEFUL_TOKEN;
  if (
    readyDescriptor === undefined ||
    acknowledgementDescriptor === undefined ||
    gracefulControlToken === undefined
  ) {
    throw new Error("Windows Job Object preload has no handshake or control credentials");
  }
  writeSync(Number(readyDescriptor), "ready");
  const acknowledged = readSync(
    Number(acknowledgementDescriptor),
    Buffer.alloc(1),
    0,
    1,
    null,
  );
  if (acknowledged !== 1) throw new Error("Windows Job Object handshake was not acknowledged");
  process.on("message", (message: unknown) => {
    if (
      message === null ||
      typeof message !== "object" ||
      !("type" in message) ||
      message.type !== "wi.test-support.graceful-signal" ||
      !("token" in message) ||
      message.token !== gracefulControlToken ||
      !("signal" in message) ||
      (message.signal !== "SIGTERM" && message.signal !== "SIGINT")
    ) {
      return;
    }
    process.emit(message.signal, message.signal);
  });
  // Graceful control must not keep a fixture alive after its own work finishes.
  process.channel?.unref();
}
