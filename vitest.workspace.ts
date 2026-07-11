import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
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
