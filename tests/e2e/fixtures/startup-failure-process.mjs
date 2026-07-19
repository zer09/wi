const mode = process.argv[3];

if (mode === "exit") {
  process.exit(17);
}

if (mode === "hang") {
  globalThis.setInterval(() => undefined, 1_000);
} else {
  throw new Error(`Unknown startup failure fixture mode: ${String(mode)}`);
}
