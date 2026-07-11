import { fileURLToPath } from "node:url";

import { defineWorkspace } from "vitest/config";

const protocolSource = fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url));

export default defineWorkspace([
  {
    resolve: {
      alias: {
        "@wi/protocol": protocolSource,
      },
    },
    test: {
      name: "unit",
      environment: "node",
      include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "architecture",
      environment: "node",
      include: ["tests/architecture/**/*.test.ts", "tests/preflight/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "integration",
      environment: "node",
      include: ["tests/integration/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "property",
      environment: "node",
      include: ["tests/property/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "process",
      environment: "node",
      include: ["tests/process/**/*.test.ts"],
    },
  },
]);
