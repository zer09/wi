import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const statePath = process.env.WI_TEST_SUPPORT_PREANCHOR_IMPORT_STATE_PATH;
if (statePath === undefined) throw new Error("Missing pre-anchor import state path");
const descendant = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
  { env: { ...process.env, NODE_OPTIONS: "" }, stdio: "ignore" },
);
if (descendant.pid === undefined) throw new Error("Missing pre-anchor descendant PID");
writeFileSync(
  statePath,
  JSON.stringify({ fixturePid: process.pid, descendantPid: descendant.pid }),
);
throw new Error("Injected caller preload failure");
