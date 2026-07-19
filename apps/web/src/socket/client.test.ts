import { describe, expect, it } from "vitest";
import type {
  BrowserCommandLimits,
  CommandMessage,
  ServerMessage,
} from "@wi/protocol";

import { BrowserCommandJournal } from "../state/command-journal.js";
import {
  BrowserCommandTooLargeError,
  serializedCommandBytes,
} from "./command-size.js";
import {
  WiSocketClient,
  type ConnectionSnapshot,
  type PendingCommand,
  type WebSocketLike,
} from "./client.js";

const TEST_COMMAND_LIMITS: BrowserCommandLimits = {
  v: 1,
  maximumFrameBytes: 60 * 1_024,
  maximumDurablePayloadBytes: 60 * 1_024,
  maximumRawInputCodeUnits: 60 * 1_024,
  maximumRawInputUtf8Bytes: 60 * 1_024,
  maximumJsonDepth: 30,
  maximumJsonNodes: 1_000,
};

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function journal(): BrowserCommandJournal {
  return new BrowserCommandJournal(new MemoryStorage(), "test-owner");
}

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: string[] = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
  }

  serverClose(code = 1006, reason = "lost"): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  messages(): unknown[] {
    return this.sent.map((message) => JSON.parse(message));
  }
}

function welcome(): ServerMessage {
  return {
    v: 1,
    kind: "welcome",
    connectionId: "conn_test",
    serverTimeMs: 1,
    heartbeatIntervalMs: 1_000,
  };
}

describe("WiSocketClient", () => {
  it("resumes cursors and retries only unresolved commands with the same ID", () => {
    const sockets: FakeSocket[] = [];
    const timers = new Map<number, () => void>();
    const pendingSnapshots: (readonly PendingCommand[])[] = [];
    const connectionSnapshots: ConnectionSnapshot[] = [];
    let timerId = 0;
    const client = new WiSocketClient({
      url: "ws://127.0.0.1:4317/ws",
      protocol: "wi.v1",
      commandLimits: TEST_COMMAND_LIMITS,
      journal: journal(),
      clientId: "client_test",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { baseDelayMs: 10, maximumDelayMs: 10, jitterRatio: 0, random: () => 0.5 },
      setTimer: (callback) => {
        timerId += 1;
        timers.set(timerId, callback);
        return timerId;
      },
      clearTimer: (handle) => timers.delete(Number(handle)),
      idSource: () => "test",
      onMessage: () => undefined,
      onConnectionChange: (snapshot) => connectionSnapshots.push(snapshot),
      onPendingCommandsChange: (commands) => pendingSnapshots.push(commands),
    });

    client.openSession("ses_test", 7);
    client.sendCommand({
      v: 1,
      kind: "command",
      commandId: "cmd_retry",
      sessionId: "ses_test",
      method: "message.submit",
      params: { text: "once" },
    });
    client.connect();
    const first = sockets[0];
    expect(first).toBeDefined();
    first?.open();
    expect(first?.messages()[0]).toMatchObject({
      kind: "hello",
      resume: [{ sessionId: "ses_test", afterSequence: 7 }],
    });
    first?.receive(welcome());
    const firstCommand = first?.messages().find((message) =>
      typeof message === "object" && message !== null && "kind" in message && message.kind === "command",
    );
    expect(firstCommand).toMatchObject({ commandId: "cmd_retry" });

    first?.serverClose();
    expect(connectionSnapshots.at(-1)?.status).toBe("reconnecting");
    timers.values().next().value?.();
    const second = sockets[1];
    second?.open();
    second?.receive(welcome());
    const secondCommand = second?.messages().find((message) =>
      typeof message === "object" && message !== null && "kind" in message && message.kind === "command",
    );
    expect(secondCommand).toEqual(firstCommand);

    second?.receive({
      v: 1,
      kind: "command.accepted",
      commandId: "cmd_retry",
      sessionId: "ses_test",
      acceptedSequence: 8,
      runId: "run_test",
      result: { runId: "run_test" },
      duplicate: true,
    });
    expect(pendingSnapshots.at(-1)).toEqual([]);

    second?.serverClose();
    timers.values().next().value?.();
    const third = sockets[2];
    third?.open();
    third?.receive(welcome());
    expect(third?.messages().some((message) =>
      typeof message === "object" && message !== null && "kind" in message && message.kind === "command",
    )).toBe(false);
  });

  it("accepts the exact browser command byte limit and rejects one byte over", () => {
    const pendingSnapshots: (readonly PendingCommand[])[] = [];
    const client = new WiSocketClient({
      url: "ws://127.0.0.1:4317/ws",
      protocol: "wi.v1",
      commandLimits: TEST_COMMAND_LIMITS,
      journal: journal(),
      clientId: "client_sizeBoundary",
      socketFactory: () => new FakeSocket(),
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
      onPendingCommandsChange: (commands) => pendingSnapshots.push(commands),
    });
    const base: CommandMessage = {
      v: 1,
      kind: "command",
      commandId: "cmd_sizeBoundary",
      sessionId: "ses_sizeBoundary",
      method: "message.submit",
      params: { text: "" },
    };
    const exact: CommandMessage = {
      ...base,
      params: {
        text: "x".repeat(TEST_COMMAND_LIMITS.maximumFrameBytes - serializedCommandBytes(base)),
      },
    };
    const oneByteOver: CommandMessage = {
      ...exact,
      params: { text: `${exact.params.text}x` },
    };

    expect(serializedCommandBytes(exact)).toBe(TEST_COMMAND_LIMITS.maximumFrameBytes);
    expect(() => client.sendCommand(exact)).not.toThrow();
    expect(serializedCommandBytes(oneByteOver)).toBe(
      TEST_COMMAND_LIMITS.maximumFrameBytes + 1,
    );
    expect(() => client.sendCommand(oneByteOver)).toThrow(BrowserCommandTooLargeError);
    expect(pendingSnapshots.at(-1)).toHaveLength(1);
  });

  it("retains a restored command that exceeds current limits until limits permit retry", () => {
    const storage = new MemoryStorage();
    const persisted = new BrowserCommandJournal(storage, "test-owner");
    const command: CommandMessage = {
      v: 1,
      kind: "command",
      commandId: "cmd_restoredLimit",
      sessionId: "ses_restoredLimit",
      method: "message.submit",
      params: { text: "restore without a frame close" },
    };
    persisted.addCommand(command);
    const socket = new FakeSocket();
    const errors: string[] = [];
    const client = new WiSocketClient({
      url: "ws://127.0.0.1:4317/ws",
      protocol: "wi.v1",
      commandLimits: {
        ...TEST_COMMAND_LIMITS,
        maximumFrameBytes: serializedCommandBytes(command) - 1,
      },
      journal: new BrowserCommandJournal(storage, "test-owner"),
      clientId: "client_restoredLimit",
      socketFactory: () => socket,
      onMessage: () => undefined,
      onLocalCommandError: (_commandId, message) => errors.push(message),
      onConnectionChange: () => undefined,
      onPendingCommandsChange: () => undefined,
    });

    client.connect();
    socket.open();
    socket.receive(welcome());
    expect(errors).toHaveLength(1);
    expect(client.getPendingCommand(command.commandId)).toEqual(command);
    expect(socket.messages().some((message) =>
      typeof message === "object" && message !== null && "kind" in message && message.kind === "command"
    )).toBe(false);

    client.updateCommandLimits(TEST_COMMAND_LIMITS);
    expect(socket.messages()).toContainEqual(command);
  });

  it("uses refreshed command limits for later sends", () => {
    const client = new WiSocketClient({
      url: "ws://127.0.0.1:4317/ws",
      protocol: "wi.v1",
      commandLimits: TEST_COMMAND_LIMITS,
      journal: journal(),
      clientId: "client_refreshedLimits",
      socketFactory: () => new FakeSocket(),
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
      onPendingCommandsChange: () => undefined,
    });
    const command: CommandMessage = {
      v: 1,
      kind: "command",
      commandId: "cmd_refreshedLimits",
      sessionId: "ses_refreshedLimits",
      method: "message.submit",
      params: { text: "bounded after re-bootstrap" },
    };
    client.updateCommandLimits({
      ...TEST_COMMAND_LIMITS,
      maximumFrameBytes: serializedCommandBytes(command) - 1,
    });

    expect(() => client.sendCommand(command)).toThrow(BrowserCommandTooLargeError);
    expect(client.getPendingCommand(command.commandId)).toBeUndefined();
  });

  it("cleans up a scheduled reconnect when stopped", () => {
    const sockets: FakeSocket[] = [];
    const timers = new Map<number, () => void>();
    const client = new WiSocketClient({
      url: "ws://127.0.0.1:4317/ws",
      protocol: "wi.v1",
      commandLimits: TEST_COMMAND_LIMITS,
      journal: journal(),
      clientId: "client_cleanup",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { baseDelayMs: 10, maximumDelayMs: 10, jitterRatio: 0, random: () => 0.5 },
      setTimer: (callback) => {
        timers.set(1, callback);
        return 1;
      },
      clearTimer: (handle) => timers.delete(Number(handle)),
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
      onPendingCommandsChange: () => undefined,
    });

    client.connect();
    sockets[0]?.open();
    sockets[0]?.serverClose();
    expect(timers.size).toBe(1);
    client.stop();
    expect(timers.size).toBe(0);
    expect(client.snapshot.status).toBe("closed");
  });

  it("reconnects after the server isolates a slow consumer", () => {
    const sockets: FakeSocket[] = [];
    let scheduled = false;
    const client = new WiSocketClient({
      url: "ws://127.0.0.1:4317/ws",
      protocol: "wi.v1",
      commandLimits: TEST_COMMAND_LIMITS,
      journal: journal(),
      clientId: "client_slowConsumer",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { baseDelayMs: 10, maximumDelayMs: 10, jitterRatio: 0, random: () => 0.5 },
      setTimer: () => {
        scheduled = true;
        return 1;
      },
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
      onPendingCommandsChange: () => undefined,
    });

    client.connect();
    sockets[0]?.open();
    sockets[0]?.serverClose(4409, "slow consumer");
    expect(client.snapshot).toMatchObject({
      status: "reconnecting",
      closeCode: 4409,
      detail: "slow consumer",
    });
    expect(scheduled).toBe(true);
  });

  it("reconciles sessions changed after hello but before welcome", () => {
    const socket = new FakeSocket();
    const client = new WiSocketClient({
      url: "ws://127.0.0.1:4317/ws",
      protocol: "wi.v1",
      commandLimits: TEST_COMMAND_LIMITS,
      journal: journal(),
      clientId: "client_handshakeSessions",
      socketFactory: () => socket,
      idSource: () => "handshakeSessions",
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
      onPendingCommandsChange: () => undefined,
    });

    client.openSession("ses_beforeWelcome", 4);
    client.connect();
    socket.open();
    expect(socket.messages()[0]).toMatchObject({
      kind: "hello",
      resume: [{ sessionId: "ses_beforeWelcome", afterSequence: 4 }],
    });

    client.closeSession("ses_beforeWelcome");
    client.openSession("ses_afterHello", 0);
    expect(socket.messages()).toHaveLength(1);
    socket.receive(welcome());

    expect(socket.messages()).toContainEqual(
      expect.objectContaining({ kind: "unsubscribe", sessionId: "ses_beforeWelcome" }),
    );
    expect(socket.messages()).toContainEqual(
      expect.objectContaining({
        kind: "subscribe",
        sessionId: "ses_afterHello",
        afterSequence: 0,
      }),
    );
    expect(client.hasOpenSession("ses_beforeWelcome")).toBe(false);
    expect(client.hasOpenSession("ses_afterHello")).toBe(true);
  });

  it("unsubscribes a closed session and subscribes it again when reopened", () => {
    const socket = new FakeSocket();
    const client = new WiSocketClient({
      url: "ws://127.0.0.1:4317/ws",
      protocol: "wi.v1",
      commandLimits: TEST_COMMAND_LIMITS,
      journal: journal(),
      clientId: "client_sessions",
      socketFactory: () => socket,
      idSource: () => "sessions",
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
      onPendingCommandsChange: () => undefined,
    });

    client.connect();
    socket.open();
    socket.receive(welcome());
    client.openSession("ses_sessions", 4);
    client.closeSession("ses_sessions");
    expect(client.hasOpenSession("ses_sessions")).toBe(false);
    client.openSession("ses_sessions", 5);
    expect(client.hasOpenSession("ses_sessions")).toBe(true);

    expect(socket.messages().filter((message) =>
      typeof message === "object" &&
      message !== null &&
      "kind" in message &&
      message.kind === "subscribe"
    )).toHaveLength(2);
    expect(socket.messages()).toContainEqual(
      expect.objectContaining({ kind: "unsubscribe", sessionId: "ses_sessions" }),
    );
  });

  it("backs off recoverable session replay retries and cleans up their timers", () => {
    const socket = new FakeSocket();
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const client = new WiSocketClient({
      url: "ws://127.0.0.1:4317/ws",
      protocol: "wi.v1",
      commandLimits: TEST_COMMAND_LIMITS,
      journal: journal(),
      clientId: "client_replayRetry",
      socketFactory: () => socket,
      reconnect: { baseDelayMs: 10, maximumDelayMs: 20, jitterRatio: 0, random: () => 0.5 },
      setTimer: (callback) => {
        timerId += 1;
        timers.set(timerId, callback);
        return timerId;
      },
      clearTimer: (handle) => timers.delete(Number(handle)),
      idSource: () => "replayRetry",
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
      onPendingCommandsChange: () => undefined,
    });

    client.connect();
    socket.open();
    socket.receive(welcome());
    client.openSession("ses_replayRetry", 7);
    expect(client.retrySession("ses_replayRetry", 7)).toBe(10);
    expect(client.retrySession("ses_replayRetry", 7)).toBe(10);
    expect(timers.size).toBe(1);

    const firstRetry = timers.get(1);
    timers.delete(1);
    firstRetry?.();
    expect(socket.messages()).toContainEqual(
      expect.objectContaining({
        kind: "subscribe",
        sessionId: "ses_replayRetry",
        afterSequence: 7,
      }),
    );
    expect(client.retrySession("ses_replayRetry", 7)).toBe(20);
    expect(timers.size).toBe(1);
    client.completeSessionReplay("ses_replayRetry");
    expect(timers.size).toBe(0);
    client.stop();
    expect(timers.size).toBe(0);
  });

  it("serializes bootstrap refresh after bounded pre-welcome failures", async () => {
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    let scheduled: (() => void) | null = null;
    let refreshes = 0;
    const client = new WiSocketClient({
      url: "ws://127.0.0.1:4317/ws",
      protocol: "wi.v1",
      commandLimits: TEST_COMMAND_LIMITS,
      journal: journal(),
      clientId: "client_authRefresh",
      socketFactory: (url) => {
        urls.push(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { baseDelayMs: 10, maximumDelayMs: 10, jitterRatio: 0, random: () => 0.5 },
      setTimer: (callback) => {
        scheduled = callback;
        return callback;
      },
      clearTimer: () => {
        scheduled = null;
      },
      refreshConnection: async () => {
        refreshes += 1;
        return {
          url: "ws://127.0.0.1:4317/refreshed-ws",
          protocol: "wi.v1",
          commandLimits: { ...TEST_COMMAND_LIMITS, maximumFrameBytes: 32_768 },
        };
      },
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
      onPendingCommandsChange: () => undefined,
    });
    const runTimer = (): void => {
      const callback = scheduled;
      scheduled = null;
      if (callback === null) throw new Error("No reconnect timer was scheduled");
      callback();
    };

    client.connect();
    sockets[0]?.open();
    sockets[0]?.receive(welcome());
    sockets[0]?.serverClose();
    runTimer();
    sockets[1]?.open();
    sockets[1]?.serverClose();
    runTimer();
    sockets[2]?.open();
    sockets[2]?.serverClose();
    await Promise.resolve();

    expect(refreshes).toBe(1);
    expect(sockets).toHaveLength(4);
    expect(urls.at(-1)).toBe("ws://127.0.0.1:4317/refreshed-ws");
    sockets[3]?.open();
    sockets[3]?.receive(welcome());
    expect(client.snapshot.status).toBe("connected");
  });

  it("terminalizes after two failed bootstrap refresh attempts", async () => {
    const sockets: FakeSocket[] = [];
    let scheduled: (() => void) | null = null;
    let refreshes = 0;
    const client = new WiSocketClient({
      url: "ws://127.0.0.1:4317/ws",
      protocol: "wi.v1",
      commandLimits: TEST_COMMAND_LIMITS,
      journal: journal(),
      clientId: "client_authRefreshFailure",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { baseDelayMs: 10, maximumDelayMs: 10, jitterRatio: 0, random: () => 0.5 },
      setTimer: (callback) => {
        scheduled = callback;
        return callback;
      },
      clearTimer: () => {
        scheduled = null;
      },
      refreshConnection: async () => {
        refreshes += 1;
        throw new Error("bootstrap unavailable");
      },
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
      onPendingCommandsChange: () => undefined,
    });
    const runTimer = (): void => {
      const callback = scheduled;
      scheduled = null;
      if (callback === null) throw new Error("No reconnect timer was scheduled");
      callback();
    };
    const failPreWelcomePair = async (firstIndex: number): Promise<void> => {
      runTimer();
      sockets[firstIndex]?.open();
      sockets[firstIndex]?.serverClose();
      runTimer();
      sockets[firstIndex + 1]?.open();
      sockets[firstIndex + 1]?.serverClose();
      await Promise.resolve();
    };

    client.connect();
    sockets[0]?.open();
    sockets[0]?.receive(welcome());
    sockets[0]?.serverClose();
    await failPreWelcomePair(1);
    await failPreWelcomePair(3);

    expect(refreshes).toBe(2);
    expect(client.snapshot).toMatchObject({
      status: "error",
      reconnectDelayMs: null,
      detail: "bootstrap unavailable Reload Wi to reconnect.",
    });
    expect(scheduled).toBeNull();
  });

  it("does not reconnect after a terminal policy close", () => {
    const sockets: FakeSocket[] = [];
    let scheduled = false;
    const client = new WiSocketClient({
      url: "ws://127.0.0.1:4317/ws",
      protocol: "wi.v1",
      commandLimits: TEST_COMMAND_LIMITS,
      journal: journal(),
      clientId: "client_terminal",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimer: () => {
        scheduled = true;
        return 1;
      },
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
      onPendingCommandsChange: () => undefined,
    });

    client.connect();
    sockets[0]?.open();
    sockets[0]?.serverClose(1008, "policy rejected");
    expect(client.snapshot.status).toBe("error");
    expect(scheduled).toBe(false);
  });
});
