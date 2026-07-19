import type { BrowserSessionState } from "@wi/client-state";

import { projectTimeline } from "../state/timeline.js";

const MAXIMUM_VISIBLE_TIMELINE_ITEMS = 200;
const MAXIMUM_VISIBLE_ITEM_CHARACTERS = 64 * 1_024;

function visibleText(text: string): string {
  if (text.length <= MAXIMUM_VISIBLE_ITEM_CHARACTERS) return text;
  return `${text.slice(0, MAXIMUM_VISIBLE_ITEM_CHARACTERS)}\n\n[Display truncated]`;
}

export function Timeline({ session }: { readonly session: BrowserSessionState }) {
  const projected = projectTimeline(session.timeline);
  const hiddenCount = Math.max(0, projected.length - MAXIMUM_VISIBLE_TIMELINE_ITEMS);
  const visible = projected.slice(hiddenCount);

  return (
    <section
      className="timeline"
      aria-label="Session timeline"
      data-testid="timeline"
      data-last-sequence={session.lastAppliedSequence}
    >
      {hiddenCount > 0 ? (
        <p className="timeline__truncated">{hiddenCount} earlier items are not mounted.</p>
      ) : null}
      {visible.length === 0 ? <p className="empty">Messages will appear here.</p> : null}
      <ol>
        {visible.map((item) => (
          <li
            key={item.id}
            className={`timeline-item timeline-item--${item.kind} timeline-item--${item.state}`}
            data-testid={`timeline-${item.kind}`}
            data-sequence={item.sequence}
          >
            <header>
              <strong>{item.label}</strong>
              {item.state === "interrupted" ? (
                <span className="timeline-item__state">Interrupted partial output</span>
              ) : item.state === "streaming" ? (
                <span className="timeline-item__state">Streaming</span>
              ) : null}
            </header>
            <pre>{visibleText(item.text)}</pre>
          </li>
        ))}
      </ol>
    </section>
  );
}
