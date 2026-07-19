import type { BrowserApproval } from "@wi/client-state";
import type { ApprovalResolution } from "@wi/protocol";

interface ApprovalPanelProps {
  readonly approvals: readonly BrowserApproval[];
  readonly pendingApprovalIds: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onResolve: (approvalId: string, resolution: ApprovalResolution) => void;
}

export function ApprovalPanel({
  approvals,
  pendingApprovalIds,
  disabled,
  onResolve,
}: ApprovalPanelProps) {
  if (approvals.length === 0) return null;
  return (
    <section className="interaction-panel" aria-labelledby="approval-heading" role="alert">
      <h2 id="approval-heading">Approval required</h2>
      {approvals.map((approval) => {
        const pending = pendingApprovalIds.has(approval.approvalId);
        return (
          <article
            key={approval.approvalId}
            data-testid="approval-panel"
            data-approval-id={approval.approvalId}
          >
            <h3>{approval.toolName}</h3>
            <p>{approval.summary}</p>
            <div className="interaction-panel__actions">
              <button
                type="button"
                data-focus-target="approval"
                disabled={disabled || pending}
                onClick={() => onResolve(approval.approvalId, "approved")}
              >
                Approve
              </button>
              <button
                type="button"
                className="button--danger"
                data-focus-target="approval"
                disabled={disabled || pending}
                onClick={() => onResolve(approval.approvalId, "denied")}
              >
                Deny
              </button>
              {pending ? <span role="status">Resolution pending…</span> : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}
