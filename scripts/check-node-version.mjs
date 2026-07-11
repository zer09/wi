const REQUIRED_NODE_MAJOR = 24;

export function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);

  if (major !== REQUIRED_NODE_MAJOR) {
    throw new Error(
      `Wi requires Node.js ${REQUIRED_NODE_MAJOR} LTS; received ${version}.`,
    );
  }
}

try {
  assertSupportedNodeVersion();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
