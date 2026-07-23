import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import "./posix-owner-preload.js";

const [fixturePath, ...fixtureArguments] = process.argv.slice(2);
if (fixturePath === undefined) throw new Error("POSIX owner bootstrap has no fixture path");

// The bootstrap is the actual fixture process, so native PID, stdio, IPC, and
// signal behavior remain unchanged after the ownership gate releases it.
process.argv = [process.execPath, fixturePath, ...fixtureArguments];
await import(pathToFileURL(resolve(fixturePath)).href);
