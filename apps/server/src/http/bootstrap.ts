import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { BootstrapResponseSchema, type BrowserSessionSummary } from "@wi/protocol";

export const BROWSER_SESSION_COOKIE = "wi_browser_session";

function parseCookies(header: string): Map<string, string[]> {
  const cookies = new Map<string, string[]>();
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1) continue;
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    const values = cookies.get(name) ?? [];
    values.push(value);
    cookies.set(name, values);
  }
  return cookies;
}

export class LocalBrowserAuth {
  private readonly credential = randomBytes(32).toString("base64url");

  cookieHeader(): string {
    return `${BROWSER_SESSION_COOKIE}=${this.credential}; Path=/; HttpOnly; SameSite=Strict`;
  }

  authenticate(cookieHeader: string | undefined): boolean {
    if (cookieHeader === undefined || cookieHeader.length > 8_192) return false;
    const values = parseCookies(cookieHeader).get(BROWSER_SESSION_COOKIE);
    if (values?.length !== 1) return false;
    const supplied = Buffer.from(values[0] ?? "", "utf8");
    const expected = Buffer.from(this.credential, "utf8");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}

export function handleBootstrap(
  response: ServerResponse,
  auth: LocalBrowserAuth,
  sessions: readonly BrowserSessionSummary[],
  sessionsTruncated: boolean,
): void {
  const body = JSON.stringify(
    BootstrapResponseSchema.parse({
      v: 1,
      websocketPath: "/ws",
      websocketProtocol: "wi.v1",
      sessions,
      sessionsTruncated,
    }),
  );
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "set-cookie": auth.cookieHeader(),
  });
  response.end(body);
}
