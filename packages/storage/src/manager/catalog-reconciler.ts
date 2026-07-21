import type { CatalogClient, ReconcileSessionInput } from "../catalog/client.js";
import { StorageError } from "../common/worker-rpc.js";
import type { SessionWorkerPool } from "../session/worker-pool.js";
import type { SessionSummary } from "../types.js";
import { resolveStoragePath, sessionDatabaseRelativePath } from "./paths.js";

export class CatalogReconciler {
  readonly #homeDirectory: string;
  readonly #catalog: CatalogClient;
  readonly #sessions: SessionWorkerPool;

  constructor(
    homeDirectory: string,
    catalog: CatalogClient,
    sessions: SessionWorkerPool,
  ) {
    this.#homeDirectory = homeDirectory;
    this.#catalog = catalog;
    this.#sessions = sessions;
  }

  async inspectSession(sessionId: string): Promise<ReconcileSessionInput> {
    const expectedCatalog = await this.#catalog.getSession(sessionId);
    if (expectedCatalog?.status === "missing") {
      throw new StorageError("storage.session_missing", "Session database is missing");
    }
    if (expectedCatalog !== null && expectedCatalog.status !== "ready") {
      throw new StorageError("storage.corrupt", "Session is unavailable");
    }
    const relativePath = sessionDatabaseRelativePath(sessionId);
    const session = this.#sessions.registerSession(
      sessionId,
      resolveStoragePath(this.#homeDirectory, relativePath),
    );
    const [manifest, projection, pendingApprovals, pendingInputCount, nonterminalRuns] =
      await Promise.all([
        session.getManifest(),
        session.getCatalogProjection(),
        session.getPendingApprovals(),
        session.getPendingInputCount(),
        session.getNonterminalRuns(),
      ]);
    const currentCatalog = await this.#catalog.getSession(sessionId);
    if (currentCatalog?.status === "missing") {
      await session.close().catch(() => undefined);
      throw new StorageError("storage.session_missing", "Session database is missing");
    }
    if (currentCatalog !== null && currentCatalog.status !== "ready") {
      await session.close().catch(() => undefined);
      throw new StorageError("storage.corrupt", "Session is unavailable");
    }
    if (currentCatalog?.status !== expectedCatalog?.status) {
      await session.close().catch(() => undefined);
      throw new StorageError(
        "storage.busy",
        "Catalog status changed during session inspection",
        true,
      );
    }
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
      recoveryNeeded: nonterminalRuns.length > 0,
    };
  }

  async reconcileInspection(initialInspection: ReconcileSessionInput): Promise<SessionSummary> {
    let inspection = initialInspection;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const summary = await this.#catalog.reconcileSession(inspection);
      if (summary.status !== "ready") {
        await this.#sessions.closeSession(inspection.manifest.sessionId).catch(() => undefined);
        if (summary.status === "missing") {
          throw new StorageError("storage.session_missing", "Session database is missing");
        }
        throw new StorageError("storage.corrupt", "Session is unavailable");
      }
      if (summary.lastEventSequence >= inspection.manifest.lastEventSequence) return summary;
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
