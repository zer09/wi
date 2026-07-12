import type { CatalogClient, ReconcileSessionInput } from "../catalog/client.js";
import { StorageError } from "../common/worker-rpc.js";
import type { SessionWorkerPool } from "../session/worker-pool.js";
import type { SessionSummary } from "../types.js";
import { resolveStoragePath, sessionDatabaseRelativePath } from "./paths.js";

export class CatalogReconciler {
  constructor(
    private readonly homeDirectory: string,
    private readonly catalog: CatalogClient,
    private readonly sessions: SessionWorkerPool,
  ) {}

  async inspectSession(sessionId: string): Promise<ReconcileSessionInput> {
    const expectedCatalog = await this.catalog.getSession(sessionId);
    const relativePath = sessionDatabaseRelativePath(sessionId);
    const session = this.sessions.registerSession(
      sessionId,
      resolveStoragePath(this.homeDirectory, relativePath),
    );
    const [manifest, projection, pendingApprovals, pendingInputCount] = await Promise.all([
      session.getManifest(),
      session.getCatalogProjection(),
      session.getPendingApprovals(),
      session.getPendingInputCount(),
    ]);
    return {
      manifest,
      dbRelativePath: relativePath,
      expectedCatalogSequence: expectedCatalog?.lastEventSequence ?? null,
      expectedCatalogStatus: expectedCatalog?.status ?? null,
      updatedAtMs: projection.updatedAtMs,
      lastRunState: projection.lastRunState,
      lastMessagePreview: projection.lastMessagePreview,
      pendingApprovalCount: pendingApprovals.length,
      pendingInputCount,
    };
  }

  async reconcileInspection(initialInspection: ReconcileSessionInput): Promise<SessionSummary> {
    let inspection = initialInspection;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const summary = await this.catalog.reconcileSession(inspection);
      if (
        summary.status !== "ready" ||
        summary.lastEventSequence >= inspection.manifest.lastEventSequence
      ) {
        return summary;
      }
      inspection = await this.inspectSession(inspection.manifest.sessionId);
    }
    throw new StorageError(
      "storage.busy",
      `Catalog reconciliation for ${initialInspection.manifest.sessionId} kept losing its compare-and-swap`,
      true,
    );
  }

  async reconcileSession(sessionId: string): Promise<SessionSummary> {
    return this.reconcileInspection(await this.inspectSession(sessionId));
  }
}
