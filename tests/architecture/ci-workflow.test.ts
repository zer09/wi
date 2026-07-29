import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");

function jobBlock(name: string, nextName?: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`CI workflow is missing the ${name} job`);
  if (nextName === undefined) return workflow.slice(start);
  const end = workflow.indexOf(`\n  ${nextName}:\n`, start + 1);
  if (end < 0) throw new Error(`CI workflow is missing the ${nextName} job boundary`);
  return workflow.slice(start, end);
}

describe("final CI workflow", () => {
  it("preserves the stable required check over core checks and browser E2E", () => {
    expect(workflow).toMatch(/^name: CI$/mu);

    const checks = jobBlock("checks", "e2e");
    expect(checks).toContain("run: pnpm test:property");
    expect(checks).toContain("run: pnpm test:process");
    expect(checks).toContain("run: pnpm build");

    const e2e = jobBlock("e2e", "required");
    expect(e2e).toContain("name: e2e");
    expect(e2e).toContain("run: pnpm test:e2e");

    const required = jobBlock("required");
    expect(required).toContain("name: required");
    expect(required).toContain("if: ${{ always() }}");
    expect(required).toMatch(/needs:\s*\n\s*- checks\s*\n\s*- e2e/u);
    expect(required).toContain('test "$CHECKS_RESULT" = "success"');
    expect(required).toContain('test "$E2E_RESULT" = "success"');
  });
});
