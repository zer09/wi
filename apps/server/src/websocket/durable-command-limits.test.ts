import { canonicalJsonBytes } from "@wi/protocol";
import { describe, expect, it } from "vitest";

import {
  DURABLE_EVENT_ENVELOPE_RESERVE_BYTES,
  browserCommandLimits,
  durableCommandPayloadBytes,
  maximumDurableCommandPayloadBytes,
} from "./durable-command-limits.js";

describe("durable command limits", () => {
  it("subtracts one fixed envelope reserve from the smallest durable capacity", () => {
    expect(
      maximumDurableCommandPayloadBytes({
        outboundSingleMessageBytes: 100_000,
        replayLiveSingleEventBytes: 90_000,
        replayPageSingleEventBytes: 80_000,
      }),
    ).toBe(80_000 - DURABLE_EVENT_ENVELOPE_RESERVE_BYTES);

    expect(() =>
      maximumDurableCommandPayloadBytes({
        outboundSingleMessageBytes: DURABLE_EVENT_ENVELOPE_RESERVE_BYTES,
        replayLiveSingleEventBytes: 90_000,
        replayPageSingleEventBytes: 80_000,
      }),
    ).toThrow(/event envelope reserve/u);
  });

  it("reserves enough bytes for worst-case bounded durable event envelopes", () => {
    const suffix = "x".repeat(120);
    const base = {
      v: 1,
      kind: "event",
      sessionId: `ses_${suffix}`,
      sequence: Number.MAX_SAFE_INTEGER,
      eventId: `evt_${suffix}`,
      createdAtMs: Number.MAX_SAFE_INTEGER,
    } as const;
    const cases = [
      {
        payload: 'title " 💥',
        event: {
          ...base,
          eventType: "session.created",
          data: {
            eventVersion: 1,
            title: 'title " 💥',
            projectId: `project_${suffix}`,
          },
        },
      },
      {
        payload: "message \\ 💥",
        event: {
          ...base,
          eventType: "user.message.appended",
          data: {
            eventVersion: 1,
            messageId: `msg_${suffix}`,
            runId: `run_${suffix}`,
            text: "message \\ 💥",
          },
        },
      },
      {
        payload: { z: "💥", a: ['"', null, true] },
        event: {
          ...base,
          eventType: "input.resolved",
          data: {
            eventVersion: 1,
            runId: `run_${suffix}`,
            inputId: `input_${suffix}`,
            value: { z: "💥", a: ['"', null, true] },
          },
        },
      },
    ];

    for (const { event, payload } of cases) {
      const envelopeBytes =
        Buffer.byteLength(JSON.stringify(event)) - canonicalJsonBytes(payload).byteLength;
      expect(envelopeBytes).toBeLessThanOrEqual(DURABLE_EVENT_ENVELOPE_RESERVE_BYTES);
    }
  });

  it("caps command payloads against the duplicated storage worker RPC value", () => {
    expect(
      maximumDurableCommandPayloadBytes({
        outboundSingleMessageBytes: 1_000_000,
        replayLiveSingleEventBytes: 1_000_000,
        replayPageSingleEventBytes: 1_000_000,
      }),
    ).toBe(500_000 - DURABLE_EVENT_ENVELOPE_RESERVE_BYTES);
  });

  it("derives the browser contract from actual frame and durable capacities", () => {
    const limits = browserCommandLimits({
      frameMaximumBytes: 32 * 1_024,
      frameMaximumDepth: 20,
      outboundSingleMessageBytes: 40 * 1_024,
      replayLiveSingleEventBytes: 36 * 1_024,
      replayPageSingleEventBytes: 34 * 1_024,
    });

    expect(limits).toMatchObject({
      v: 1,
      maximumFrameBytes: 32 * 1_024,
      maximumDurablePayloadBytes: 30 * 1_024,
      maximumRawInputCodeUnits: 30 * 1_024,
      maximumRawInputUtf8Bytes: 30 * 1_024,
      maximumJsonDepth: 18,
    });
    expect(limits.maximumJsonNodes).toBeGreaterThan(1_000);
  });

  it("measures complete canonical UTF-8 JSON for every durable variable payload", () => {
    const title = 'quote " and emoji 💥';
    const text = "backslash \\ and newline\n";
    const value = { z: "💥", a: ['"', null, true] };

    expect(
      durableCommandPayloadBytes({
        v: 1,
        kind: "command",
        commandId: "cmd_titleBytes",
        method: "session.create",
        params: { title },
      }),
    ).toBe(canonicalJsonBytes(title).byteLength);
    expect(
      durableCommandPayloadBytes({
        v: 1,
        kind: "command",
        commandId: "cmd_messageBytes",
        sessionId: "ses_payloadBytes",
        method: "message.submit",
        params: { text },
      }),
    ).toBe(canonicalJsonBytes(text).byteLength);
    expect(
      durableCommandPayloadBytes({
        v: 1,
        kind: "command",
        commandId: "cmd_inputBytes",
        sessionId: "ses_payloadBytes",
        method: "input.respond",
        params: { inputId: "input_payloadBytes", value },
      }),
    ).toBe(canonicalJsonBytes(value).byteLength);
  });
});
