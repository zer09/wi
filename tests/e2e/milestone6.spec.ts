import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, startServer, test, type WiTestServer } from "./fixtures/wi-test.js";

async function openWi(page: Page, wi: WiTestServer, sessionId?: string): Promise<void> {
  const url = sessionId === undefined ? wi.origin : `${wi.origin}/?session=${sessionId}`;
  await page.goto(url);
  await expect(page.locator(".connection")).toContainText("Connected");
}

async function createSession(page: Page, title: string): Promise<string> {
  await page.getByLabel("New session title").fill(title);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByLabel("New session title")).toHaveValue("");
  const sessionId = new URL(page.url()).searchParams.get("session");
  if (sessionId === null) throw new Error("Created session was not selected");
  await expect(page.getByText("Session state: live")).toBeVisible();
  return sessionId;
}

async function selectSession(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByText("Session state: live")).toBeVisible();
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("timeline-user").filter({ hasText: text })).toHaveCount(1);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { readonly code?: string }).code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

async function expectRunState(page: Page, state: string): Promise<void> {
  await expect(page.getByLabel("Current run status").getByText(state, { exact: true })).toBeVisible();
}

test("cleans child processes and temporary homes when fixture startup fails", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "wi-e2e-startup-test-"));
  const childScript = new URL("./fixtures/startup-failure-process.mjs", import.meta.url);
  try {
    for (const scenario of [
      { mode: "exit", timeoutMs: 2_000, error: "exited early" },
      { mode: "hang", timeoutMs: 50, error: "Timed out" },
    ] as const) {
      let childPid: number | null = null;
      await expect(
        startServer({
          childScript,
          childArguments: [scenario.mode],
          readyTimeoutMs: scenario.timeoutMs,
          temporaryDirectory,
          onChildStarted: (child) => {
            childPid = child.pid ?? null;
          },
        }),
      ).rejects.toThrow(scenario.error);
      expect(await readdir(temporaryDirectory)).toEqual([]);
      if (childPid === null) throw new Error("Startup fixture child had no process ID");
      expect(processIsAlive(childPid)).toBe(false);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("preserves title and message drafts until durable acceptance", async ({ page, wi }) => {
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly commandId?: string;
        readonly method?: string;
        readonly params?: { readonly title?: string; readonly text?: string };
      };
      const rejectTitle =
        message.method === "session.create" && message.params?.title === "Rejected title draft";
      const rejectMessage =
        message.method === "message.submit" && message.params?.text === "Rejected message draft";
      if (
        message.kind === "command" &&
        message.commandId !== undefined &&
        (rejectTitle || rejectMessage)
      ) {
        browserSocket.send(
          JSON.stringify({
            v: 1,
            kind: "command.rejected",
            commandId: message.commandId,
            code: "storage.worker_failed",
            message: "Synthetic durable rejection.",
            diagnosticId: "err_draftRejected",
            recoverable: true,
          }),
        );
        return;
      }
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi);
  const title = page.getByLabel("New session title");
  await title.fill("Rejected title draft");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator('[data-error-code="storage.worker_failed"]')).toBeVisible();
  await expect(title).toHaveValue("Rejected title draft");

  await title.fill("Accepted title after rejection");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Accepted title after rejection" })).toBeVisible();
  await expect(title).toHaveValue("");
  await expect(page.getByText("Session state: live")).toBeVisible();

  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("Rejected message draft");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('[data-error-code="storage.worker_failed"]')).toHaveCount(2);
  await expect(composer).toHaveValue("Rejected message draft");

  await composer.fill("Accepted message after rejection");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByTestId("timeline-user").filter({ hasText: "Accepted message after rejection" }),
  ).toHaveCount(1);
  await expect(composer).toHaveValue("");
});

test("rejects oversized message and input drafts without closing the connection", async ({
  page,
  wi,
}) => {
  let sendToBrowser: ((message: string) => void) | null = null;
  let forwardedInputResponses = 0;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    sendToBrowser = (message) => browserSocket.send(message);
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as { readonly kind?: string; readonly method?: string };
      if (message.kind === "command" && message.method === "input.respond") {
        forwardedInputResponses += 1;
      }
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi);
  const sessionId = await createSession(page, "Bounded browser drafts");
  const oversizedMessage = "🔥".repeat(20_000);
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill(oversizedMessage);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('.composer [role="alert"]')).toContainText(
    "browser limit is 61440",
  );
  await expect(composer).toHaveValue(oversizedMessage);
  await expect(page.locator(".connection")).toContainText("Connected");
  await expect(page.getByTestId("timeline-user")).toHaveCount(0);

  if (sendToBrowser === null) throw new Error("WebSocket route was not established");
  (sendToBrowser as (message: string) => void)(
    JSON.stringify({
      v: 1,
      kind: "event",
      sessionId,
      sequence: 2,
      eventId: "evt_oversizedInputRequested",
      eventType: "input.requested",
      createdAtMs: 2,
      data: {
        eventVersion: 1,
        runId: "run_oversizedInput",
        inputId: "input_oversizedInput",
        prompt: "Provide a bounded JSON response.",
      },
    }),
  );
  const oversizedInput = JSON.stringify("x".repeat(70_000));
  const input = page.getByLabel("Response as JSON");
  await input.fill(oversizedInput);
  await page.getByRole("button", { name: "Respond", exact: true }).click();
  await expect(page.getByTestId("pending-input-panel").getByRole("alert")).toContainText(
    "browser limit is 61440",
  );
  await expect(input).toHaveValue(oversizedInput);
  expect(forwardedInputResponses).toBe(0);
  await expect(page.locator(".connection")).toContainText("Connected");
});

test("creates two sessions and runs both concurrently", async ({ page, wi }) => {
  await openWi(page, wi);
  await createSession(page, "Concurrent A");
  await sendMessage(page, "[slow] first concurrent run");
  await createSession(page, "Concurrent B");
  await sendMessage(page, "[slow] second concurrent run");
  await wi.waitForProviderRequest(2);

  await wi.releaseProvider("slow");
  await selectSession(page, "Concurrent A");
  await expect(page.getByText("Slow fake response.", { exact: true })).toBeVisible();
  await expectRunState(page, "completed");
  await selectSession(page, "Concurrent B");
  await expect(page.getByText("Slow fake response.", { exact: true })).toBeVisible();
  await expectRunState(page, "completed");
});

test("two tabs converge and all tabs can close without cancelling backend work", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Disposable tabs");
  await sendMessage(page, "[slow] survive every browser tab closing");
  await wi.waitForProviderRequest();
  await expect(page.getByText("Slow", { exact: true })).toBeVisible();

  const second = await context.newPage();
  await openWi(second, wi, sessionId);
  await expect(second.getByText("Slow", { exact: true })).toBeVisible();
  const beforeCloseSequence = Number(
    await second.getByTestId("timeline").getAttribute("data-last-sequence"),
  );
  expect(beforeCloseSequence).toBeGreaterThan(0);

  await Promise.all([page.close(), second.close()]);
  await wi.releaseProvider("slow");

  const reopened = await context.newPage();
  await openWi(reopened, wi, sessionId);
  await expect(reopened.getByText("Slow fake response.", { exact: true })).toBeVisible();
  await expectRunState(reopened, "completed");
  const durableHead = await wi.sessionHead(sessionId);
  await expect(reopened.getByTestId("timeline")).toHaveAttribute(
    "data-last-sequence",
    String(durableHead),
  );
});

test("approval remains durable across refresh and resolves once across tabs", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Guarded approval");
  await sendMessage(page, "[approval] guarded action");
  await expect(page.getByTestId("approval-panel")).toBeVisible();

  await page.reload();
  await expect(page.locator(".connection")).toContainText("Connected");
  await expect(page.getByTestId("approval-panel")).toBeVisible();

  const second = await context.newPage();
  await openWi(second, wi, sessionId);
  await expect(second.getByTestId("approval-panel")).toBeVisible();

  const approvalId = await page.getByTestId("approval-panel").getAttribute("data-approval-id");
  if (approvalId === null) throw new Error("Approval panel did not expose its durable ID");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("approval-panel")).toHaveCount(0);
  await expect(second.getByTestId("approval-panel")).toHaveCount(0);
  await expectRunState(page, "completed");
  await expectRunState(second, "completed");
  await expect(page.getByText("Guarded echo completed.", { exact: true })).toBeVisible();
  await expect(second.getByText("Guarded echo completed.", { exact: true })).toBeVisible();

  const rejection = (await second.evaluate(
    async ({ currentSessionId, currentApprovalId }) => {
      const browser = globalThis as unknown as {
        readonly location: { readonly href: string };
        readonly WebSocket: new (url: string, protocol: string) => {
          onopen: (() => void) | null;
          onmessage: ((event: { readonly data: unknown }) => void) | null;
          onerror: (() => void) | null;
          send(data: string): void;
          close(): void;
        };
        setTimeout(callback: () => void, delayMs: number): number;
        clearTimeout(handle: number): void;
      };
      const url = new URL("/ws", browser.location.href);
      url.protocol = "ws:";
      return new Promise<unknown>((resolve, reject) => {
        const socket = new browser.WebSocket(url.href, "wi.v1");
        let commandSent = false;
        const timer = browser.setTimeout(() => {
          socket.close();
          reject(new Error("Timed out waiting for second approval resolution"));
        }, 5_000);
        socket.onopen = () => {
          socket.send(
            JSON.stringify({
              v: 1,
              kind: "hello",
              clientId: "client_secondResolution",
              resume: [],
            }),
          );
        };
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as {
            readonly kind?: string;
            readonly commandId?: string;
          };
          if (message.kind === "welcome" && !commandSent) {
            commandSent = true;
            socket.send(
              JSON.stringify({
                v: 1,
                kind: "command",
                commandId: "cmd_secondResolution",
                sessionId: currentSessionId,
                method: "approval.resolve",
                params: { approvalId: currentApprovalId, resolution: "denied" },
              }),
            );
          }
          if (message.kind === "command.rejected" && message.commandId === "cmd_secondResolution") {
            browser.clearTimeout(timer);
            socket.close();
            resolve(message);
          }
        };
        socket.onerror = () => {
          browser.clearTimeout(timer);
          reject(new Error("Second approval WebSocket failed"));
        };
      });
    },
    { currentSessionId: sessionId, currentApprovalId: approvalId },
  )) as { readonly code?: string; readonly message?: string };
  expect(rejection).toMatchObject({
    code: "approval.already_resolved",
    message: "This approval was already resolved.",
  });
});

test("disables state-changing controls after a terminal connection failure", async ({ page, wi }) => {
  let closeConnection: (() => void) | null = null;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    browserSocket.connectToServer();
    closeConnection = () => browserSocket.close({ code: 1008, reason: "terminal policy" });
  });
  await openWi(page, wi);
  await createSession(page, "Terminal controls");
  await sendMessage(page, "[approval] terminal control state");
  await expect(page.getByTestId("approval-panel")).toBeVisible();

  if (closeConnection === null) throw new Error("WebSocket route was not established");
  (closeConnection as () => void)();
  await expect(page.locator(".connection")).toContainText("error");
  await expect(page.getByLabel("New session title")).toBeDisabled();
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel run", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reload Wi", exact: true })).toBeVisible();
});

test("isolates a fatal session projection while leaving global session creation available", async ({
  page,
  wi,
}) => {
  let sendToBrowser: ((message: string) => void) | null = null;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    browserSocket.connectToServer();
    sendToBrowser = (message) => browserSocket.send(message);
  });
  await openWi(page, wi);
  const sessionId = await createSession(page, "Fatal projection controls");
  await sendMessage(page, "[approval] projection must be trusted");
  await expect(page.getByTestId("approval-panel")).toBeVisible();

  if (sendToBrowser === null) throw new Error("WebSocket route was not established");
  (sendToBrowser as (message: string) => void)(
    JSON.stringify({
      v: 1,
      kind: "protocol.error",
      sessionId,
      code: "replay.sequence_conflict",
      message: "The session replay detected conflicting committed history.",
      diagnosticId: "err_fatalProjection",
      recoverable: false,
    }),
  );

  await expect(page.getByText(/Session integrity error:/u)).toBeVisible();
  await expect(page.getByLabel("New session title")).toBeEnabled();
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel run", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reload session", exact: true })).toBeVisible();
});

test("retries the same command ID after disconnect before routing", async ({ page, wi }) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Before route retry");
  await page.getByLabel("Message", { exact: true }).fill("[before-route] exactly once");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const commandId = await wi.waitForBeforeRouteBlock();
  await expect(
    page.getByText("Message command pending durable acceptance.", { exact: true }),
  ).toBeVisible();
  expect(await wi.disconnect()).toBe(1);

  await expect(page.locator(".connection")).toContainText("Connected");
  await wi.waitForBeforeRouteRetry(commandId);
  wi.releaseBeforeRoute(commandId);
  await expect(
    page.getByTestId("timeline-user").filter({ hasText: "[before-route] exactly once" }),
  ).toHaveCount(1);
  await expectRunState(page, "completed");
  const head = await wi.sessionHead(sessionId);
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-last-sequence", String(head));
});

test("disconnects during historical replay and recovers the exact cursor", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Disconnect during replay");
  await sendMessage(page, "durable replay history");
  await expectRunState(page, "completed");
  const head = await wi.sessionHead(sessionId);
  await page.close();

  await wi.armReplay(sessionId);
  const reopened = await context.newPage();
  await reopened.goto(`${wi.origin}/?session=${sessionId}`);
  await expect(reopened.locator(".connection")).toContainText("Connected");
  await wi.waitForReplayBlock(sessionId);
  expect(await wi.disconnect()).toBe(1);
  wi.releaseReplay(sessionId);

  await expect(reopened.locator(".connection")).toContainText("Connected");
  await expect(reopened.getByText("Session state: live")).toBeVisible();
  await expect(reopened.getByTestId("timeline")).toHaveAttribute(
    "data-last-sequence",
    String(head),
  );
  await expectRunState(reopened, "completed");
});

test("reconciles approval resolution after disconnect before acknowledgement", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Approval acknowledgement reconnect");
  await sendMessage(page, "[approval] reconnect resolution");
  await expect(page.getByTestId("approval-panel")).toBeVisible();
  const second = await context.newPage();
  await openWi(second, wi, sessionId);
  await expect(second.getByTestId("approval-panel")).toBeVisible();

  await wi.armApprovalAcknowledgement();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const commandId = await wi.waitForApprovalAcknowledgementBlock();
  expect(await wi.disconnect()).toBe(2);
  wi.releaseApprovalAcknowledgement(commandId);

  await expect(page.locator(".connection")).toContainText("Connected");
  await expect(second.locator(".connection")).toContainText("Connected");
  await expectRunState(page, "completed");
  await expectRunState(second, "completed");
  await expect(page.getByText("Command reconciled after reconnect.", { exact: true })).toBeVisible();
  await expect(page.getByText("Guarded echo completed.", { exact: true })).toHaveCount(1);
  await expect(second.getByText("Guarded echo completed.", { exact: true })).toHaveCount(1);
});

test("serializes a simultaneous two-tab approval race through both UIs", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Approval UI race");
  await sendMessage(page, "[approval] simultaneous UI race");
  await expect(page.getByTestId("approval-panel")).toBeVisible();
  const second = await context.newPage();
  await openWi(second, wi, sessionId);
  await expect(second.getByTestId("approval-panel")).toBeVisible();

  await wi.armApprovalRace();
  await Promise.all([
    page
      .getByRole("button", { name: "Approve", exact: true })
      .evaluate((button) => (button as unknown as { click(): void }).click()),
    second
      .getByRole("button", { name: "Approve", exact: true })
      .evaluate((button) => (button as unknown as { click(): void }).click()),
  ]);
  const commandIds = await wi.waitForApprovalRace();
  expect(new Set(commandIds).size).toBe(2);
  wi.releaseApprovalRace();

  await expect(page.getByTestId("approval-panel")).toHaveCount(0);
  await expect(second.getByTestId("approval-panel")).toHaveCount(0);
  await expectRunState(page, "completed");
  await expectRunState(second, "completed");
  await expect
    .poll(async () =>
      (await page.locator('[data-error-code="approval.already_resolved"]').count()) +
      (await second.locator('[data-error-code="approval.already_resolved"]').count()),
    )
    .toBe(1);
  await expect(page.getByText("Guarded echo completed.", { exact: true })).toHaveCount(1);
  await expect(second.getByText("Guarded echo completed.", { exact: true })).toHaveCount(1);
});

test("restores keyboard focus after approval and cancel controls disappear", async ({ page, wi }) => {
  await openWi(page, wi);
  await createSession(page, "Keyboard focus approval");
  await sendMessage(page, "[approval] keyboard focus");
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await approve.focus();
  await page.keyboard.press("Enter");
  await expectRunState(page, "completed");
  await expect
    .poll(() =>
      page
        .getByLabel("Current run status")
        .evaluate((element) => element === element.ownerDocument.activeElement),
    )
    .toBe(true);

  await createSession(page, "Keyboard focus cancel");
  await sendMessage(page, "[slow] keyboard cancellation");
  const cancel = page.getByRole("button", { name: "Cancel run", exact: true });
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expectRunState(page, "cancelled");
  await expect
    .poll(() =>
      page
        .getByLabel("Current run status")
        .evaluate((element) => element === element.ownerDocument.activeElement),
    )
    .toBe(true);
});

test("restores keyboard focus after a pending-input response disappears", async ({ page, wi }) => {
  let sendToBrowser: ((message: string) => void) | null = null;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    sendToBrowser = (message) => browserSocket.send(message);
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly method?: string;
        readonly commandId?: string;
        readonly sessionId?: string;
      };
      if (
        message.kind === "command" &&
        message.method === "input.respond" &&
        message.commandId !== undefined &&
        message.sessionId !== undefined
      ) {
        browserSocket.send(
          JSON.stringify({
            v: 1,
            kind: "command.accepted",
            commandId: message.commandId,
            sessionId: message.sessionId,
            acceptedSequence: 3,
            result: {},
            duplicate: false,
          }),
        );
        browserSocket.send(
          JSON.stringify({
            v: 1,
            kind: "event",
            sessionId: message.sessionId,
            sequence: 3,
            eventId: "evt_focusInputResolved",
            eventType: "input.resolved",
            createdAtMs: 3,
            data: {
              eventVersion: 1,
              runId: "run_focusInput",
              inputId: "input_focusInput",
              value: "yes",
            },
          }),
        );
        return;
      }
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi);
  const sessionId = await createSession(page, "Keyboard focus input");
  if (sendToBrowser === null) throw new Error("WebSocket route was not established");
  (sendToBrowser as (message: string) => void)(
    JSON.stringify({
      v: 1,
      kind: "event",
      sessionId,
      sequence: 2,
      eventId: "evt_focusInputRequested",
      eventType: "input.requested",
      createdAtMs: 2,
      data: {
        eventVersion: 1,
        runId: "run_focusInput",
        inputId: "input_focusInput",
        prompt: "Continue with keyboard focus?",
      },
    }),
  );

  await page.getByLabel("Response as JSON").fill('"yes"');
  const respond = page.getByRole("button", { name: "Respond", exact: true });
  await respond.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("pending-input-panel")).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .getByLabel("Message", { exact: true })
        .evaluate((element) => element === element.ownerDocument.activeElement),
    )
    .toBe(true);
});

test("reconnects after forced close and reconciles a lost acknowledgement without duplication", async ({
  page,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Reconnect commands");
  expect(await wi.disconnect(4409, "slow consumer")).toBe(1);
  await expect(page.locator(".connection")).not.toContainText("Connected");
  await expect(page.locator(".connection")).toContainText("Connected");

  await page.getByLabel("Message", { exact: true }).fill("[lost-ack] exactly once");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const commandId = await wi.waitForAcknowledgementBlock();
  await expect(page.getByText("Message command pending durable acceptance.", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("timeline-user").filter({ hasText: "[lost-ack] exactly once" }),
  ).toHaveCount(1);
  expect(await wi.disconnect()).toBe(1);
  wi.releaseAcknowledgement(commandId);

  await expect(page.locator(".connection")).toContainText("Connected");
  await expect(page.getByText("Command reconciled after reconnect.", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("timeline-user").filter({ hasText: "[lost-ack] exactly once" }),
  ).toHaveCount(1);
  await expectRunState(page, "completed");
  const head = await wi.sessionHead(sessionId);
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-last-sequence", String(head));
});

test("renders interrupted and XSS-shaped provider output safely", async ({ page, wi }) => {
  await openWi(page, wi);
  await createSession(page, "Interrupted output");
  await sendMessage(page, "[interrupt] preserve partial output");
  await expect(page.getByText("Visible partial output.", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("timeline-assistant").getByText("Interrupted partial output", { exact: true }),
  ).toBeVisible();
  await expectRunState(page, "interrupted");

  await createSession(page, "Untrusted output");
  await sendMessage(page, "[xss] render model output as text");
  const payload = '<img src=x onerror="globalThis.__wiXss=1"><script>globalThis.__wiXss=2</script>javascript:alert(1)';
  await expect(page.getByText(payload, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as { __wiXss?: number }).__wiXss)).toBeUndefined();
  await expect(page.locator(".timeline-item img, .timeline-item script, .timeline-item a")).toHaveCount(0);
  expect(
    await page.evaluate(async () => {
      const browser = globalThis as unknown as {
        readonly document: { readonly cookie: string };
        readonly localStorage: { readonly length: number; key(index: number): string | null };
        readonly sessionStorage: { readonly length: number; key(index: number): string | null };
        readonly indexedDB: { databases(): Promise<readonly { readonly name?: string }[]> };
      };
      const keys = (storage: { readonly length: number; key(index: number): string | null }) =>
        Array.from({ length: storage.length }, (_, index) => storage.key(index));
      return {
        cookie: browser.document.cookie,
        localStorageKeys: keys(browser.localStorage),
        sessionStorageKeys: keys(browser.sessionStorage),
        databases: (await browser.indexedDB.databases()).map((database) => database.name),
      };
    }),
  ).toEqual({ cookie: "", localStorageKeys: [], sessionStorageKeys: [], databases: [] });
});

test("retries a recoverable replay failure and returns to live", async ({ page, wi }) => {
  let injected = false;
  let subscribeCount = 0;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly sessionId?: string;
      };
      if (message.kind === "subscribe") subscribeCount += 1;
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => {
      browserSocket.send(frame);
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly sessionId?: string;
      };
      if (!injected && message.kind === "replay.complete" && message.sessionId !== undefined) {
        injected = true;
        browserSocket.send(
          JSON.stringify({
            v: 1,
            kind: "protocol.error",
            sessionId: message.sessionId,
            code: "replay.query_failed",
            message: "The session subscription could not be completed safely.",
            diagnosticId: "err_recoverableReplay",
            recoverable: true,
          }),
        );
      }
    });
  });

  await openWi(page, wi);
  await createSession(page, "Recoverable replay");
  await expect.poll(() => subscribeCount).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("Session state: live")).toBeVisible();
  await sendMessage(page, "events still arrive after replay recovery");
  await expectRunState(page, "completed");
});

test("recovers when replay-complete advertises one missing tail event", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Replay complete mismatch");
  await sendMessage(page, "build a durable history before replay mismatch");
  await expectRunState(page, "completed");
  const head = await wi.sessionHead(sessionId);
  expect(head).toBeGreaterThan(1);

  const reopened = await context.newPage();
  let droppedTail = false;
  await reopened.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    serverSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly sequence?: number;
      };
      if (!droppedTail && message.kind === "event" && message.sequence === head) {
        droppedTail = true;
        return;
      }
      browserSocket.send(frame);
    });
  });

  await openWi(reopened, wi, sessionId);
  await expect(reopened.getByText("Session state: live")).toBeVisible();
  await expect(reopened.getByTestId("timeline")).toHaveAttribute(
    "data-last-sequence",
    String(head),
  );
  await expectRunState(reopened, "completed");
  expect(droppedTail).toBe(true);
});

test("reconciles a session selected during delayed hello and welcome", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const firstSessionId = await createSession(page, "Handshake A");
  await createSession(page, "Handshake B");

  const delayed = await context.newPage();
  let releaseWelcome: (() => void) | null = null;
  let markWelcomeCaptured: (() => void) | null = null;
  const welcomeCaptured = new Promise<void>((resolve) => {
    markWelcomeCaptured = resolve;
  });
  await delayed.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    const queued: Array<string | Buffer> = [];
    let released = false;
    releaseWelcome = () => {
      released = true;
      for (const frame of queued) browserSocket.send(frame);
      queued.length = 0;
    };
    serverSocket.onMessage((frame) => {
      if (released) {
        browserSocket.send(frame);
        return;
      }
      queued.push(frame);
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as { readonly kind?: string };
      if (message.kind === "welcome") markWelcomeCaptured?.();
    });
  });

  await delayed.goto(`${wi.origin}/?session=${firstSessionId}`);
  await welcomeCaptured;
  await delayed.getByRole("button", { name: /^Handshake B/u }).click();
  if (releaseWelcome === null) throw new Error("Delayed WebSocket route was not established");
  (releaseWelcome as () => void)();

  await expect(delayed.locator(".connection")).toContainText("Connected");
  await expect(delayed.getByRole("heading", { name: "Handshake B", exact: true })).toBeVisible();
  await expect(delayed.getByText("Session state: live")).toBeVisible();
});

test("ignores a stale event after its session is intentionally closed", async ({ page, wi }) => {
  const subscribeCounts = new Map<string, number>();
  let sendToBrowser: ((message: string) => void) | null = null;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    sendToBrowser = (message) => browserSocket.send(message);
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly sessionId?: string;
      };
      if (message.kind === "subscribe" && message.sessionId !== undefined) {
        subscribeCounts.set(message.sessionId, (subscribeCounts.get(message.sessionId) ?? 0) + 1);
      }
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi);
  const firstSessionId = await createSession(page, "Closed subscription A");
  await createSession(page, "Closed subscription B");
  expect(subscribeCounts.get(firstSessionId)).toBe(1);
  if (sendToBrowser === null) throw new Error("WebSocket route was not established");
  (sendToBrowser as (message: string) => void)(
    JSON.stringify({
      v: 1,
      kind: "event",
      sessionId: firstSessionId,
      sequence: 2,
      eventId: "evt_staleClosedSession",
      eventType: "user.message.appended",
      createdAtMs: 2,
      data: {
        eventVersion: 1,
        messageId: "msg_staleClosedSession",
        runId: "run_staleClosedSession",
        text: "stale closed-session frame",
      },
    }),
  );

  await sendMessage(page, "selected session remains authoritative");
  await expectRunState(page, "completed");
  expect(subscribeCounts.get(firstSessionId)).toBe(1);
});

test("detects a dropped event and resynchronizes the exact replay suffix", async ({ page, wi }) => {
  let dropped = false;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    serverSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as { readonly kind?: string; readonly eventType?: string };
      if (!dropped && message.kind === "event" && message.eventType === "run.created") {
        dropped = true;
        return;
      }
      browserSocket.send(frame);
    });
  });

  await openWi(page, wi);
  const sessionId = await createSession(page, "Replay gap");
  await sendMessage(page, "complete after a forced sequence gap");
  await expectRunState(page, "completed");
  expect(dropped).toBe(true);
  await expect(page.getByText("A sequence gap was detected. Replaying from the last trusted event.", { exact: true })).toBeVisible();
  await expect(page.getByText("Session state: live")).toBeVisible();
  const head = await wi.sessionHead(sessionId);
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-last-sequence", String(head));
});
