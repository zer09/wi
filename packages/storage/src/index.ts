export { CatalogClient } from "./catalog/client.js";
export type {
  CatalogClientOptions,
  CompleteGlobalCommandInput,
  ReconcileSessionInput,
  ReserveGlobalCommandInput,
} from "./catalog/client.js";
export type {
  CatalogProjectionUpdateResult,
  FailGlobalCommandInput,
  MarkSessionStatusInput,
  ReconcileSessionResult,
  SetGlobalCommandQuarantineInput,
} from "./catalog/repository.js";
export { StorageError } from "./common/worker-rpc.js";
export type {
  WorkerRequestOptions,
  WorkerRequestOutcome,
} from "./common/worker-rpc.js";
export { CatalogReconciler } from "./manager/catalog-reconciler.js";
export {
  resolveStoragePath,
  sessionDatabaseRelativePath,
  stableSessionWorkerIndex,
} from "./manager/paths.js";
export { SessionStoreManager } from "./manager/session-store-manager.js";
export type {
  CreateSessionStorageResult,
  DrainCatalogObservationsOptions,
  ManagedAcceptCommandResult,
  ManagedAppendResult,
  SessionStoreManagerOptions,
  StorageIdGenerators,
} from "./manager/session-store-manager.js";
export { SessionClient } from "./session/client.js";
export { SessionWorkerPool } from "./session/worker-pool.js";
export type {
  InitializeSessionInput,
  SessionSqlitePragmas,
  SessionWorkerPoolOptions,
  SessionWorkerStats,
} from "./session/worker-pool.js";
export {
  CATALOG_SCHEMA_VERSION,
  SESSION_FORMAT_VERSION,
  SESSION_SCHEMA_VERSION,
  SessionStatusSchema,
} from "./types.js";
export type {
  AcceptCommandInput,
  AcceptedCommandResult,
  AppendTransactionInput,
  AppendTransactionResult,
  GlobalCommandRecord,
  GlobalCommandReservation,
  NewSessionEvent,
  PendingApprovalRecord,
  PendingInputRecord,
  ProjectRecord,
  ProviderStepRecord,
  ProjectionMutation,
  RunMessageRecord,
  RunRecord,
  ToolExecutionRecord,
  SessionCatalogObservation,
  SessionCatalogProjection,
  SessionCreationRequest,
  SessionManifest,
  SessionRecoveryResult,
  SessionStatus,
  SessionSummary,
} from "./types.js";
