import { SessionEventSchema, type SessionEvent } from "@wi/protocol";

export const COMPLETE_EVENT_MUTATIONS = [
  "eventId",
  "eventType",
  "createdAtMs",
  "data",
] as const;

export type CompleteEventMutation = (typeof COMPLETE_EVENT_MUTATIONS)[number];

export function generatedReplayEvent(
  sessionId: string,
  sequence: number,
  variant: number,
): SessionEvent {
  const family = Math.abs(variant) % 5;
  const envelope = {
    v: 1 as const,
    kind: "event" as const,
    sessionId,
    sequence,
    eventId: `evt_replay${sequence}`,
    createdAtMs: 10_000 + sequence * 10 + family,
  };

  switch (family) {
    case 0:
      return SessionEventSchema.parse({
        ...envelope,
        eventType: "session.created",
        data: { eventVersion: 1, title: `Session ${sequence}` },
      });
    case 1:
      return SessionEventSchema.parse({
        ...envelope,
        eventType: "user.message.appended",
        data: {
          eventVersion: 1,
          messageId: `msg_replay${sequence}`,
          runId: `run_replay${sequence}`,
          text: `Message ${sequence}`,
        },
      });
    case 2:
      return SessionEventSchema.parse({
        ...envelope,
        eventType: "provider.text.delta",
        data: {
          eventVersion: 1,
          runId: `run_replay${sequence}`,
          stepId: `step_replay${sequence}`,
          messageId: `msg_replay${sequence}`,
          partId: `part_replay${sequence}`,
          text: `Delta ${sequence}`,
        },
      });
    case 3:
      return SessionEventSchema.parse({
        ...envelope,
        eventType: "tool.execution.completed",
        data: {
          eventVersion: 1,
          runId: `run_replay${sequence}`,
          callId: `call_replay${sequence}`,
          result: { sequence, values: [family, true] },
        },
      });
    case 4:
      return SessionEventSchema.parse({
        ...envelope,
        eventType: "input.requested",
        data: {
          eventVersion: 1,
          runId: `run_replay${sequence}`,
          inputId: `input_replay${sequence}`,
          prompt: `Input ${sequence}?`,
        },
      });
    default:
      throw new Error("Replay event family must be between zero and four");
  }
}

export function mutateCompleteEvent(
  event: SessionEvent,
  mutation: CompleteEventMutation,
): SessionEvent {
  switch (mutation) {
    case "eventId":
      return { ...event, eventId: `${event.eventId}_changed` };
    case "eventType":
      return {
        ...event,
        eventType: event.eventType === "run.started" ? "run.completed" : "run.started",
      } as SessionEvent;
    case "createdAtMs":
      return { ...event, createdAtMs: event.createdAtMs + 1 };
    case "data":
      return {
        ...event,
        data: { ...event.data, mutationMarker: true },
      } as unknown as SessionEvent;
  }
}
