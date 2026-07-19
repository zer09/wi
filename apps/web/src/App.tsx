import { useEffect, useMemo, useRef, useState } from "react";
import {
  beginReplay,
  completeReplay,
  createBrowserSessionState,
  reduceSessionEvent,
  type BrowserSessionState,
} from "@wi/client-state";
import {
  SessionIdSchema,
  createId,
  type ApprovalResolution,
  type BrowserSessionSummary,
  type CanonicalJsonValue,
  type CommandMessage,
  type ServerMessage,
} from "@wi/protocol";

import { fetchBootstrap, websocketUrl } from "./api/bootstrap.js";
import { ApprovalPanel } from "./components/ApprovalPanel.js";
import { Composer } from "./components/Composer.js";
import { ConnectionStatus } from "./components/ConnectionStatus.js";
import { PendingInputPanel } from "./components/PendingInputPanel.js";
import { RunStatus } from "./components/RunStatus.js";
import { SessionList } from "./components/SessionList.js";
import { Timeline } from "./components/Timeline.js";
import { replayRecoveryAction } from "./state/replay-recovery.js";
import { BrowserCommandTooLargeError } from "./socket/command-size.js";
import {
  WiSocketClient,
  type ConnectionSnapshot,
  type PendingCommand,
} from "./socket/client.js";

interface Notice {
  readonly id: number;
  readonly tone: "error" | "info";
  readonly text: string;
  readonly code?: string;
}

interface FocusRecovery {
  readonly sessionId: string;
  readonly kind: "approval" | "cancel" | "input";
  readonly targetId: string;
}

const INITIAL_CONNECTION: ConnectionSnapshot = {
  status: "idle",
  reconnectDelayMs: null,
  closeCode: null,
  detail: null,
};

const TERMINAL_CONNECTION_STATES = new Set(["closed", "error"]);

function idSource(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

function selectedSessionFromLocation(sessions: readonly BrowserSessionSummary[]): string | null {
  const candidate = new URL(globalThis.location.href).searchParams.get("session");
  if (candidate !== null && SessionIdSchema.safeParse(candidate).success) {
    if (
      sessions.some((session) => session.sessionId === candidate && session.status === "ready")
    ) {
      return candidate;
    }
  }
  return sessions.find((session) => session.status === "ready")?.sessionId ?? null;
}

function updateLocationSession(sessionId: string): void {
  const url = new URL(globalThis.location.href);
  url.searchParams.set("session", sessionId);
  globalThis.history.replaceState(null, "", url);
}

function summaryForState(
  previous: BrowserSessionSummary | undefined,
  state: BrowserSessionState,
  updatedAtMs: number,
): BrowserSessionSummary {
  return {
    sessionId: state.sessionId,
    title: state.title || previous?.title || "Untitled session",
    status: previous?.status ?? "ready",
    createdAtMs: previous?.createdAtMs ?? updatedAtMs,
    updatedAtMs,
    lastEventSequence: state.lastAppliedSequence,
    lastRunState: state.activeRun?.state ?? previous?.lastRunState ?? null,
    lastMessagePreview: state.lastMessagePreview ?? previous?.lastMessagePreview ?? null,
    requiresAttention:
      Object.keys(state.pendingApprovals).length > 0 || Object.keys(state.pendingInputs).length > 0,
    pendingApprovalCount: Object.keys(state.pendingApprovals).length,
    pendingInputCount: Object.keys(state.pendingInputs).length,
  };
}

export function App() {
  const socket = useRef<WiSocketClient | null>(null);
  const sessionStates = useRef<Readonly<Record<string, BrowserSessionState>>>({});
  const noticeId = useRef(0);
  const resyncingSessions = useRef(new Set<string>());
  const selectedSessionIdRef = useRef<string | null>(null);
  const sessionProtocolErrorsRef = useRef<Readonly<Record<string, string>>>({});
  const focusRecovery = useRef<FocusRecovery | null>(null);
  const [bootstrapState, setBootstrapState] = useState<"loading" | "ready" | "error">("loading");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [connection, setConnection] = useState(INITIAL_CONNECTION);
  const [summaries, setSummaries] = useState<readonly BrowserSessionSummary[]>([]);
  const [sessionListTruncated, setSessionListTruncated] = useState(false);
  const [sessions, setSessions] = useState<Readonly<Record<string, BrowserSessionState>>>({});
  const [sessionProtocolErrors, setSessionProtocolErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [messageDrafts, setMessageDrafts] = useState<Readonly<Record<string, string>>>({});
  const [pendingCommands, setPendingCommands] = useState<readonly PendingCommand[]>([]);
  const [notices, setNotices] = useState<readonly Notice[]>([]);

  function addNotice(
    text: string,
    tone: Notice["tone"] = "info",
    code?: string,
  ): void {
    noticeId.current += 1;
    const notice = {
      id: noticeId.current,
      text,
      tone,
      ...(code === undefined ? {} : { code }),
    };
    setNotices((current) => [...current.slice(-4), notice]);
  }

  function storeSession(next: BrowserSessionState, updatedAtMs = Date.now()): void {
    const nextSessions = { ...sessionStates.current, [next.sessionId]: next };
    sessionStates.current = nextSessions;
    setSessions(nextSessions);
    setSummaries((current) => {
      const previous = current.find((summary) => summary.sessionId === next.sessionId);
      const replacement = summaryForState(previous, next, updatedAtMs);
      const remaining = current.filter((summary) => summary.sessionId !== next.sessionId);
      return [replacement, ...remaining].sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    });
  }

  function openSession(sessionId: string): void {
    let state = sessionStates.current[sessionId];
    if (selectedSessionIdRef.current === sessionId && state !== undefined) {
      setSelectedSessionId(sessionId);
      updateLocationSession(sessionId);
      return;
    }

    const previousSessionId = selectedSessionIdRef.current;
    if (previousSessionId !== null && previousSessionId !== sessionId) {
      focusRecovery.current = null;
      socket.current?.closeSession(previousSessionId);
      resyncingSessions.current.delete(previousSessionId);
      const previousState = sessionStates.current[previousSessionId];
      if (
        previousState?.errorCode === null &&
        sessionProtocolErrorsRef.current[previousSessionId] === undefined
      ) {
        const remaining = { ...sessionStates.current };
        delete remaining[previousSessionId];
        sessionStates.current = remaining;
        setSessions(remaining);
      }
    }

    if (state === undefined) state = createBrowserSessionState(sessionId);
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    updateLocationSession(sessionId);
    if (state.errorCode !== null || sessionProtocolErrorsRef.current[sessionId] !== undefined) {
      storeSession(state);
      return;
    }
    state = beginReplay(state);
    storeSession(state);
    socket.current?.openSession(sessionId, state.lastAppliedSequence);
  }

  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    let socketClient: WiSocketClient | null = null;

    void fetchBootstrap(abort.signal).then(
      (bootstrap) => {
        if (!active) return;
        setSummaries(bootstrap.sessions);
        setSessionListTruncated(bootstrap.sessionsTruncated);
        const initialSessionId = selectedSessionFromLocation(bootstrap.sessions);

        socketClient = new WiSocketClient({
          url: websocketUrl(bootstrap.websocketPath),
          protocol: bootstrap.websocketProtocol,
          onConnectionChange: (next) => {
            if (!active) return;
            setConnection(next);
            if (next.status === "handshaking") {
              resyncingSessions.current.clear();
              for (const state of Object.values(sessionStates.current)) {
                storeSession(beginReplay(state));
              }
            }
          },
          onPendingCommandsChange: (commands) => {
            if (active) setPendingCommands(commands);
          },
          onMessage: (message) => {
            if (!active || socketClient === null) return;
            handleServerMessage(message, socketClient);
          },
        });
        socket.current = socketClient;
        setBootstrapState("ready");
        if (initialSessionId !== null) openSession(initialSessionId);
        socketClient.connect();
      },
      (error: unknown) => {
        if (!active || abort.signal.aborted) return;
        setBootstrapState("error");
        setBootstrapError(error instanceof Error ? error.message : "Bootstrap failed");
      },
    );

    function handleServerMessage(message: ServerMessage, client: WiSocketClient): void {
      if (message.kind === "event") {
        if (!client.hasOpenSession(message.sessionId)) return;
        const previous =
          sessionStates.current[message.sessionId] ?? createBrowserSessionState(message.sessionId);
        const reduced = reduceSessionEvent(previous, message);
        if (reduced.status === "gap") {
          if (!resyncingSessions.current.has(message.sessionId)) {
            resyncingSessions.current.add(message.sessionId);
            addNotice("A sequence gap was detected. Replaying from the last trusted event.", "error");
            const replaying = beginReplay(reduced);
            storeSession(replaying, message.createdAtMs);
            client.resubscribe(message.sessionId, previous.lastAppliedSequence);
          }
          return;
        }
        storeSession(reduced, message.createdAtMs);
        if (reduced.errorCode !== null) {
          resyncingSessions.current.delete(message.sessionId);
          client.closeSession(message.sessionId);
          return;
        }
        if (reduced.lastAppliedSequence > previous.lastAppliedSequence) {
          client.updateCursor(message.sessionId, reduced.lastAppliedSequence);
        }
        return;
      }
      if (message.kind === "replay.complete") {
        if (!client.hasOpenSession(message.sessionId)) return;
        const previous = sessionStates.current[message.sessionId];
        if (previous === undefined) return;
        const completed = completeReplay(previous, message.throughSequence);
        client.completeSessionReplay(message.sessionId);
        if (completed.status === "gap") {
          addNotice("Replay did not reach the advertised sequence. Resynchronizing.", "error");
          resyncingSessions.current.add(message.sessionId);
          storeSession(beginReplay(completed));
          client.resubscribe(message.sessionId, completed.lastAppliedSequence);
        } else {
          storeSession(completed);
          resyncingSessions.current.delete(message.sessionId);
        }
        return;
      }
      if (message.kind === "command.accepted") {
        const command = client.getPendingCommand(message.commandId);
        if (command?.method === "session.create") {
          setSessionTitleDraft((current) =>
            current.trim() === (command.params.title ?? "") ? "" : current,
          );
        }
        if (command?.method === "message.submit") {
          setMessageDrafts((current) => {
            if ((current[command.sessionId] ?? "").trim() !== command.params.text) return current;
            const next = { ...current };
            delete next[command.sessionId];
            return next;
          });
        }
        if (command?.method === "session.create" && message.sessionId !== undefined) {
          const created: BrowserSessionSummary = {
            sessionId: message.sessionId,
            title: command.params.title ?? "Untitled session",
            status: "ready",
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
            lastEventSequence: 0,
            lastRunState: null,
            lastMessagePreview: null,
            requiresAttention: false,
            pendingApprovalCount: 0,
            pendingInputCount: 0,
          };
          setSummaries((current) => [created, ...current]);
          openSession(message.sessionId);
        }
        addNotice(message.duplicate ? "Command reconciled after reconnect." : "Command accepted.");
        return;
      }
      if (message.kind === "command.rejected") {
        addNotice(
          `${message.message} Diagnostic: ${message.diagnosticId}`,
          "error",
          message.code,
        );
        return;
      }
      if (message.kind === "protocol.error") {
        if (message.sessionId !== undefined && !client.hasOpenSession(message.sessionId)) return;
        addNotice(`${message.message} Diagnostic: ${message.diagnosticId}`, "error");
        if (!message.recoverable && message.sessionId !== undefined) {
          const nextErrors = {
            ...sessionProtocolErrorsRef.current,
            [message.sessionId]: `${message.message} Diagnostic: ${message.diagnosticId}`,
          };
          sessionProtocolErrorsRef.current = nextErrors;
          setSessionProtocolErrors(nextErrors);
          resyncingSessions.current.delete(message.sessionId);
          client.closeSession(message.sessionId);
        }
        const recovery = replayRecoveryAction(message);
        if (recovery !== "none" && message.sessionId !== undefined) {
          const previous = sessionStates.current[message.sessionId];
          if (previous !== undefined && previous.errorCode === null) {
            const replaying =
              recovery === "reset"
                ? beginReplay(createBrowserSessionState(message.sessionId))
                : beginReplay(previous);
            resyncingSessions.current.add(message.sessionId);
            storeSession(replaying);
            client.retrySession(message.sessionId, replaying.lastAppliedSequence);
          }
        }
      }
    }

    return () => {
      active = false;
      abort.abort();
      socket.current = null;
      socketClient?.stop();
    };
  }, []);

  const selectedSession = selectedSessionId === null ? null : sessions[selectedSessionId] ?? null;

  useEffect(() => {
    const recovery = focusRecovery.current;
    if (
      recovery === null ||
      selectedSession === null ||
      recovery.sessionId !== selectedSession.sessionId
    ) {
      return;
    }
    const controlRemoved =
      (recovery.kind === "approval" &&
        selectedSession.pendingApprovals[recovery.targetId] === undefined) ||
      (recovery.kind === "input" && selectedSession.pendingInputs[recovery.targetId] === undefined) ||
      (recovery.kind === "cancel" &&
        (selectedSession.activeRun?.runId !== recovery.targetId ||
          selectedSession.activeRun.state === "cancelling" ||
          ["cancelled", "completed", "failed", "interrupted"].includes(
            selectedSession.activeRun.state,
          )));
    if (!controlRemoved) return;
    focusRecovery.current = null;
    for (const selector of [
      '[data-focus-target="approval"]:not([disabled])',
      '[data-focus-target="input"]:not([disabled])',
      '[data-focus-target="run"]',
      '#message-composer:not([disabled])',
    ]) {
      const target = globalThis.document.querySelector<HTMLElement>(selector);
      if (target !== null) {
        target.focus();
        return;
      }
    }
  }, [selectedSession]);

  const selectedPendingCommands = useMemo(
    () =>
      selectedSessionId === null
        ? []
        : pendingCommands.filter(
            (pending) =>
              "sessionId" in pending.command &&
              pending.command.sessionId === selectedSessionId,
          ),
    [pendingCommands, selectedSessionId],
  );
  const pendingByMethod = useMemo(() => {
    const result = new Map<CommandMessage["method"], number>();
    for (const pending of selectedPendingCommands) {
      result.set(pending.command.method, (result.get(pending.command.method) ?? 0) + 1);
    }
    return result;
  }, [selectedPendingCommands]);

  const pendingApprovalIds = useMemo(
    () =>
      new Set(
        selectedPendingCommands.flatMap((pending) =>
          pending.command.method === "approval.resolve"
            ? [pending.command.params.approvalId]
            : [],
        ),
      ),
    [selectedPendingCommands],
  );
  const pendingInputIds = useMemo(
    () =>
      new Set(
        selectedPendingCommands.flatMap((pending) =>
          pending.command.method === "input.respond" ? [pending.command.params.inputId] : [],
        ),
      ),
    [selectedPendingCommands],
  );

  function send(command: CommandMessage): string | null {
    const client = socket.current;
    if (client === null) return "The browser connection is not initialized.";
    try {
      client.sendCommand(command);
      return null;
    } catch (error) {
      const message =
        error instanceof BrowserCommandTooLargeError
          ? error.message
          : "The command could not be validated for sending.";
      return message;
    }
  }

  function createSession(title: string): string | null {
    return send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      method: "session.create",
      params: { title },
    });
  }

  function submitMessage(text: string): string | null {
    if (selectedSessionId === null) return "Select a session before sending a message.";
    return send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      sessionId: selectedSessionId,
      method: "message.submit",
      params: { text },
    });
  }

  function cancelRun(runId: string): void {
    if (selectedSessionId === null) return;
    focusRecovery.current = { sessionId: selectedSessionId, kind: "cancel", targetId: runId };
    const error = send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      sessionId: selectedSessionId,
      method: "run.cancel",
      params: { runId },
    });
    if (error !== null) addNotice(error, "error");
  }

  function resolveApproval(approvalId: string, resolution: ApprovalResolution): void {
    if (selectedSessionId === null) return;
    focusRecovery.current = {
      sessionId: selectedSessionId,
      kind: "approval",
      targetId: approvalId,
    };
    const error = send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      sessionId: selectedSessionId,
      method: "approval.resolve",
      params: { approvalId, resolution },
    });
    if (error !== null) addNotice(error, "error");
  }

  function respondToInput(inputId: string, value: CanonicalJsonValue): string | null {
    if (selectedSessionId === null) return "Select a session before responding.";
    focusRecovery.current = { sessionId: selectedSessionId, kind: "input", targetId: inputId };
    return send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      sessionId: selectedSessionId,
      method: "input.respond",
      params: { inputId, value },
    });
  }

  if (bootstrapState === "loading") {
    return <main className="boot" role="status">Loading Wi…</main>;
  }
  if (bootstrapState === "error") {
    return <main className="boot" role="alert">{bootstrapError}</main>;
  }

  const terminalConnection = TERMINAL_CONNECTION_STATES.has(connection.status);
  const selectedProtocolError =
    selectedSessionId === null ? undefined : sessionProtocolErrors[selectedSessionId];
  const selectedHasIntegrityError =
    (selectedSession !== null && selectedSession.errorCode !== null) ||
    selectedProtocolError !== undefined;
  const sessionMutationsDisabled = terminalConnection || selectedHasIntegrityError;
  const historyLimitExceeded = selectedSession?.errorCode === "history_limit_exceeded";

  return (
    <div className="app-shell">
      <SessionList
        sessions={summaries}
        sessionsTruncated={sessionListTruncated}
        selectedSessionId={selectedSessionId}
        title={sessionTitleDraft}
        createPending={pendingCommands.some(
          (pending) => pending.command.method === "session.create",
        )}
        createDisabled={terminalConnection}
        onTitleChange={setSessionTitleDraft}
        onCreate={createSession}
        onSelect={openSession}
      />
      <main className="workspace">
        <header className="workspace__header">
          <div>
            <h2>{selectedSession?.title.slice(0, 512) || "Select a session"}</h2>
            {selectedSession === null ? null : (
              <p className={`replay-state replay-state--${selectedSession.status}`} role="status">
                Session state: {selectedSession.status} · sequence {selectedSession.lastAppliedSequence}
              </p>
            )}
          </div>
          <ConnectionStatus connection={connection} />
        </header>

        {terminalConnection ? (
          <div className="integrity-error" role="alert">
            The connection cannot recover automatically. State-changing controls are disabled.
            <button type="button" onClick={() => globalThis.location.reload()}>
              Reload Wi
            </button>
          </div>
        ) : null}

        {notices.length === 0 ? null : (
          <section className="notices" aria-label="Command and connection notices">
            {notices.map((notice) => (
              <p key={notice.id} className={`notice notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
                <span data-error-code={notice.code}>{notice.text}</span>
              </p>
            ))}
          </section>
        )}

        {selectedSession === null ? (
          <section className="welcome">
            <h2>Create or select a session</h2>
            <p>The backend owns runs. Closing this page does not cancel them.</p>
          </section>
        ) : (
          <>
            {selectedHasIntegrityError ? (
              <div className="integrity-error" role="alert">
                {historyLimitExceeded ? (
                  <p>
                    This session exceeds the bounded browser history limit. Start a new session;
                    this projection will not accept more events.
                  </p>
                ) : (
                  <>
                    <p>
                      Session integrity error: {selectedProtocolError ?? selectedSession.errorCode}.
                      Reload from durable storage before continuing.
                    </p>
                    <button type="button" onClick={() => globalThis.location.reload()}>
                      Reload session
                    </button>
                  </>
                )}
              </div>
            ) : null}
            <RunStatus
              run={selectedSession.activeRun}
              cancelPending={(pendingByMethod.get("run.cancel") ?? 0) > 0}
              disabled={sessionMutationsDisabled}
              onCancel={cancelRun}
            />
            <ApprovalPanel
              approvals={Object.values(selectedSession.pendingApprovals)}
              pendingApprovalIds={pendingApprovalIds}
              disabled={sessionMutationsDisabled}
              onResolve={resolveApproval}
            />
            <PendingInputPanel
              inputs={Object.values(selectedSession.pendingInputs)}
              pendingInputIds={pendingInputIds}
              disabled={sessionMutationsDisabled}
              onRespond={respondToInput}
            />
            <Timeline session={selectedSession} />
            <Composer
              sessionId={selectedSession.sessionId}
              text={messageDrafts[selectedSession.sessionId] ?? ""}
              disabled={sessionMutationsDisabled}
              pending={(pendingByMethod.get("message.submit") ?? 0) > 0}
              onTextChange={(text) =>
                setMessageDrafts((current) => ({ ...current, [selectedSession.sessionId]: text }))
              }
              onSubmit={submitMessage}
            />
          </>
        )}
      </main>
    </div>
  );
}
