import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { LoopbackRequestPolicy } from "./origin-policy.js";

function upgradeRequest(options: {
  readonly host: string;
  readonly origin: string;
  readonly protocol?: string;
  readonly key?: string;
  readonly version?: string;
  readonly connection?: string;
  readonly upgrade?: string;
  readonly rawHosts?: readonly string[];
  readonly rawOrigins?: readonly string[];
}): IncomingMessage {
  const rawHosts = options.rawHosts ?? [options.host];
  const rawOrigins = options.rawOrigins ?? [options.origin];
  return {
    headers: {
      host: options.host,
      origin: options.origin,
      ...(options.protocol === undefined
        ? {}
        : { "sec-websocket-protocol": options.protocol }),
    },
    rawHeaders: [
      ...rawHosts.flatMap((host) => ["Host", host]),
      ...rawOrigins.flatMap((origin) => ["Origin", origin]),
      "Connection",
      options.connection ?? "Upgrade",
      "Upgrade",
      options.upgrade ?? "websocket",
      "Sec-WebSocket-Version",
      options.version ?? "13",
      "Sec-WebSocket-Key",
      options.key ?? "dGhlIHNhbXBsZSBub25jZQ==",
      ...(options.protocol === undefined
        ? []
        : ["Sec-WebSocket-Protocol", options.protocol]),
    ],
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

describe("LoopbackRequestPolicy", () => {
  it("requires exactly the advertised WebSocket subprotocol", () => {
    const policy = new LoopbackRequestPolicy();
    policy.setListeningPort(4317);
    const base = { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" };

    expect(policy.validateUpgrade(upgradeRequest(base))).toBe("unsupported_subprotocol");
    expect(
      policy.validateUpgrade(upgradeRequest({ ...base, protocol: "wi.v1, wi.v1" })),
    ).toBe("unsupported_subprotocol");
    for (const protocol of ["wi.v1,", ",wi.v1", "wi.v1,,"]) {
      expect(policy.validateUpgrade(upgradeRequest({ ...base, protocol }))).toBe(
        "unsupported_subprotocol",
      );
    }
    expect(policy.validateUpgrade(upgradeRequest({ ...base, protocol: "wi.v1" }))).toBeNull();
  });

  it("rejects malformed mandatory handshake fields before ws handles the upgrade", () => {
    const policy = new LoopbackRequestPolicy();
    policy.setListeningPort(4317);
    const base = {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      protocol: "wi.v1",
    };

    expect(policy.validateUpgrade(upgradeRequest({ ...base, version: "12" }))).toBe(
      "invalid_handshake",
    );
    expect(policy.validateUpgrade(upgradeRequest({ ...base, key: "not-a-websocket-key" }))).toBe(
      "invalid_handshake",
    );
    expect(policy.validateUpgrade(upgradeRequest({ ...base, connection: "keep-alive" }))).toBe(
      "invalid_handshake",
    );
    expect(policy.validateUpgrade(upgradeRequest({ ...base, upgrade: "not-websocket" }))).toBe(
      "invalid_handshake",
    );
  });

  it("accepts the effective default HTTP port without URL-normalization mismatch", () => {
    const policy = new LoopbackRequestPolicy();
    policy.setListeningPort(80);

    expect(
      policy.validateHttpHost(
        upgradeRequest({ host: "127.0.0.1:80", origin: "http://127.0.0.1:80" }),
      ),
    ).toBe(true);
    expect(
      policy.validateHttpHost(
        upgradeRequest({ host: "127.0.0.1", origin: "http://127.0.0.1" }),
      ),
    ).toBe(true);
    expect(
      policy.validateUpgrade(
        upgradeRequest({
          host: "127.0.0.1:80",
          origin: "http://127.0.0.1:80",
          protocol: "wi.v1",
        }),
      ),
    ).toBeNull();
  });

  it("rejects numeric loopback aliases before URL normalization", () => {
    const policy = new LoopbackRequestPolicy();
    policy.setListeningPort(4317);

    for (const host of ["2130706433:4317", "0x7f000001:4317"]) {
      const request = upgradeRequest({
        host,
        origin: "http://127.0.0.1:4317",
        protocol: "wi.v1",
      });
      expect(policy.validateHttpHost(request)).toBe(false);
      expect(policy.validateUpgrade(request)).toBe("invalid_host");
    }
    expect(
      policy.validateUpgrade(
        upgradeRequest({
          host: "LOCALHOST:4317",
          origin: "http://localhost:4317",
          protocol: "wi.v1",
        }),
      ),
    ).toBeNull();
  });

  it("rejects missing or duplicate raw Host fields before authority parsing", () => {
    const policy = new LoopbackRequestPolicy();
    policy.setListeningPort(4317);
    const base = {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      protocol: "wi.v1",
    };

    const duplicate = upgradeRequest({
      ...base,
      rawHosts: [base.host, "evil.invalid"],
    });
    const missing = upgradeRequest({ ...base, rawHosts: [] });

    expect(policy.validateHttpHost(duplicate)).toBe(false);
    expect(policy.validateUpgrade(duplicate)).toBe("invalid_host");
    expect(policy.validateHttpHost(missing)).toBe(false);
    expect(policy.validateUpgrade(missing)).toBe("invalid_host");

    const duplicateOrigin = upgradeRequest({
      ...base,
      rawOrigins: [base.origin, "http://evil.invalid"],
    });
    expect(policy.validateUpgrade(duplicateOrigin)).toBe("invalid_origin");
  });
});
