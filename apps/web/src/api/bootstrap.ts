import { BootstrapResponseSchema, type BootstrapResponse } from "@wi/protocol";

export async function fetchBootstrap(signal?: AbortSignal): Promise<BootstrapResponse> {
  const response = await fetch("/bootstrap", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error(`Bootstrap failed with HTTP ${response.status}`);
  }
  return BootstrapResponseSchema.parse(await response.json());
}

export function websocketUrl(path: string): string {
  const url = new URL(path, globalThis.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
