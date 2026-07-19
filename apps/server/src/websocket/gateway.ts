import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { BrowserCommandLimits } from "@wi/protocol";
import { SESSION_EVENT_PAGE_BOUNDS } from "@wi/storage";
import { WebSocketServer } from "ws";
import type { WiRuntime } from "../composition.js";
import type { LocalBrowserAuth } from "../http/bootstrap.js";
import { correlatedHttpError, endRawHttpError } from "../http/rejection.js";
import { nonThrowingLogger, type Logger } from "../logging/logger.js";
import {
  BrowserConnection,
  type ConnectionCommandHooks,
  type ConnectionHeartbeatOptions,
  type ConnectionLimits,
  type ConnectionReplayHooks,
  type ConnectionSnapshot,
} from "./connection.js";
import {
  browserCommandLimits as deriveBrowserCommandLimits,
  maximumDurableCommandPayloadBytes,
} from "./durable-command-limits.js";
import { MINIMUM_WI_V1_CLIENT_FRAME_DEPTH } from "./frame-decoder.js";
import type { LoopbackRequestPolicy, UpgradeRejection } from "./origin-policy.js";

export interface WebSocketGatewayOptions {
  readonly runtime: WiRuntime;
  readonly auth: LocalBrowserAuth;
  readonly requestPolicy: LoopbackRequestPolicy;
  readonly logger: Logger;
  readonly limits?: Omit<
    Partial<ConnectionLimits>,
    "frame" | "outbound" | "maximumDurableCommandPayloadBytes"
  > & {
    readonly frame?: Partial<ConnectionLimits["frame"]>;
    readonly outbound?: Partial<ConnectionLimits["outbound"]>;
  };
  readonly heartbeat?: Partial<ConnectionHeartbeatOptions>;
  readonly replayHooks?: ConnectionReplayHooks;
  readonly commandHooks?: ConnectionCommandHooks;
  readonly shutdownTimeoutMs?: number;
}

export const WEBSOCKET_LIMIT_CAPS = {
  frame: { maximumBytes: 1_024 * 1_024, maximumDepth: 64 },
  outbound: {
    maximumMessages: 4_096,
    maximumBytes: 16 * 1_024 * 1_024,
    maximumSingleMessageBytes: 1_000_000,
  },
  maximumPendingInboundMessages: 1_024,
  maximumPendingInboundBytes: 16 * 1_024 * 1_024,
  maximumProtocolViolations: 16,
  maximumSubscriptions: 256,
  replayLiveEvents: 4_096,
  replayLiveBytes: 16 * 1_024 * 1_024,
  replaySingleEventBytes:
    SESSION_EVENT_PAGE_BOUNDS.maximumBytes - SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes,
  replayPageEvents: SESSION_EVENT_PAGE_BOUNDS.maximumEvents,
  replayPageBytes: SESSION_EVENT_PAGE_BOUNDS.maximumBytes,
  replayPageSingleEventBytes: Math.min(
    SESSION_EVENT_PAGE_BOUNDS.maximumSingleEventBytes,
    SESSION_EVENT_PAGE_BOUNDS.maximumBytes - SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes,
  ),
  replayQueueWaitTimeoutMs: 30_000,
  heartbeatIntervalMs: 60_000,
  helloTimeoutMs: 30_000,
  shutdownTimeoutMs: 30_000,
} as const;

const REJECTED_UPGRADE_DRAIN_TIMEOUT_MS = 2_000;

const DEFAULT_LIMITS: Omit<ConnectionLimits, "maximumDurableCommandPayloadBytes"> = {
  frame: { maximumBytes: 64 * 1_024, maximumDepth: 32 },
  outbound: {
    maximumMessages: 256,
    maximumBytes: 1_024 * 1_024,
    maximumSingleMessageBytes: 256 * 1_024,
  },
  maximumPendingInboundMessages: 64,
  maximumPendingInboundBytes: 512 * 1_024,
  maximumProtocolViolations: 3,
  maximumSubscriptions: 64,
  replayLiveEvents: 1_024,
  replayLiveBytes: 1_024 * 1_024,
  replaySingleEventBytes: 256 * 1_024,
  replayPageEvents: 64,
  replayPageBytes: 256 * 1_024 + SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes,
  replayPageSingleEventBytes: 256 * 1_024,
  replayQueueWaitTimeoutMs: 5_000,
};

function rejectionStatus(rejection: UpgradeRejection): number {
  switch (rejection) {
    case "invalid_host":
      return 421;
    case "invalid_origin":
    case "non_loopback_peer":
      return 403;
    case "invalid_handshake":
      return 400;
    case "unsupported_subprotocol":
      return 426;
  }
}

function rejectionCode(rejection: UpgradeRejection): string {
  switch (rejection) {
    case "invalid_host":
      return "websocket.invalid_host";
    case "invalid_origin":
    case "non_loopback_peer":
      return "websocket.invalid_origin";
    case "invalid_handshake":
      return "websocket.invalid_handshake";
    case "unsupported_subprotocol":
      return "websocket.unsupported_subprotocol";
  }
}

export class WebSocketGateway {
  private readonly options: WebSocketGatewayOptions;
  private readonly server: WebSocketServer;
  private readonly connections = new Set<BrowserConnection>();
  private readonly upgradeSockets = new Set<Duplex>();
  private readonly rejectionDrainTimers = new Map<Duplex, ReturnType<typeof setTimeout>>();
  private readonly limits: ConnectionLimits;
  private readonly heartbeat: ConnectionHeartbeatOptions;
  private readonly shutdownTimeoutMs: number;
  private accepting = true;
  private closePromise: Promise<void> | null = null;

  constructor(options: WebSocketGatewayOptions) {
    this.options = { ...options, logger: nonThrowingLogger(options.logger) };
    const outbound = { ...DEFAULT_LIMITS.outbound, ...options.limits?.outbound };
    this.limits = {
      ...DEFAULT_LIMITS,
      ...options.limits,
      frame: { ...DEFAULT_LIMITS.frame, ...options.limits?.frame },
      outbound,
      replaySingleEventBytes:
        options.limits?.replaySingleEventBytes ??
        Math.min(DEFAULT_LIMITS.replaySingleEventBytes, outbound.maximumSingleMessageBytes),
      replayPageSingleEventBytes:
        options.limits?.replayPageSingleEventBytes ??
        Math.min(DEFAULT_LIMITS.replayPageSingleEventBytes, outbound.maximumSingleMessageBytes),
      // Replaced after all caller-configurable capacity relationships are validated below.
      maximumDurableCommandPayloadBytes: 1,
    };
    const boundedLimits: ReadonlyArray<readonly [string, number, number]> = [
      ["frame byte", this.limits.frame.maximumBytes, WEBSOCKET_LIMIT_CAPS.frame.maximumBytes],
      ["frame depth", this.limits.frame.maximumDepth, WEBSOCKET_LIMIT_CAPS.frame.maximumDepth],
      [
        "outbound message",
        this.limits.outbound.maximumMessages,
        WEBSOCKET_LIMIT_CAPS.outbound.maximumMessages,
      ],
      [
        "outbound byte",
        this.limits.outbound.maximumBytes,
        WEBSOCKET_LIMIT_CAPS.outbound.maximumBytes,
      ],
      [
        "outbound single-message byte",
        this.limits.outbound.maximumSingleMessageBytes,
        WEBSOCKET_LIMIT_CAPS.outbound.maximumSingleMessageBytes,
      ],
      [
        "pending inbound message",
        this.limits.maximumPendingInboundMessages,
        WEBSOCKET_LIMIT_CAPS.maximumPendingInboundMessages,
      ],
      [
        "pending inbound byte",
        this.limits.maximumPendingInboundBytes,
        WEBSOCKET_LIMIT_CAPS.maximumPendingInboundBytes,
      ],
      [
        "protocol violation",
        this.limits.maximumProtocolViolations,
        WEBSOCKET_LIMIT_CAPS.maximumProtocolViolations,
      ],
      ["subscription", this.limits.maximumSubscriptions, WEBSOCKET_LIMIT_CAPS.maximumSubscriptions],
      ["replay live-event", this.limits.replayLiveEvents, WEBSOCKET_LIMIT_CAPS.replayLiveEvents],
      ["replay live-byte", this.limits.replayLiveBytes, WEBSOCKET_LIMIT_CAPS.replayLiveBytes],
      [
        "replay single-event byte",
        this.limits.replaySingleEventBytes,
        WEBSOCKET_LIMIT_CAPS.replaySingleEventBytes,
      ],
      ["replay page-event", this.limits.replayPageEvents, WEBSOCKET_LIMIT_CAPS.replayPageEvents],
      ["replay page-byte", this.limits.replayPageBytes, WEBSOCKET_LIMIT_CAPS.replayPageBytes],
      [
        "replay page single-event byte",
        this.limits.replayPageSingleEventBytes,
        WEBSOCKET_LIMIT_CAPS.replayPageSingleEventBytes,
      ],
      [
        "replay outbound capacity wait",
        this.limits.replayQueueWaitTimeoutMs,
        WEBSOCKET_LIMIT_CAPS.replayQueueWaitTimeoutMs,
      ],
    ];
    for (const [description, value, maximum] of boundedLimits) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new RangeError(
          `WebSocket ${description} limit must be a positive safe integer no greater than ${maximum}`,
        );
      }
    }
    if (this.limits.frame.maximumDepth < MINIMUM_WI_V1_CLIENT_FRAME_DEPTH) {
      throw new RangeError(
        `WebSocket frame depth limit must be at least ${MINIMUM_WI_V1_CLIENT_FRAME_DEPTH}`,
      );
    }
    if (
      this.limits.outbound.maximumSingleMessageBytes > this.limits.outbound.maximumBytes
    ) {
      throw new RangeError("WebSocket single-message limit must fit within the outbound byte limit");
    }
    if (
      this.limits.replaySingleEventBytes > this.limits.replayLiveBytes ||
      this.limits.replaySingleEventBytes > this.limits.outbound.maximumSingleMessageBytes
    ) {
      throw new RangeError("WebSocket replay live event must fit within live and outbound byte limits");
    }
    if (
      this.limits.replayPageEvents > SESSION_EVENT_PAGE_BOUNDS.maximumEvents ||
      this.limits.replayPageBytes < SESSION_EVENT_PAGE_BOUNDS.minimumBytes ||
      this.limits.replayPageBytes > SESSION_EVENT_PAGE_BOUNDS.maximumBytes ||
      this.limits.replayPageSingleEventBytes >
        SESSION_EVENT_PAGE_BOUNDS.maximumSingleEventBytes ||
      this.limits.replayPageSingleEventBytes >
        this.limits.replayPageBytes - SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes ||
      this.limits.replayPageSingleEventBytes > this.limits.outbound.maximumSingleMessageBytes
    ) {
      throw new RangeError(
        "WebSocket replay page limits do not satisfy the bounded storage contract",
      );
    }
    if (this.limits.replaySingleEventBytes > this.limits.replayPageSingleEventBytes) {
      throw new RangeError(
        "WebSocket replay live event limit must not exceed historical replay capacity",
      );
    }
    this.limits = {
      ...this.limits,
      maximumDurableCommandPayloadBytes: maximumDurableCommandPayloadBytes({
        outboundSingleMessageBytes: this.limits.outbound.maximumSingleMessageBytes,
        replayLiveSingleEventBytes: this.limits.replaySingleEventBytes,
        replayPageSingleEventBytes: this.limits.replayPageSingleEventBytes,
      }),
    };
    this.heartbeat = {
      intervalMs: options.heartbeat?.intervalMs ?? 15_000,
      helloTimeoutMs: options.heartbeat?.helloTimeoutMs ?? 10_000,
    };
    if (
      !Number.isSafeInteger(this.heartbeat.intervalMs) ||
      this.heartbeat.intervalMs < 10 ||
      this.heartbeat.intervalMs > WEBSOCKET_LIMIT_CAPS.heartbeatIntervalMs
    ) {
      throw new RangeError(
        `WebSocket heartbeat interval must be between 10 and ${WEBSOCKET_LIMIT_CAPS.heartbeatIntervalMs}ms`,
      );
    }
    if (
      !Number.isSafeInteger(this.heartbeat.helloTimeoutMs) ||
      this.heartbeat.helloTimeoutMs < 10 ||
      this.heartbeat.helloTimeoutMs > WEBSOCKET_LIMIT_CAPS.helloTimeoutMs
    ) {
      throw new RangeError(
        `WebSocket hello timeout must be between 10 and ${WEBSOCKET_LIMIT_CAPS.helloTimeoutMs}ms`,
      );
    }
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
    if (
      !Number.isSafeInteger(this.shutdownTimeoutMs) ||
      this.shutdownTimeoutMs < 1 ||
      this.shutdownTimeoutMs > WEBSOCKET_LIMIT_CAPS.shutdownTimeoutMs
    ) {
      throw new RangeError(
        `WebSocket shutdown timeout must be a positive safe integer no greater than ${WEBSOCKET_LIMIT_CAPS.shutdownTimeoutMs}`,
      );
    }
    this.server = new WebSocketServer({
      noServer: true,
      maxPayload: this.limits.frame.maximumBytes,
      perMessageDeflate: false,
      handleProtocols: (protocols) => (protocols.has("wi.v1") ? "wi.v1" : false),
    });
  }

  get connectionSnapshots(): readonly ConnectionSnapshot[] {
    return [...this.connections].map((connection) => connection.snapshot);
  }

  get browserCommandLimits(): BrowserCommandLimits {
    return deriveBrowserCommandLimits({
      frameMaximumBytes: this.limits.frame.maximumBytes,
      frameMaximumDepth: this.limits.frame.maximumDepth,
      outboundSingleMessageBytes: this.limits.outbound.maximumSingleMessageBytes,
      replayLiveSingleEventBytes: this.limits.replaySingleEventBytes,
      replayPageSingleEventBytes: this.limits.replayPageSingleEventBytes,
    });
  }

  disconnectActiveConnections(code = 1012, reason = "server reconnect requested"): number {
    if (code !== 1012 && (!Number.isSafeInteger(code) || code < 4_000 || code > 4_999)) {
      throw new RangeError("WebSocket disconnect code must be 1012 or an application close code");
    }
    if (Buffer.byteLength(reason) > 123) {
      throw new RangeError("WebSocket disconnect reason exceeds the protocol limit");
    }
    const connections = [...this.connections];
    for (const connection of connections) connection.disconnect(code, reason);
    return connections.length;
  }

  private trackUpgradeSocket(socket: Duplex): void {
    if (socket.destroyed || this.upgradeSockets.has(socket)) return;
    this.upgradeSockets.add(socket);
    socket.once("close", () => {
      this.upgradeSockets.delete(socket);
      const timer = this.rejectionDrainTimers.get(socket);
      if (timer !== undefined) clearTimeout(timer);
      this.rejectionDrainTimers.delete(socket);
    });
  }

  private boundRejectedUpgradeLifetime(socket: Duplex): void {
    const existing = this.rejectionDrainTimers.get(socket);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.rejectionDrainTimers.delete(socket);
      socket.destroy();
    }, REJECTED_UPGRADE_DRAIN_TIMEOUT_MS);
    timer.unref();
    this.rejectionDrainTimers.set(socket, timer);
  }

  private rejectUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    statusCode: number,
    code: string,
    message: string,
    reason: string,
    failure?: { readonly error: unknown },
  ): void {
    const diagnosticId = this.options.runtime.diagnosticId();
    const fields = {
      diagnosticId,
      reason,
      remoteAddress: request.socket.remoteAddress,
    };
    if (failure === undefined) {
      this.options.logger.warn("websocket_upgrade_rejected", fields);
    } else {
      this.options.logger.error("websocket_upgrade_failed", failure.error, fields);
    }
    this.boundRejectedUpgradeLifetime(socket);
    try {
      endRawHttpError(
        socket,
        statusCode,
        correlatedHttpError(code, message, diagnosticId),
      );
    } catch {
      socket.destroy();
    }
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.trackUpgradeSocket(socket);
    if (!this.accepting) {
      this.rejectUpgrade(
        request,
        socket,
        503,
        "websocket.unavailable",
        "The WebSocket gateway is unavailable.",
        "gateway_unavailable",
      );
      return;
    }
    if (request.method !== "GET" || request.url !== "/ws") {
      this.rejectUpgrade(
        request,
        socket,
        404,
        "websocket.not_found",
        "WebSocket endpoint not found.",
        "endpoint_not_found",
      );
      return;
    }
    const rejection = this.options.requestPolicy.validateUpgrade(request);
    if (rejection !== null) {
      this.rejectUpgrade(
        request,
        socket,
        rejectionStatus(rejection),
        rejectionCode(rejection),
        "WebSocket upgrade rejected.",
        rejection,
      );
      return;
    }
    if (!this.options.auth.authenticate(request.headers.cookie)) {
      this.rejectUpgrade(
        request,
        socket,
        401,
        "websocket.unauthorized",
        "WebSocket authentication is required.",
        "unauthorized",
      );
      return;
    }

    try {
      this.server.handleUpgrade(request, socket, head, (webSocket) => {
        if (!this.accepting) {
          webSocket.close(1012, "server shutdown");
          return;
        }
        if (webSocket.protocol !== "wi.v1") {
          webSocket.close(1002, "subprotocol negotiation failed");
          return;
        }
        const connection = new BrowserConnection(
          webSocket,
          request,
          this.options.runtime,
          this.options.logger,
          this.limits,
          this.heartbeat,
          this.options.replayHooks,
          this.options.commandHooks,
        );
        this.connections.add(connection);
        webSocket.once("close", () => {
          this.connections.delete(connection);
        });
        this.server.emit("connection", webSocket, request);
      });
    } catch (error) {
      this.rejectUpgrade(
        request,
        socket,
        500,
        "websocket.upgrade_failed",
        "The WebSocket upgrade could not be completed.",
        "upgrade_failed",
        { error },
      );
    }
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  shutdown(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.stopAccepting();
    this.closePromise = this.finishShutdown();
    return this.closePromise;
  }

  private reportShutdownErrors(errors: readonly unknown[], phase: string): void {
    for (const error of errors) {
      try {
        this.options.logger.error("websocket_shutdown_cleanup_failed", error, {
          diagnosticId: this.options.runtime.diagnosticId(),
          phase,
        });
      } catch {
        // A custom logger cannot interfere with transport isolation.
      }
    }
  }

  private terminateConnections(connections: readonly BrowserConnection[]): readonly unknown[] {
    const errors: unknown[] = [];
    for (const connection of connections) {
      try {
        connection.terminate();
      } catch (error) {
        errors.push(error);
      }
    }
    // Also isolate sockets whose upgrade completed before BrowserConnection registration and raw
    // upgrade sockets that were rejected but whose peer kept its writable half open.
    for (const socket of this.server.clients) {
      try {
        socket.terminate();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const socket of this.upgradeSockets) {
      try {
        socket.destroy();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private clearUpgradeSocketTracking(): void {
    for (const timer of this.rejectionDrainTimers.values()) clearTimeout(timer);
    this.rejectionDrainTimers.clear();
    this.upgradeSockets.clear();
  }

  private closeWebSocketServerBounded(timeoutMs: number): Promise<unknown | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (error: unknown | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(error);
      };
      const timer = setTimeout(() => {
        finish(new Error("WebSocket server did not close within its shutdown deadline"));
      }, timeoutMs);
      timer.unref();
      try {
        this.server.close((error?: Error) => finish(error ?? null));
      } catch (error) {
        finish(error);
      }
    });
  }

  private async finishShutdown(): Promise<void> {
    const connections = [...this.connections];
    const deadline = Date.now() + this.shutdownTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), this.shutdownTimeoutMs);
      timer.unref();
    });
    const graceful = Promise.allSettled(
      connections.map((connection) => connection.shutdown()),
    );
    const outcome = await Promise.race([
      graceful.then((results) => ({ kind: "settled" as const, results })),
      timeout,
    ]);
    if (timer !== undefined) clearTimeout(timer);

    const cleanupErrors =
      outcome.kind === "settled"
        ? outcome.results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          )
        : [];
    const terminationErrors =
      outcome.kind === "timeout" ||
      cleanupErrors.length > 0 ||
      this.server.clients.size > 0 ||
      this.upgradeSockets.size > 0
        ? this.terminateConnections(connections)
        : [];
    const closeError = await this.closeWebSocketServerBounded(
      Math.max(1, deadline - Date.now()),
    );
    this.connections.clear();
    this.clearUpgradeSocketTracking();

    if (outcome.kind === "timeout") {
      // Transport termination happens first; late cleanup failures are only diagnostic.
      void graceful.then((results) => {
        this.reportShutdownErrors(
          results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          ),
          "connection_cleanup_after_timeout",
        );
      });
    } else {
      this.reportShutdownErrors(cleanupErrors, "connection_cleanup");
    }
    this.reportShutdownErrors(terminationErrors, "connection_termination");
    if (closeError !== null) {
      this.reportShutdownErrors([closeError], "websocket_server_close");
    }
  }
}
