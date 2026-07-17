import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export type UpgradeRejection =
  | "invalid_host"
  | "invalid_origin"
  | "non_loopback_peer"
  | "invalid_handshake"
  | "unsupported_subprotocol";

export class LoopbackRequestPolicy {
  private readonly allowedHostnames: ReadonlySet<string>;
  private port: number | null = null;

  constructor() {
    this.allowedHostnames = new Set(["127.0.0.1", "localhost"]);
  }

  setListeningPort(port: number): void {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new RangeError("Listening port must be an integer between 1 and 65535");
    }
    if (this.port !== null && this.port !== port) {
      throw new Error("Listening port cannot change while a request policy is active");
    }
    this.port = port;
  }

  private rawHeader(request: IncomingMessage, name: string): string | null {
    let value: string | null = null;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() !== name) continue;
      const candidate = request.rawHeaders[index + 1];
      if (value !== null || candidate === undefined) return null;
      value = candidate;
    }
    return value;
  }

  private hostHeader(request: IncomingMessage): string | null {
    return this.rawHeader(request, "host");
  }

  private originHeader(request: IncomingMessage): string | null {
    return this.rawHeader(request, "origin");
  }

  private hasValidHandshakeFields(request: IncomingMessage): boolean {
    const key = this.rawHeader(request, "sec-websocket-key");
    const version = this.rawHeader(request, "sec-websocket-version");
    const upgrade = this.rawHeader(request, "upgrade");
    const connection = this.rawHeader(request, "connection");
    if (
      key === null ||
      version !== "13" ||
      upgrade?.toLowerCase() !== "websocket" ||
      connection === null
    ) {
      return false;
    }
    if (!/^[A-Za-z0-9+/]{22}==$/u.test(key)) return false;
    const decodedKey = Buffer.from(key, "base64");
    if (decodedKey.byteLength !== 16 || decodedKey.toString("base64") !== key) return false;
    const connectionTokens = connection.split(",").map((token) => token.trim());
    if (
      connectionTokens.some(
        (token) =>
          token.length === 0 ||
          !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(token),
      ) ||
      !connectionTokens.some((token) => token.toLowerCase() === "upgrade")
    ) {
      return false;
    }
    return true;
  }

  private authority(hostHeader: string | null): string | null {
    if (this.port === null || hostHeader === null || hostHeader.length > 255) return null;
    if (hostHeader.includes(",") || /[\s/@\\]/u.test(hostHeader)) return null;
    const literalAuthority = /^(127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/iu.exec(hostHeader);
    const literalHostname = literalAuthority?.[1]?.toLowerCase();
    if (literalHostname === undefined || !this.allowedHostnames.has(literalHostname)) return null;
    let parsed: URL;
    try {
      parsed = new URL(`http://${hostHeader}/`);
    } catch {
      return null;
    }
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== literalHostname) return null;
    const effectivePort = parsed.port === "" ? 80 : Number(parsed.port);
    if (effectivePort !== this.port) return null;
    return parsed.host.toLowerCase();
  }

  validateHttpHost(request: IncomingMessage): boolean {
    return this.authority(this.hostHeader(request)) !== null;
  }

  validateUpgrade(request: IncomingMessage): UpgradeRejection | null {
    const authority = this.authority(this.hostHeader(request));
    if (authority === null) return "invalid_host";
    if (!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? "")) return "non_loopback_peer";

    const originHeader = this.originHeader(request);
    if (originHeader === null || originHeader.length > 512) return "invalid_origin";
    let origin: URL;
    try {
      origin = new URL(originHeader);
    } catch {
      return "invalid_origin";
    }
    if (
      origin.protocol !== "http:" ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== "" ||
      origin.host.toLowerCase() !== authority
    ) {
      return "invalid_origin";
    }

    if (!this.hasValidHandshakeFields(request)) return "invalid_handshake";

    const protocols = this.rawHeader(request, "sec-websocket-protocol");
    if (protocols === null || protocols.length > 256) return "unsupported_subprotocol";
    const offered = protocols.split(",").map((protocol) => protocol.trim());
    if (
      offered.some(
        (protocol) =>
          protocol.length === 0 ||
          !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(protocol),
      ) ||
      offered.length !== 1 ||
      offered[0] !== "wi.v1"
    ) {
      return "unsupported_subprotocol";
    }
    return null;
  }
}
