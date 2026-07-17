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
export {
  SessionStoreManager,
  validateSessionStoreManagerOptions,
} from "./manager/session-store-manager.js";
export type {
  CatalogObservationFailure,
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
  SessionWorkerBarrier,
  SessionWorkerPoolOptions,
  SessionWorkerStats,
} from "./session/worker-pool.js";
export {
  CATALOG_SCHEMA_VERSION,
  SESSION_EVENT_PAGE_BOUNDS,
  SESSION_FORMAT_VERSION,
  SESSION_SCHEMA_VERSION,
  SessionEventPageInputSchema,
  SessionEventPageSchema,
  SessionStatusSchema,
} from "./types.js";
export type {
  AcceptCommandInput,
  AcceptedCommandResult,
  AppendTransactionInput,
  AppendTransactionInspection,
  AppendTransactionResult,
  BoundedProviderRequestData,
  BoundedProviderRequestDataInput,
  GlobalCommandRecord,
  GlobalCommandReservation,
  InputRecord,
  NewSessionEvent,
  PendingApprovalRecord,
  PendingInputRecord,
  ProjectRecord,
  ProviderStepRecord,
  ProjectionMutation,
  RunMessageRecord,
  RunProviderMatch,
  RunRecord,
  ToolExecutionRecord,
  SessionCatalogObservation,
  SessionCatalogProjection,
  SessionCreationRequest,
  SessionEventPage,
  SessionEventPageInput,
  SessionManifest,
  SessionRecoveryResult,
  SessionStatus,
  SessionSummary,
} from "./types.js";
