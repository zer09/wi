import { WiRuntime, WiServer } from "../../../apps/server/dist/index.js";
import { FakeProviderAdapter, fakeProviderGateLabel } from "../../../packages/provider-fake/dist/index.js";

const [homeDirectory] = process.argv.slice(2);
if (homeDirectory === undefined || typeof process.send !== "function") process.exit(64);

const send = (message) => process.send?.(message);
const providerRequests = [];
const acknowledgementGates = new Map();
const blockedAcknowledgementCommands = new Set();
const beforeRouteGates = new Map();
const blockedBeforeRouteCommands = new Set();
const replayGates = new Map();
const armedReplaySessions = new Set();
const approvalAcknowledgementGates = new Map();
const approvalRaceGates = new Map();
let approvalAcknowledgementArmed = false;
let approvalRaceArmed = false;

class E2EProvider extends FakeProviderAdapter {
  async *stream(request, context, signal) {
    providerRequests.push(request);
    send({
      type: "provider-request",
      runId: request.runId,
      sessionId: context.sessionId,
      scenario: request.providerConfig?.scenario,
    });
    const userText = request.input.findLast(
      (item) => item.type === "message" && item.role === "user",
    )?.text;
    if (userText?.startsWith("[xss]") && request.stepIndex === 0) {
      yield {
        type: "response.started",
        runId: request.runId,
        stepId: request.stepId,
        stepIndex: request.stepIndex,
        responseId: `response_${request.runId}_xss`,
      };
      yield {
        type: "text.delta",
        runId: request.runId,
        stepId: request.stepId,
        stepIndex: request.stepIndex,
        delta: '<img src=x onerror="globalThis.__wiXss=1"><script>globalThis.__wiXss=2</script>javascript:alert(1)',
      };
      yield {
        type: "response.completed",
        runId: request.runId,
        stepId: request.stepId,
        stepIndex: request.stepIndex,
        responseId: `response_${request.runId}_xss`,
      };
      return;
    }
    yield* super.stream(request, context, signal);
  }
}

const provider = new E2EProvider();
const runtime = new WiRuntime({
  homeDirectory,
  provider,
  selectProviderConfiguration: (command) => {
    const text = command.params.text;
    if (text.startsWith("[slow]")) return { scenario: "slow-stream" };
    if (text.startsWith("[approval]")) return { scenario: "approval-round-trip" };
    if (text.startsWith("[interrupt]")) return { scenario: "failure-after-visible-output" };
    return { scenario: "plain-text" };
  },
});
const server = new WiServer({
  runtime,
  port: 0,
  gateway: {
    commandHooks: {
      beforeRoute: async (command) => {
        if (
          command.method === "message.submit" &&
          command.params.text.startsWith("[before-route]")
        ) {
          if (blockedBeforeRouteCommands.has(command.commandId)) {
            send({ type: "before-route-retried", commandId: command.commandId });
          } else {
            blockedBeforeRouteCommands.add(command.commandId);
            send({ type: "before-route-blocked", commandId: command.commandId });
            await new Promise((resolve) => beforeRouteGates.set(command.commandId, resolve));
          }
        }
        if (command.method === "approval.resolve" && approvalRaceArmed) {
          send({
            type: "approval-race-blocked",
            commandId: command.commandId,
            count: approvalRaceGates.size + 1,
          });
          await new Promise((resolve) => approvalRaceGates.set(command.commandId, resolve));
        }
      },
      afterRouteBeforeSend: async (command) => {
        if (
          command.method === "message.submit" &&
          command.params.text.startsWith("[lost-ack]") &&
          !blockedAcknowledgementCommands.has(command.commandId)
        ) {
          blockedAcknowledgementCommands.add(command.commandId);
          send({ type: "acknowledgement-blocked", commandId: command.commandId });
          await new Promise((resolve) => acknowledgementGates.set(command.commandId, resolve));
        }
        if (command.method === "approval.resolve" && approvalAcknowledgementArmed) {
          approvalAcknowledgementArmed = false;
          send({ type: "approval-acknowledgement-blocked", commandId: command.commandId });
          await new Promise((resolve) =>
            approvalAcknowledgementGates.set(command.commandId, resolve),
          );
        }
      },
    },
    replayHooks: {
      afterHistoricalRead: async (sessionId) => {
        if (!armedReplaySessions.delete(sessionId)) return;
        send({ type: "replay-blocked", sessionId });
        await new Promise((resolve) => replayGates.set(sessionId, resolve));
      },
    },
  },
});
await server.start();
send({ type: "ready", origin: server.origin, pid: process.pid });

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const gates of [
    acknowledgementGates,
    beforeRouteGates,
    replayGates,
    approvalAcknowledgementGates,
    approvalRaceGates,
  ]) {
    for (const release of gates.values()) release();
    gates.clear();
  }
  try {
    await server.close();
    send({ type: "closed" });
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  }
}

process.on("message", (message) => {
  if (message === null || typeof message !== "object") return;
  void (async () => {
    switch (message.type) {
      case "disconnect":
        send({
          type: "disconnected",
          count: server.gateway.disconnectActiveConnections(
            message.code ?? 1012,
            message.reason ?? "E2E forced reconnect",
          ),
        });
        return;
      case "release-ack": {
        const release = acknowledgementGates.get(message.commandId);
        acknowledgementGates.delete(message.commandId);
        release?.();
        return;
      }
      case "release-before-route": {
        const release = beforeRouteGates.get(message.commandId);
        beforeRouteGates.delete(message.commandId);
        release?.();
        return;
      }
      case "arm-replay":
        armedReplaySessions.add(message.sessionId);
        send({ type: "replay-armed", requestId: message.requestId });
        return;
      case "release-replay": {
        const release = replayGates.get(message.sessionId);
        replayGates.delete(message.sessionId);
        release?.();
        return;
      }
      case "arm-approval-acknowledgement":
        approvalAcknowledgementArmed = true;
        send({ type: "approval-acknowledgement-armed", requestId: message.requestId });
        return;
      case "release-approval-acknowledgement": {
        const release = approvalAcknowledgementGates.get(message.commandId);
        approvalAcknowledgementGates.delete(message.commandId);
        release?.();
        return;
      }
      case "arm-approval-race":
        approvalRaceArmed = true;
        send({ type: "approval-race-armed", requestId: message.requestId });
        return;
      case "release-approval-race":
        approvalRaceArmed = false;
        for (const release of approvalRaceGates.values()) release();
        approvalRaceGates.clear();
        return;
      case "release-provider":
        for (const request of providerRequests) {
          if (request.providerConfig?.scenario !== "slow-stream") continue;
          const label = fakeProviderGateLabel(request.runId, message.gate);
          await provider.controller.waitUntilBlocked(label);
          provider.controller.release(label);
        }
        send({ type: "provider-released", requestId: message.requestId });
        return;
      case "session-head": {
        const session = await runtime.storage.openSession(message.sessionId);
        send({
          type: "session-head",
          requestId: message.requestId,
          sequence: await session.getHeadSequence(),
        });
        return;
      }
      case "close":
        await close();
        return;
    }
  })().catch((error) => {
    send({
      type: "control-error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
});
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
