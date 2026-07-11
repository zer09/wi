import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

function readRootFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").trim();
}

describe("Node.js preflight", () => {
  it("pins Node.js 24 consistently", () => {
    const packageJson = JSON.parse(readRootFile("package.json")) as {
      engines: { node: string };
    };

    expect(readRootFile(".node-version")).toBe("24");
    expect(readRootFile(".nvmrc")).toBe("24");
    expect(packageJson.engines.node).toBe(">=24 <25");
  });

  it("passes under the current runtime", () => {
    expect(process.versions.node.split(".")[0]).toBe("24");
    expect(() =>
      execFileSync(process.execPath, ["scripts/check-node-version.mjs"], {
        cwd: root,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it.each(["23.0.0", "25.0.0"])("rejects unsupported Node.js version %s", (version) => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { assertSupportedNodeVersion } from "./scripts/check-node-version.mjs"; assertSupportedNodeVersion("${version}");`,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Wi requires Node.js 24 LTS; received ${version}.`);
  });
});
