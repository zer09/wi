import type { SessionEvent } from "@wi/protocol";

export interface TimelineEntry {
  readonly id: string;
  readonly kind: "assistant" | "status" | "tool" | "user";
  readonly label: string;
  readonly text: string;
  readonly state: "complete" | "interrupted" | "streaming";
  readonly sequence: number;
}

interface MutableAssistantEntry {
  id: string;
  kind: "assistant";
  label: string;
  text: string;
  state: "complete" | "interrupted" | "streaming";
  sequence: number;
  readonly messageId: string;
  readonly stepId: string;
}

export function projectTimeline(events: readonly SessionEvent[]): readonly TimelineEntry[] {
  const entries: Array<TimelineEntry | MutableAssistantEntry> = [];
  const assistantsByPart = new Map<string, MutableAssistantEntry>();
  const assistantsByMessage = new Map<string, MutableAssistantEntry>();

  for (const event of events) {
    switch (event.eventType) {
      case "user.message.appended":
        entries.push({
          id: event.eventId,
          kind: "user",
          label: "You",
          text: event.data.text,
          state: "complete",
          sequence: event.sequence,
        });
        break;
      case "provider.text.delta": {
        let assistant = assistantsByPart.get(event.data.partId);
        if (assistant === undefined) {
          assistant = {
            id: event.data.partId,
            kind: "assistant",
            label: "Assistant",
            text: "",
            state: "streaming",
            sequence: event.sequence,
            messageId: event.data.messageId,
            stepId: event.data.stepId,
          };
          assistantsByPart.set(event.data.partId, assistant);
          assistantsByMessage.set(event.data.messageId, assistant);
          entries.push(assistant);
        }
        assistant.text += event.data.text;
        assistant.sequence = event.sequence;
        break;
      }
      case "assistant.message.completed": {
        const assistant = assistantsByMessage.get(event.data.messageId);
        if (assistant !== undefined) assistant.state = "complete";
        break;
      }
      case "provider.step.failed":
      case "provider.step.interrupted":
        for (const assistant of assistantsByPart.values()) {
          if (assistant.stepId === event.data.stepId) assistant.state = "interrupted";
        }
        break;
      case "tool.approval.requested":
        entries.push({
          id: event.eventId,
          kind: "tool",
          label: `Approval required: ${event.data.toolName}`,
          text: event.data.summary,
          state: "complete",
          sequence: event.sequence,
        });
        break;
      case "tool.execution.completed":
        entries.push({
          id: event.eventId,
          kind: "tool",
          label: "Tool completed",
          text: JSON.stringify(event.data.result, null, 2),
          state: "complete",
          sequence: event.sequence,
        });
        break;
      case "tool.execution.failed":
      case "tool.execution.outcome_unknown":
        entries.push({
          id: event.eventId,
          kind: "tool",
          label: "Tool failed",
          text: event.data.message,
          state: "interrupted",
          sequence: event.sequence,
        });
        break;
      case "run.failed":
      case "run.interrupted":
        entries.push({
          id: event.eventId,
          kind: "status",
          label: event.eventType === "run.failed" ? "Run failed" : "Run interrupted",
          text: event.data.message,
          state: "interrupted",
          sequence: event.sequence,
        });
        break;
      case "run.cancelled":
        entries.push({
          id: event.eventId,
          kind: "status",
          label: "Run cancelled",
          text: "The run was cancelled.",
          state: "complete",
          sequence: event.sequence,
        });
        break;
      default:
        break;
    }
  }

  return entries.map(({ id, kind, label, text, state, sequence }) => ({
    id,
    kind,
    label,
    text,
    state,
    sequence,
  }));
}
