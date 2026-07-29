import { stat } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { startRestartableServer, type RestartableServer } from "./fixtures/restartable-server.js";

async function openWi(page: Page, server: RestartableServer, sessionId?: string): Promise<void> {
  const url = sessionId === undefined ? server.origin : `${server.origin}/?session=${sessionId}`;
  await page.goto(url);
  await expect(page.locator(".connection")).toContainText("Connected", { timeout: 15_000 });
}

async function createSession(page: Page, title: string): Promise<string> {
  await page.getByLabel("New session title").fill(title);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
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
}

async function expectRunState(page: Page, state: string): Promise<void> {
  await expect(page.getByLabel("Current run status").getByText(state, { exact: true })).toBeVisible();
}

async function visibleSessionState(page: Page): Promise<{
  readonly title: string;
  readonly timeline: string;
  readonly sequence: string | null;
  readonly runStatus: string;
}> {
  return {
    title: (await page.locator("main h2").first().textContent())?.trim() ?? "",
    timeline: (await page.getByTestId("timeline").innerText()).trim(),
    sequence: await page.getByTestId("timeline").getAttribute("data-last-sequence"),
    runStatus: (await page.getByLabel("Current run status").innerText()).trim(),
  };
}

interface RecordedWebSocketClose {
  readonly code: number;
  readonly reason: string;
}

async function recordWebSocketCloses(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = globalThis as typeof globalThis & {
      __wiRecordedWebSocketCloses?: { code: number; reason: string }[];
    };
    const closes: { code: number; reason: string }[] = [];
    Object.defineProperty(scope, "__wiRecordedWebSocketCloses", {
      configurable: true,
      value: closes,
    });
    const NativeWebSocket = scope.WebSocket;
    const TrackingWebSocket = new Proxy(NativeWebSocket, {
      construct(target, argumentsList, newTarget) {
        const socket = Reflect.construct(target, argumentsList, newTarget) as WebSocket;
        socket.addEventListener("close", (event) => {
          closes.push({ code: event.code, reason: event.reason });
        });
        return socket;
      },
    });
    Object.defineProperty(scope, "WebSocket", {
      configurable: true,
      value: TrackingWebSocket,
      writable: true,
    });
  });
}

async function recordedWebSocketCloses(page: Page): Promise<readonly RecordedWebSocketClose[]> {
  return page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __wiRecordedWebSocketCloses?: { code: number; reason: string }[];
    };
    return scope.__wiRecordedWebSocketCloses ?? [];
  });
}

async function resendMessageCommand(
  page: Page,
  input: {
    readonly commandId: string;
    readonly sessionId: string;
    readonly text: string;
  },
): Promise<{ readonly kind: string; readonly runId?: string }> {
  return page.evaluate(
    ({ commandId, sessionId, text }) =>
      new Promise<{ readonly kind: string; readonly runId?: string }>((resolve, reject) => {
        const browser = globalThis as unknown as { readonly location: { readonly href: string } };
        const socket = new WebSocket(new URL("/ws", browser.location.href), "wi.v1");
        const timer = globalThis.setTimeout(() => {
          socket.close();
          reject(new Error("Timed out resending the accepted command"));
        }, 8_000);
        socket.addEventListener("open", () => {
          socket.send(
            JSON.stringify({
              v: 1,
              kind: "hello",
              clientId: "client_finalAcceptanceDuplicate",
              resume: [],
            }),
          );
        });
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as {
            readonly kind?: string;
            readonly commandId?: string;
            readonly runId?: string;
          };
          if (message.kind === "welcome") {
            socket.send(
              JSON.stringify({
                v: 1,
                kind: "command",
                commandId,
                sessionId,
                method: "message.submit",
                params: { text },
              }),
            );
            return;
          }
          if (
            (message.kind === "command.accepted" || message.kind === "command.rejected") &&
            message.commandId === commandId
          ) {
            globalThis.clearTimeout(timer);
            socket.close();
            resolve({
              kind: message.kind,
              ...(message.runId === undefined ? {} : { runId: message.runId }),
            });
          }
        });
        socket.addEventListener("error", () => {
          globalThis.clearTimeout(timer);
          reject(new Error("Command replay WebSocket failed"));
        });
      }),
    input,
  );
}

test("completes the exact v0.1 vertical-slice acceptance scenario", async ({ browser }) => {
  test.setTimeout(90_000);
  const server = await startRestartableServer({ replayLiveEvents: 1 });
  const context = await browser.newContext();
  const sessionATitle = "Final acceptance A";
  const sessionBTitle = "Final acceptance B";
  const slowMessage = "[slow] final acceptance survives closed tabs";
  const echoMessage = "[echo] final acceptance tool round trip";
  const approvalMessage = "[approval] final acceptance guarded echo";
  const partialMessage = "[partial] final acceptance incomplete tool call";
  const overflowMessage = "[slow] final acceptance overflows replay backlog";

  try {
    const tabA = await context.newPage();
    await openWi(tabA, server);
    const sessionA = await createSession(tabA, sessionATitle);
    await sendMessage(tabA, slowMessage);
    await server.waitForProviderScenario("slow-stream");
    await expect(tabA.getByText("Slow", { exact: true })).toBeVisible();

    const sessionB = await createSession(tabA, sessionBTitle);
    await sendMessage(tabA, echoMessage);
    await expect(tabA.getByText("Tool round trip completed.", { exact: true })).toBeVisible();
    await expectRunState(tabA, "completed");

    await selectSession(tabA, sessionATitle);
    const tabB = await context.newPage();
    await openWi(tabB, server, sessionA);
    await expect(tabB.getByText("Slow", { exact: true })).toBeVisible();
    await expect.poll(() => visibleSessionState(tabB)).toEqual(await visibleSessionState(tabA));

    await Promise.all([tabA.close(), tabB.close()]);
    await server.releaseProvider("slow");

    const replayed = await context.newPage();
    await openWi(replayed, server, sessionA);
    await expect(replayed.getByText("Slow fake response.", { exact: true })).toBeVisible();
    await expectRunState(replayed, "completed");
    await expect(replayed.getByTestId("timeline")).toHaveAttribute(
      "data-last-sequence",
      String(await server.sessionHead(sessionA)),
    );

    await sendMessage(replayed, approvalMessage);
    await expect(replayed.getByTestId("approval-panel")).toBeVisible();
    await expect
      .poll(() => server.acceptedMessage(approvalMessage).catch(() => null))
      .not.toBeNull();
    const originalCommand = await server.acceptedMessage(approvalMessage);
    const catalogSentinel = await server.createIdleSession("Final acceptance catalog sentinel");
    await replayed.close();

    await server.restart();
    const catalogOnly = await server.acceptanceStorage();
    expect(catalogOnly.sessions.map((value) => value.sessionId)).toEqual(
      expect.arrayContaining([sessionA, sessionB, catalogSentinel]),
    );
    expect(catalogOnly.openSessionIds).not.toContain(catalogSentinel);

    const approvalPage = await context.newPage();
    await openWi(approvalPage, server, sessionA);
    await expect(approvalPage.getByTestId("approval-panel")).toBeVisible();
    await approvalPage.getByRole("button", { name: "Approve", exact: true }).click();
    await expectRunState(approvalPage, "completed");
    await expect(approvalPage.getByText("Guarded echo completed.", { exact: true })).toHaveCount(1);

    const guardedExecutions = (await server.toolExecutions()).filter(
      (value) => value.sessionId === sessionA && value.callId === "call_guardedEchoRoundTrip",
    );
    expect(guardedExecutions).toHaveLength(1);

    const headBeforeDuplicate = await server.sessionHead(sessionA);
    const duplicateResult = await resendMessageCommand(approvalPage, {
      commandId: originalCommand.commandId,
      sessionId: sessionA,
      text: approvalMessage,
    });
    expect(duplicateResult).toEqual({ kind: "command.accepted", runId: originalCommand.runId });
    expect(await server.sessionHead(sessionA)).toBe(headBeforeDuplicate);

    const executionsBeforePartial = await server.toolExecutions();
    await sendMessage(approvalPage, partialMessage);
    await server.waitForProviderScenario("partial-tool-call-without-terminal");
    await server.releaseProvider("partial");
    await expect
      .poll(async () => (await approvalPage.getByLabel("Current run status").innerText()).trim())
      .toMatch(/failed|interrupted/u);
    expect(await server.toolExecutions()).toEqual(executionsBeforePartial);
    expect(
      (await server.toolExecutions()).some(
        (value) => value.sessionId === sessionA && value.callId === "call_partialWithoutTerminal",
      ),
    ).toBe(false);

    await approvalPage.close();
    await server.armReplay(sessionA);
    const slowConsumerPage = await context.newPage();
    await recordWebSocketCloses(slowConsumerPage);
    await slowConsumerPage.goto(`${server.origin}/?session=${sessionA}`);
    await expect(slowConsumerPage.locator(".connection")).toContainText("Connected");
    await server.waitForReplayBlock(sessionA);

    const overflowCommand = await resendMessageCommand(slowConsumerPage, {
      commandId: "cmd_finalAcceptanceSlowConsumer",
      sessionId: sessionA,
      text: overflowMessage,
    });
    expect(overflowCommand.kind).toBe("command.accepted");
    await server.waitForProviderScenario("slow-stream");
    await server.releaseReplay(sessionA);
    await expect
      .poll(() => recordedWebSocketCloses(slowConsumerPage))
      .toContainEqual({ code: 4409, reason: "slow consumer" });
    await expect(slowConsumerPage.locator(".connection")).toContainText("Connected", {
      timeout: 15_000,
    });
    await expect
      .poll(async () =>
        (await server.connectionSnapshots())
          .filter((snapshot) => !snapshot.closed)
          .map((snapshot) => snapshot.subscriptions),
      )
      .toEqual([1]);

    await server.releaseProvider("slow");
    await expectRunState(slowConsumerPage, "completed");
    await expect(
      slowConsumerPage.getByTestId("timeline-user").filter({ hasText: overflowMessage }),
    ).toHaveCount(1);
    const reconstructedState = await visibleSessionState(slowConsumerPage);
    const comparisonPage = await context.newPage();
    await openWi(comparisonPage, server, sessionA);
    await expect.poll(() => visibleSessionState(comparisonPage)).toEqual(reconstructedState);
    await comparisonPage.close();

    const storage = await server.acceptanceStorage();
    const sessionRows = storage.sessions.filter((value) =>
      value.sessionId === sessionA || value.sessionId === sessionB,
    );
    expect(sessionRows).toHaveLength(2);
    const databasePaths = sessionRows.map((value) => join(server.homeDirectory, value.dbRelativePath));
    expect(new Set(databasePaths).size).toBe(2);
    for (const databasePath of databasePaths) expect((await stat(databasePath)).isFile()).toBe(true);

    const headBeforeMutation = await server.sessionHead(sessionA);
    expect(await server.mutateEvent(sessionA, "update")).toContain("session events are immutable");
    expect(await server.mutateEvent(sessionA, "delete")).toContain("session events are immutable");
    expect(await server.sessionHead(sessionA)).toBe(headBeforeMutation);
    const browserCredentials = (await context.cookies(server.origin))
      .filter((cookie) => cookie.httpOnly)
      .map((cookie) => cookie.value);
    expect(browserCredentials.length).toBeGreaterThan(0);
    const browserStorage = await slowConsumerPage.evaluate(async () => {
      interface BrowserStorage {
        readonly length: number;
        key(index: number): string | null;
        getItem(key: string): string | null;
      }
      const browser = globalThis as unknown as {
        readonly document: { readonly cookie: string };
        readonly localStorage: BrowserStorage;
        readonly sessionStorage: BrowserStorage;
        readonly indexedDB: {
          databases(): Promise<readonly { readonly name?: string }[]>;
        };
      };
      const storageEntries = (
        storage: BrowserStorage,
      ): readonly (readonly [string, string | null])[] =>
        Array.from({ length: storage.length }, (_value, index) => {
          const key = storage.key(index) ?? "";
          return [key, storage.getItem(key)] as const;
        });
      return {
        cookie: browser.document.cookie,
        localStorage: storageEntries(browser.localStorage),
        sessionStorage: storageEntries(browser.sessionStorage),
        indexedDatabases: (await browser.indexedDB.databases()).map(
          (database) => database.name ?? "",
        ),
      };
    });
    const serializedBrowserStorage = JSON.stringify(browserStorage);
    expect(
      browserCredentials.some((credential) => serializedBrowserStorage.includes(credential)),
    ).toBe(false);

    const security = await server.securityAudit([sessionA, sessionB], browserCredentials);
    expect(security).toEqual({
      logsContainAuditSecret: false,
      exportsContainCredential: false,
      retainedArtifactsContainCredential: false,
    });
  } finally {
    await context.close();
    await server.close();
  }
});
