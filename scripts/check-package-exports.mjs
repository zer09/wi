import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const expectedExports = {
  "@wi/client-state": ["createBrowserSessionState", "reduceSessionEvent", "replaySessionEvents"],
  "@wi/protocol": ["ClientMessageSchema", "SessionEventSchema", "canonicalJson"],
  "@wi/storage": ["CatalogClient", "SessionStoreManager", "SessionWorkerPool"],
};

const workspaceDirectories = readdirSync(resolve(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(root, "packages", entry.name))
  .filter((directory) => existsSync(resolve(directory, "package.json")));

for (const directory of workspaceDirectories) {
  const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  if (typeof manifest.exports !== "string" || typeof manifest.types !== "string") {
    throw new Error(`${manifest.name} must declare string exports and types entry points`);
  }

  const runtimeEntry = resolve(directory, manifest.exports);
  const typeEntry = resolve(directory, manifest.types);
  if (!existsSync(runtimeEntry)) throw new Error(`${manifest.name} is missing ${manifest.exports}`);
  if (!existsSync(typeEntry)) throw new Error(`${manifest.name} is missing ${manifest.types}`);

  const publicModule = await import(pathToFileURL(runtimeEntry).href);
  for (const exportName of expectedExports[manifest.name] ?? []) {
    if (!(exportName in publicModule)) {
      throw new Error(`${manifest.name} is missing public export ${exportName}`);
    }
  }
}

console.log(`Verified ${workspaceDirectories.length} workspace package entry points.`);
