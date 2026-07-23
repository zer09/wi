import { SessionStoreManager } from "@wi/storage";

const [homeDirectory] = process.argv.slice(2);
if (homeDirectory === undefined) process.exit(64);

const storage = new SessionStoreManager({ homeDirectory });
await storage.ready();
await storage.close(Date.now() + 60_000);
process.stdout.write("close-returned\n");
