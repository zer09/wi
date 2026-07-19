import {
  MAXIMUM_BOOTSTRAP_SESSIONS,
  SessionIdSchema,
  type BrowserSessionSummary,
} from "@wi/protocol";
import type { BrowserSessionState } from "@wi/client-state";

export interface BrowserSessionIndex {
  readonly summaries: readonly BrowserSessionSummary[];
  readonly truncated: boolean;
}

function compareSummaries(left: BrowserSessionSummary, right: BrowserSessionSummary): number {
  if (left.updatedAtMs !== right.updatedAtMs) return right.updatedAtMs - left.updatedAtMs;
  if (left.sessionId < right.sessionId) return -1;
  if (left.sessionId > right.sessionId) return 1;
  return 0;
}

function boundedSummaries(
  summaries: readonly BrowserSessionSummary[],
  selectedSessionId: string | null,
): readonly BrowserSessionSummary[] {
  const sorted = [...summaries].sort(compareSummaries);
  if (sorted.length <= MAXIMUM_BOOTSTRAP_SESSIONS) return sorted;

  const selected =
    selectedSessionId === null
      ? undefined
      : sorted.find((summary) => summary.sessionId === selectedSessionId);
  const bounded = sorted.slice(0, MAXIMUM_BOOTSTRAP_SESSIONS);
  if (selected === undefined || bounded.some((summary) => summary.sessionId === selected.sessionId)) {
    return bounded;
  }

  const evictionIndex = bounded.findLastIndex(
    (summary) => summary.sessionId !== selectedSessionId,
  );
  if (evictionIndex < 0) return bounded;
  bounded.splice(evictionIndex, 1, selected);
  return bounded.sort(compareSummaries);
}

export function createBrowserSessionIndex(
  summaries: readonly BrowserSessionSummary[],
  truncated: boolean,
): BrowserSessionIndex {
  return {
    summaries: boundedSummaries(summaries, null),
    truncated: truncated || summaries.length > MAXIMUM_BOOTSTRAP_SESSIONS,
  };
}

export function initialSessionIdFromLocation(
  locationHref: string,
  summaries: readonly BrowserSessionSummary[],
): string | null {
  const candidate = new URL(locationHref).searchParams.get("session");
  if (candidate !== null && SessionIdSchema.safeParse(candidate).success) return candidate;
  return summaries.find((summary) => summary.status === "ready")?.sessionId ?? null;
}

export function projectSessionSummary(
  previous: BrowserSessionSummary | undefined,
  state: BrowserSessionState,
  durableEventTimestampMs?: number,
): BrowserSessionSummary | null {
  if (previous === undefined && durableEventTimestampMs === undefined) return null;
  const updatedAtMs = Math.max(previous?.updatedAtMs ?? 0, durableEventTimestampMs ?? 0);
  return {
    sessionId: state.sessionId,
    title: state.title || previous?.title || "Untitled session",
    status: previous?.status ?? "ready",
    createdAtMs: previous?.createdAtMs ?? durableEventTimestampMs ?? 0,
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

export function upsertSessionSummary(
  index: BrowserSessionIndex,
  summary: BrowserSessionSummary,
  selectedSessionId: string | null,
  catalogGrew = false,
): BrowserSessionIndex {
  const existed = index.summaries.some((candidate) => candidate.sessionId === summary.sessionId);
  const next = [
    summary,
    ...index.summaries.filter((candidate) => candidate.sessionId !== summary.sessionId),
  ];
  return {
    summaries: boundedSummaries(next, selectedSessionId),
    truncated:
      index.truncated ||
      next.length > MAXIMUM_BOOTSTRAP_SESSIONS ||
      (catalogGrew && !existed && index.summaries.length >= MAXIMUM_BOOTSTRAP_SESSIONS),
  };
}
