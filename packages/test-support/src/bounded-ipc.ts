import type { Serializable } from "node:child_process";
import { createHash, type Hash } from "node:crypto";

export interface ServerProcessMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export const PROCESS_IPC_PENDING_MAX_MESSAGES = 128;
export const PROCESS_IPC_HISTORY_MAX_MESSAGES = 256;
export const PROCESS_IPC_MESSAGE_MAX_ESTIMATED_BYTES = 64 * 1024;
export const PROCESS_IPC_PENDING_MAX_ESTIMATED_BYTES = 256 * 1024;
export const PROCESS_IPC_HISTORY_MAX_ESTIMATED_BYTES = 512 * 1024;
export const PROCESS_IPC_MESSAGE_MAX_DEPTH = 32;
export const PROCESS_IPC_MESSAGE_MAX_NODES = 4_096;
export const PROCESS_IPC_MESSAGE_MAX_STRING_CODE_UNITS = 16 * 1024;
export const PROCESS_IPC_MESSAGE_TYPE_MAX_CODE_UNITS = 128;
export const PROCESS_IPC_DIAGNOSTIC_PREVIEW_MAX_CODE_UNITS = 512;

const arrayIsArray = Array.isArray;
const plainObjectPrototype = Object.prototype;
const createObject = Object.create;
const defineObjectProperty = Object.defineProperty;
const getObjectOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getObjectPrototypeOf = Object.getPrototypeOf;
const setObjectPrototypeOf = Object.setPrototypeOf;
const isFiniteNumber = Number.isFinite;
const isSafeInteger = Number.isSafeInteger;
const stringifyJson = JSON.stringify;

export type ProcessIpcTruncationReason =
  | "estimated_bytes"
  | "depth"
  | "nodes"
  | "string"
  | "protocol";

export interface ProcessIpcTruncationDiagnostics {
  readonly originalType: string | null;
  readonly reason: ProcessIpcTruncationReason;
  readonly observedEstimatedBytes: number;
  readonly visitedNodes: number;
  readonly maximumDepth: number;
  readonly preview: string;
  readonly sha256: string;
  readonly hashComplete: boolean;
}

export interface ProcessIpcDiagnostics {
  readonly totalMessages: number;
  readonly rejectedMessages: number;
  readonly oversizedMessages: number;
  readonly pendingRetainedMessages: number;
  readonly historyRetainedMessages: number;
  readonly pendingRetainedEstimatedBytes: number;
  readonly historyRetainedEstimatedBytes: number;
  readonly pendingDroppedMessages: number;
  readonly historyDroppedMessages: number;
  readonly pendingTruncated: boolean;
  readonly historyTruncated: boolean;
  readonly latestTruncation: ProcessIpcTruncationDiagnostics | null;
}

interface Analysis {
  readonly accepted: boolean;
  readonly estimatedBytes: number;
  readonly visitedNodes: number;
  readonly maximumDepth: number;
  readonly preview: string;
  readonly sha256: string;
  readonly hashComplete: boolean;
  readonly reason: ProcessIpcTruncationReason | null;
}

interface AnalysisFrame {
  readonly value: unknown;
  readonly depth: number;
  readonly label: string;
}

interface RetainedMessage {
  readonly message: ServerProcessMessage;
  readonly estimatedBytes: number;
}

function updateHashString(hash: Hash, value: string): void {
  for (let offset = 0; offset < value.length; offset += 1_024) {
    hash.update(value.slice(offset, offset + 1_024), "utf8");
  }
}

function jsonEncodedStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code <= 0x1f || (code >= 0xd800 && code <= 0xdfff)) {
      const next = value.charCodeAt(index + 1);
      if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function analyzeIpcValue(value: unknown): Analysis {
  const hash = createHash("sha256");
  const stack: AnalysisFrame[] = [{ value, depth: 0, label: "$" }];
  let estimatedBytes = 0;
  let visitedNodes = 0;
  let maximumDepth = 0;
  let preview = "";
  let reason: Analysis["reason"] = null;
  let hashComplete = true;

  const appendPreview = (text: string): void => {
    if (preview.length >= PROCESS_IPC_DIAGNOSTIC_PREVIEW_MAX_CODE_UNITS) return;
    const separator = preview.length === 0 ? "" : " ";
    preview += `${separator}${text}`.slice(
      0,
      PROCESS_IPC_DIAGNOSTIC_PREVIEW_MAX_CODE_UNITS - preview.length,
    );
  };
  const addEstimatedBytes = (bytes: number): boolean => {
    estimatedBytes += bytes;
    if (estimatedBytes <= PROCESS_IPC_MESSAGE_MAX_ESTIMATED_BYTES) return true;
    reason = "estimated_bytes";
    hashComplete = false;
    return false;
  };

  while (stack.length > 0 && reason === null) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.depth > PROCESS_IPC_MESSAGE_MAX_DEPTH) {
      reason = "depth";
      hashComplete = false;
      break;
    }
    if (visitedNodes >= PROCESS_IPC_MESSAGE_MAX_NODES) {
      reason = "nodes";
      hashComplete = false;
      break;
    }
    visitedNodes += 1;
    maximumDepth = Math.max(maximumDepth, frame.depth);
    if (!addEstimatedBytes(16)) break;

    const current = frame.value;
    if (current === null) {
      hash.update("null;");
      appendPreview(`${frame.label}=null`);
      continue;
    }
    if (typeof current === "string") {
      hash.update("string:");
      updateHashString(hash, current);
      hash.update(";");
      estimatedBytes += jsonEncodedStringByteLength(current);
      appendPreview(
        `${frame.label}=${JSON.stringify(current.slice(0, 96))}${current.length > 96 ? "…" : ""}`,
      );
      if (current.length > PROCESS_IPC_MESSAGE_MAX_STRING_CODE_UNITS) {
        reason = "string";
        hashComplete = stack.length === 0;
      } else if (estimatedBytes > PROCESS_IPC_MESSAGE_MAX_ESTIMATED_BYTES) {
        reason = "estimated_bytes";
        hashComplete = stack.length === 0;
      }
      continue;
    }
    if (typeof current === "number") {
      const encoded = String(current);
      hash.update(`number:${encoded};`);
      appendPreview(`${frame.label}=${encoded}`);
      if (!isFiniteNumber(current)) {
        reason = "protocol";
        hashComplete = stack.length === 0;
        continue;
      }
      const jsonEncoded = stringifyJson(current);
      if (!addEstimatedBytes(jsonEncoded.length)) break;
      continue;
    }
    if (typeof current === "boolean") {
      const encoded = String(current);
      hash.update(`boolean:${encoded};`);
      appendPreview(`${frame.label}=${encoded}`);
      if (!addEstimatedBytes(encoded.length)) break;
      continue;
    }
    if (typeof current !== "object") {
      hash.update(`unsupported:${typeof current};`);
      reason = "protocol";
      hashComplete = false;
      continue;
    }

    if (arrayIsArray(current)) {
      hash.update(`array:${String(current.length)};`);
      appendPreview(`${frame.label}=<array:${String(current.length)}>`);
      if (current.length + visitedNodes > PROCESS_IPC_MESSAGE_MAX_NODES) {
        reason = "nodes";
        hashComplete = false;
        continue;
      }
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current[index], depth: frame.depth + 1, label: `${frame.label}[${String(index)}]` });
      }
      continue;
    }

    const prototype = getObjectPrototypeOf(current);
    if (prototype !== plainObjectPrototype && prototype !== null) {
      hash.update("unsupported:prototype;");
      reason = "protocol";
      hashComplete = false;
      continue;
    }

    const record = current as Readonly<Record<string, unknown>>;
    const keys: string[] = [];
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      if (keys.length + visitedNodes >= PROCESS_IPC_MESSAGE_MAX_NODES) {
        reason = "nodes";
        hashComplete = false;
        break;
      }
      keys.push(key);
    }
    if (reason !== null) continue;
    hash.update(`object:${String(keys.length)};`);
    appendPreview(`${frame.label}=<object:${String(keys.length)}>`);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) continue;
      hash.update("key:");
      updateHashString(hash, key);
      hash.update(";");
      if (key.length > PROCESS_IPC_MESSAGE_MAX_STRING_CODE_UNITS) {
        reason = "string";
        hashComplete = false;
        break;
      }
      estimatedBytes += jsonEncodedStringByteLength(key) + 8;
      if (estimatedBytes > PROCESS_IPC_MESSAGE_MAX_ESTIMATED_BYTES) {
        reason = "estimated_bytes";
        hashComplete = false;
        break;
      }
      stack.push({
        value: record[key],
        depth: frame.depth + 1,
        label: `${frame.label}.${key}`.slice(
          0,
          PROCESS_IPC_DIAGNOSTIC_PREVIEW_MAX_CODE_UNITS,
        ),
      });
    }
  }

  return {
    accepted: reason === null,
    estimatedBytes,
    visitedNodes,
    maximumDepth,
    preview,
    sha256: hash.digest("hex"),
    hashComplete,
    reason,
  };
}

function safeMessageType(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    descriptor.value.length === 0 ||
    descriptor.value.length > PROCESS_IPC_MESSAGE_TYPE_MAX_CODE_UNITS
  ) {
    return null;
  }
  return descriptor.value;
}

function truncationDiagnostics(
  value: unknown,
  analysis: Analysis,
): ProcessIpcTruncationDiagnostics {
  return {
    originalType: safeMessageType(value),
    reason: analysis.reason ?? "protocol",
    observedEstimatedBytes: analysis.estimatedBytes,
    visitedNodes: analysis.visitedNodes,
    maximumDepth: analysis.maximumDepth,
    preview: analysis.preview,
    sha256: analysis.sha256,
    hashComplete: analysis.hashComplete,
  };
}

function truncationMessage(
  diagnostics: ProcessIpcTruncationDiagnostics,
): RetainedMessage {
  const message: ServerProcessMessage = {
    type: "wi.test-support.ipc-truncated",
    ...diagnostics,
  };
  const analysis = analyzeIpcValue(message);
  return {
    message,
    estimatedBytes: analysis.accepted ? analysis.estimatedBytes : 2_048,
  };
}

type IpcSnapshot =
  | null
  | boolean
  | number
  | string
  | IpcSnapshot[]
  | { readonly [key: string]: IpcSnapshot };

interface IpcSnapshotState {
  estimatedBytes: number;
  nodes: number;
}

interface BoundedIpcSnapshot {
  readonly value: IpcSnapshot;
  readonly estimatedBytes: number;
}

function throwIpcLimit(reason: ProcessIpcTruncationReason): never {
  throw new Error(`Process IPC message exceeds the ${reason} limit`);
}

function addSnapshotBytes(state: IpcSnapshotState, bytes: number): void {
  state.estimatedBytes += bytes;
  if (state.estimatedBytes > PROCESS_IPC_MESSAGE_MAX_ESTIMATED_BYTES) {
    throwIpcLimit("estimated_bytes");
  }
}

function snapshotIpcValue(
  value: unknown,
  depth: number,
  state: IpcSnapshotState,
): IpcSnapshot {
  if (depth > PROCESS_IPC_MESSAGE_MAX_DEPTH) throwIpcLimit("depth");
  if (state.nodes >= PROCESS_IPC_MESSAGE_MAX_NODES) throwIpcLimit("nodes");
  state.nodes += 1;
  addSnapshotBytes(state, 16);

  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > PROCESS_IPC_MESSAGE_MAX_STRING_CODE_UNITS) throwIpcLimit("string");
    addSnapshotBytes(state, jsonEncodedStringByteLength(value));
    return value;
  }
  if (typeof value === "boolean") {
    addSnapshotBytes(state, value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    if (!isFiniteNumber(value)) throwIpcLimit("protocol");
    addSnapshotBytes(state, stringifyJson(value).length);
    return value;
  }
  if (typeof value !== "object") throwIpcLimit("protocol");

  if (arrayIsArray(value)) {
    const lengthDescriptor = getObjectOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      throwIpcLimit("protocol");
    }
    const length = lengthDescriptor.value;
    if (length + state.nodes > PROCESS_IPC_MESSAGE_MAX_NODES) throwIpcLimit("nodes");
    const snapshot: IpcSnapshot[] = [];
    setObjectPrototypeOf(snapshot, null);
    for (let index = 0; index < length; index += 1) {
      const descriptor = getObjectOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) throwIpcLimit("protocol");
      defineObjectProperty(snapshot, String(index), {
        value: snapshotIpcValue(descriptor.value, depth + 1, state),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return snapshot;
  }

  const prototype = getObjectPrototypeOf(value);
  if (prototype !== plainObjectPrototype && prototype !== null) throwIpcLimit("protocol");
  const snapshot = createObject(null) as Record<string, IpcSnapshot>;
  for (const key in value) {
    const descriptor = getObjectOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) continue;
    if (!("value" in descriptor)) throwIpcLimit("protocol");
    if (key.length > PROCESS_IPC_MESSAGE_MAX_STRING_CODE_UNITS) throwIpcLimit("string");
    addSnapshotBytes(state, jsonEncodedStringByteLength(key) + 8);
    defineObjectProperty(snapshot, key, {
      value: snapshotIpcValue(descriptor.value, depth + 1, state),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return snapshot;
}

function createBoundedIpcSnapshot(value: unknown): BoundedIpcSnapshot {
  const state: IpcSnapshotState = { estimatedBytes: 0, nodes: 0 };
  return {
    value: snapshotIpcValue(value, 0, state),
    estimatedBytes: state.estimatedBytes,
  };
}

function cloneRetainedMessage(message: ServerProcessMessage): ServerProcessMessage {
  return createBoundedIpcSnapshot(message).value as ServerProcessMessage;
}

export function snapshotBoundedIpcValue(value: unknown): Serializable {
  return createBoundedIpcSnapshot(value).value as Serializable;
}

export class BoundedIpcRetention {
  readonly #pending: RetainedMessage[] = [];
  readonly #history: RetainedMessage[] = [];
  #totalMessages = 0;
  #rejectedMessages = 0;
  #oversizedMessages = 0;
  #pendingEstimatedBytes = 0;
  #historyEstimatedBytes = 0;
  #pendingDroppedMessages = 0;
  #historyDroppedMessages = 0;
  #pendingTruncated = false;
  #historyTruncated = false;
  #latestTruncation: ProcessIpcTruncationDiagnostics | null = null;

  constructor(
    private readonly pendingMaximumMessages: number,
    private readonly historyMaximumMessages: number,
    private readonly isAwaited: (type: string) => boolean,
  ) {}

  accept(value: unknown): void {
    this.#totalMessages += 1;
    const analysis = analyzeIpcValue(value);
    const type = safeMessageType(value);
    if (!analysis.accepted || type === null) {
      const diagnostics = truncationDiagnostics(value, analysis);
      this.#latestTruncation = diagnostics;
      this.#rejectedMessages += 1;
      if (diagnostics.reason !== "protocol") this.#oversizedMessages += 1;
      this.#pendingDroppedMessages += 1;
      this.#pendingTruncated = true;
      this.#historyTruncated = true;
      this.addHistory(truncationMessage(diagnostics));
      return;
    }

    // Retention owns one bounded representation. The callback value and every
    // later outward read must stay detached from this accounting boundary.
    const boundedSnapshot = createBoundedIpcSnapshot(value);
    const message = boundedSnapshot.value as ServerProcessMessage;
    const retained: RetainedMessage = {
      message,
      estimatedBytes: boundedSnapshot.estimatedBytes,
    };
    this.#pending.push(retained);
    this.#pendingEstimatedBytes += retained.estimatedBytes;
    while (
      this.#pending.length > this.pendingMaximumMessages ||
      this.#pendingEstimatedBytes > PROCESS_IPC_PENDING_MAX_ESTIMATED_BYTES
    ) {
      const unawaitedIndex = this.#pending.findIndex(
        ({ message }) => !this.isAwaited(message.type),
      );
      const index = unawaitedIndex >= 0 ? unawaitedIndex : 0;
      const [removed] = this.#pending.splice(index, 1);
      if (removed === undefined) break;
      this.#pendingEstimatedBytes -= removed.estimatedBytes;
      this.#pendingDroppedMessages += 1;
      this.#pendingTruncated = true;
    }
    this.addHistory(retained);
  }

  private addHistory(retained: RetainedMessage): void {
    this.#history.push(retained);
    this.#historyEstimatedBytes += retained.estimatedBytes;
    while (
      this.#history.length > this.historyMaximumMessages ||
      this.#historyEstimatedBytes > PROCESS_IPC_HISTORY_MAX_ESTIMATED_BYTES
    ) {
      const removed = this.#history.shift();
      if (removed === undefined) break;
      this.#historyEstimatedBytes -= removed.estimatedBytes;
      this.#historyDroppedMessages += 1;
      this.#historyTruncated = true;
    }
  }

  take(type: string): ServerProcessMessage | null {
    const index = this.#pending.findIndex(({ message }) => message.type === type);
    if (index < 0) return null;
    const [removed] = this.#pending.splice(index, 1);
    if (removed === undefined) return null;
    this.#pendingEstimatedBytes -= removed.estimatedBytes;
    return cloneRetainedMessage(removed.message);
  }

  get history(): readonly ServerProcessMessage[] {
    return this.#history.map(({ message }) => cloneRetainedMessage(message));
  }

  snapshot(): ProcessIpcDiagnostics {
    return {
      totalMessages: this.#totalMessages,
      rejectedMessages: this.#rejectedMessages,
      oversizedMessages: this.#oversizedMessages,
      pendingRetainedMessages: this.#pending.length,
      historyRetainedMessages: this.#history.length,
      pendingRetainedEstimatedBytes: this.#pendingEstimatedBytes,
      historyRetainedEstimatedBytes: this.#historyEstimatedBytes,
      pendingDroppedMessages: this.#pendingDroppedMessages,
      historyDroppedMessages: this.#historyDroppedMessages,
      pendingTruncated: this.#pendingTruncated,
      historyTruncated: this.#historyTruncated,
      latestTruncation:
        this.#latestTruncation === null ? null : { ...this.#latestTruncation },
    };
  }
}
