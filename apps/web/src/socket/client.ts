import {
  ClientMessageSchema,
  ServerMessageSchema,
  createId,
  type CommandMessage,
  type ServerMessage,
} from "@wi/protocol";

import { assertBrowserCommandSize } from "./command-size.js";
import { ReconnectPolicy, type ReconnectPolicyOptions } from "./reconnect.js";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "handshaking"
  | "connected"
  | "reconnecting"
  | "closed"
  | "error";

export interface ConnectionSnapshot {
  readonly status: ConnectionStatus;
  readonly reconnectDelayMs: number | null;
  readonly closeCode: number | null;
  readonly detail: string | null;
}

export interface PendingCommand {
  readonly command: CommandMessage;
  readonly phase: "queued" | "sent";
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string, protocol: string) => WebSocketLike;

type TimerHandle = unknown;

interface SessionReplayRetry {
  readonly policy: ReconnectPolicy;
  timer: TimerHandle | null;
  delayMs: number | null;
}

export interface WiSocketClientOptions {
  readonly url: string;
  readonly protocol: string;
  readonly clientId?: string;
  readonly socketFactory?: WebSocketFactory;
  readonly reconnect?: ReconnectPolicyOptions;
  readonly setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
  readonly idSource?: () => string;
  readonly onMessage: (message: ServerMessage) => void;
  readonly onConnectionChange: (snapshot: ConnectionSnapshot) => void;
  readonly onPendingCommandsChange: (commands: readonly PendingCommand[]) => void;
}

function defaultSocketFactory(url: string, protocol: string): WebSocketLike {
  return new WebSocket(url, protocol);
}

function defaultIdSource(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

function textFrame(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  throw new TypeError("The server sent a non-text WebSocket frame");
}

export class WiSocketClient {
  private readonly clientId: string;
  private readonly socketFactory: WebSocketFactory;
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly idSource: () => string;
  private readonly sessions = new Map<string, number>();
  private readonly helloSessions = new Map<string, number>();
  private readonly sessionReplayRetries = new Map<string, SessionReplayRetry>();
  private readonly pending = new Map<string, PendingCommand>();
  private socket: WebSocketLike | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private welcomed = false;
  private stopped = false;
  private snapshotValue: ConnectionSnapshot = {
    status: "idle",
    reconnectDelayMs: null,
    closeCode: null,
    detail: null,
  };

  constructor(private readonly options: WiSocketClientOptions) {
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.reconnectPolicy = new ReconnectPolicy(options.reconnect);
    this.setTimer =
      options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
    this.idSource = options.idSource ?? defaultIdSource;
    this.clientId = options.clientId ?? createId("client", this.idSource);
  }

  get snapshot(): ConnectionSnapshot {
    return this.snapshotValue;
  }

  getPendingCommand(commandId: string): CommandMessage | undefined {
    return this.pending.get(commandId)?.command;
  }

  hasOpenSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  connect(): void {
    if (this.stopped || this.socket !== null || this.reconnectTimer !== null) return;
    this.openSocket(this.snapshotValue.status === "idle" ? "connecting" : "reconnecting");
  }

  openSession(sessionId: string, afterSequence: number): void {
    const existed = this.sessions.has(sessionId);
    this.sessions.set(sessionId, afterSequence);
    if (!existed && this.welcomed) this.sendSubscribe(sessionId, afterSequence);
  }

  updateCursor(sessionId: string, afterSequence: number): void {
    if (this.sessions.has(sessionId)) this.sessions.set(sessionId, afterSequence);
  }

  resubscribe(sessionId: string, afterSequence: number): void {
    this.clearSessionReplayRetry(sessionId);
    this.sessions.set(sessionId, afterSequence);
    if (this.welcomed) this.sendSubscribe(sessionId, afterSequence);
  }

  retrySession(sessionId: string, afterSequence: number): number | null {
    this.sessions.set(sessionId, afterSequence);
    if (!this.welcomed) return null;
    let retry = this.sessionReplayRetries.get(sessionId);
    if (retry === undefined) {
      retry = {
        policy: new ReconnectPolicy(this.options.reconnect),
        timer: null,
        delayMs: null,
      };
      this.sessionReplayRetries.set(sessionId, retry);
    }
    if (retry.timer !== null) return retry.delayMs;
    const delayMs = retry.policy.nextDelayMs();
    retry.delayMs = delayMs;
    retry.timer = this.setTimer(() => {
      retry.timer = null;
      retry.delayMs = null;
      if (this.welcomed && this.sessions.has(sessionId)) {
        this.sendSubscribe(sessionId, this.sessions.get(sessionId) ?? afterSequence);
      }
    }, delayMs);
    return delayMs;
  }

  completeSessionReplay(sessionId: string): void {
    this.clearSessionReplayRetry(sessionId);
  }

  closeSession(sessionId: string): void {
    this.clearSessionReplayRetry(sessionId);
    if (!this.sessions.delete(sessionId) || !this.welcomed) return;
    this.sendUnsubscribe(sessionId);
  }

  sendCommand(command: CommandMessage): void {
    const parsed = ClientMessageSchema.parse(command);
    if (parsed.kind !== "command") throw new TypeError("Expected a command message");
    assertBrowserCommandSize(parsed);
    const existing = this.pending.get(parsed.commandId);
    if (existing !== undefined) {
      if (JSON.stringify(existing.command) !== JSON.stringify(parsed)) {
        throw new Error("A pending command ID cannot be reused with different content");
      }
      return;
    }
    this.pending.set(parsed.commandId, { command: parsed, phase: "queued" });
    this.notifyPending();
    this.sendPendingCommands();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.welcomed = false;
    this.helloSessions.clear();
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearSessionReplayRetries();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close(1000, "client closed");
    }
    this.updateConnection({
      status: "closed",
      reconnectDelayMs: null,
      closeCode: 1000,
      detail: null,
    });
  }

  private openSocket(status: "connecting" | "reconnecting"): void {
    this.updateConnection({ status, reconnectDelayMs: null, closeCode: null, detail: null });
    let socket: WebSocketLike;
    try {
      socket = this.socketFactory(this.options.url, this.options.protocol);
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : "Connection failed");
      return;
    }
    this.socket = socket;
    this.welcomed = false;
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      this.updateConnection({
        status: "handshaking",
        reconnectDelayMs: null,
        closeCode: null,
        detail: null,
      });
      const resume = [...this.sessions];
      this.helloSessions.clear();
      for (const [sessionId, afterSequence] of resume) {
        this.helloSessions.set(sessionId, afterSequence);
      }
      this.send({
        v: 1,
        kind: "hello",
        clientId: this.clientId,
        resume: resume.map(([sessionId, afterSequence]) => ({ sessionId, afterSequence })),
      });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.stopped) return;
      this.receive(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null;
      this.welcomed = false;
      this.helloSessions.clear();
      this.clearSessionReplayRetries();
      for (const [commandId, pending] of this.pending) {
        this.pending.set(commandId, { command: pending.command, phase: "queued" });
      }
      this.notifyPending();
      if ([1002, 1003, 1007, 1008, 1009].includes(event.code)) {
        this.updateConnection({
          status: "error",
          reconnectDelayMs: null,
          closeCode: event.code,
          detail: event.reason || "The server rejected the connection.",
        });
        return;
      }
      this.scheduleReconnect(event.reason || "Connection lost", event.code);
    };
    socket.onerror = () => {
      if (this.socket !== socket || this.stopped) return;
      this.updateConnection({
        ...this.snapshotValue,
        detail: "The WebSocket reported a transport error.",
      });
    };
  }

  private receive(frame: unknown): void {
    let message: ServerMessage;
    try {
      message = ServerMessageSchema.parse(JSON.parse(textFrame(frame)));
    } catch {
      this.updateConnection({
        status: "error",
        reconnectDelayMs: null,
        closeCode: 1002,
        detail: "The server sent an invalid protocol message.",
      });
      const socket = this.socket;
      this.socket = null;
      this.welcomed = false;
      this.helloSessions.clear();
      socket?.close(1002, "invalid server message");
      return;
    }

    if (message.kind === "welcome") {
      this.welcomed = true;
      for (const sessionId of this.helloSessions.keys()) {
        if (!this.sessions.has(sessionId)) this.sendUnsubscribe(sessionId);
      }
      for (const [sessionId, afterSequence] of this.sessions) {
        if (this.helloSessions.get(sessionId) !== afterSequence) {
          this.sendSubscribe(sessionId, afterSequence);
        }
      }
      this.helloSessions.clear();
      this.reconnectPolicy.reset();
      this.updateConnection({
        status: "connected",
        reconnectDelayMs: null,
        closeCode: null,
        detail: null,
      });
      this.options.onMessage(message);
      this.sendPendingCommands();
      return;
    }

    this.options.onMessage(message);
    if (message.kind === "command.accepted" || message.kind === "command.rejected") {
      this.pending.delete(message.commandId);
      this.notifyPending();
    }
  }

  private sendPendingCommands(): void {
    if (!this.welcomed) return;
    for (const [commandId, pending] of this.pending) {
      if (pending.phase === "sent") continue;
      if (!this.send(pending.command)) return;
      this.pending.set(commandId, { command: pending.command, phase: "sent" });
    }
    this.notifyPending();
  }

  private clearSessionReplayRetry(sessionId: string): void {
    const retry = this.sessionReplayRetries.get(sessionId);
    if (retry !== undefined && retry.timer !== null) this.clearTimer(retry.timer);
    this.sessionReplayRetries.delete(sessionId);
  }

  private clearSessionReplayRetries(): void {
    for (const sessionId of this.sessionReplayRetries.keys()) {
      this.clearSessionReplayRetry(sessionId);
    }
  }

  private sendSubscribe(sessionId: string, afterSequence: number): void {
    this.send({
      v: 1,
      kind: "subscribe",
      requestId: createId("request", this.idSource),
      sessionId,
      afterSequence,
    });
  }

  private sendUnsubscribe(sessionId: string): void {
    this.send({
      v: 1,
      kind: "unsubscribe",
      requestId: createId("request", this.idSource),
      sessionId,
    });
  }

  private send(message: Parameters<typeof ClientMessageSchema.parse>[0]): boolean {
    if (this.socket === null || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(ClientMessageSchema.parse(message)));
    return true;
  }

  private scheduleReconnect(detail: string, closeCode: number | null = null): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = this.reconnectPolicy.nextDelayMs();
    this.updateConnection({
      status: "reconnecting",
      reconnectDelayMs: delay,
      closeCode,
      detail,
    });
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.openSocket("reconnecting");
    }, delay);
  }

  private notifyPending(): void {
    this.options.onPendingCommandsChange([...this.pending.values()]);
  }

  private updateConnection(snapshot: ConnectionSnapshot): void {
    this.snapshotValue = snapshot;
    this.options.onConnectionChange(snapshot);
  }
}
