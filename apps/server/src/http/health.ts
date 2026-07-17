import type { ServerResponse } from "node:http";

export function handleHealth(response: ServerResponse): void {
  const body = JSON.stringify({ status: "ok" });
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}
