import type { ConnectionSnapshot } from "../socket/client.js";

export function ConnectionStatus({ connection }: { readonly connection: ConnectionSnapshot }) {
  const label = connection.status === "connected" ? "Connected" : connection.status;
  return (
    <div className={`connection connection--${connection.status}`} role="status" aria-live="polite">
      <span className="connection__dot" aria-hidden="true" />
      <span>{label}</span>
      {connection.reconnectDelayMs === null ? null : (
        <span> in {connection.reconnectDelayMs} ms</span>
      )}
      {connection.detail === null ? null : <span className="connection__detail"> — {connection.detail}</span>}
    </div>
  );
}
