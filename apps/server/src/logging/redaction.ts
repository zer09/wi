import { createHash } from "node:crypto";
import { ErrorCodeSchema } from "@wi/protocol";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const MAX_LOG_DEPTH = 6;
const MAX_LOG_ENTRIES = 40;
const MAX_LOG_STRING_LENGTH = 1_024;
const MAX_LOG_INPUT_CODE_UNITS = 4_096;
const MAX_LOG_KEY_CODE_UNITS = 256;
const MAX_FINGERPRINT_SAMPLE_BYTES = 4_096;

function normalizedKey(key: string): string {
  return key
    .slice(0, MAX_LOG_KEY_CODE_UNITS)
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  const sensitiveConcepts = [
    "password",
    "passwd",
    "passphrase",
    "authorization",
    "authentication",
    "oauthcode",
    "codeverifier",
    "apikey",
    "token",
    "secret",
    "credential",
    "cookie",
  ];
  if (sensitiveConcepts.some((concept) => normalized.includes(concept))) return true;
  const words = key
    .slice(0, MAX_LOG_KEY_CODE_UNITS)
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u);
  return words.includes("pwd");
}

function isRawQueryKey(key: string): boolean {
  return new Set(["query", "rawquery", "querystring", "search", "searchparams"]).has(
    normalizedKey(key),
  );
}

function isUrlKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized.endsWith("url") || normalized.endsWith("uri");
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value, "http://localhost");
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return value.startsWith("/") ? parsed.pathname : parsed.toString();
  } catch {
    return value.split(/[?#]/u, 1)[0] ?? "";
  }
}

function boundedLogText(
  value: string,
  transform: (sample: string) => string,
): string {
  const sample = value.slice(0, MAX_LOG_INPUT_CODE_UNITS);
  const safe = transform(sample);
  if (value.length <= MAX_LOG_INPUT_CODE_UNITS && safe.length <= MAX_LOG_STRING_LENGTH) {
    return safe;
  }
  return `${safe.slice(0, MAX_LOG_STRING_LENGTH)}${TRUNCATED}`;
}

function scrubSensitiveText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s"',;}]+/giu, "$1 [REDACTED]")
    .replace(
      /((?:set[-_ ]?cookie|cookie)\s*["']?\s*:\s*["']?)[^\r\n"'}]*/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b(wi_browser_session\s*=\s*)[^\s;,&"'}]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:access[-_ ]?token|refresh[-_ ]?token|token|oauth[-_ ]?code|code|x[-_ ]?api[-_ ]?key|api[-_ ]?key|client[-_ ]?secret|password|passwd|credential)=)[^&#\s"'}]*/giu,
      "$1[REDACTED]",
    )
    .replace(
      /((?:proxy[-_ ]?authorization|authorization|x[-_ ]?api[-_ ]?key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|oauth[-_ ]?(?:token|code)|client[-_ ]?secret|password|passwd|credential)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu,
      "$1[REDACTED]",
    );
}

type TextFingerprint =
  | {
      readonly sourceUnit: "utf16_code_units";
      readonly sourceLength: number;
      readonly sampledByteLength: number;
      readonly sampledSha256: string;
      readonly truncated: boolean;
    }
  | {
      readonly sourceUnit: "bytes";
      readonly sourceLength: number;
      readonly sampledByteLength: number;
      readonly sampledSha256: string;
      readonly truncated: boolean;
    };

function textFingerprint(value: string | Uint8Array): TextFingerprint {
  const sourceUnit = typeof value === "string" ? "utf16_code_units" : "bytes";
  const sourceLength = value.length;
  const sample =
    typeof value === "string"
      ? Buffer.from(value.slice(0, MAX_LOG_INPUT_CODE_UNITS), "utf8").subarray(
          0,
          MAX_FINGERPRINT_SAMPLE_BYTES,
        )
      : value.subarray(0, MAX_FINGERPRINT_SAMPLE_BYTES);
  return {
    sourceUnit,
    sourceLength,
    sampledByteLength: sample.byteLength,
    sampledSha256: createHash("sha256").update(sample).digest("hex"),
    truncated:
      typeof value === "string"
        ? value.length > MAX_LOG_INPUT_CODE_UNITS ||
          Buffer.byteLength(value.slice(0, MAX_LOG_INPUT_CODE_UNITS), "utf8") >
            MAX_FINGERPRINT_SAMPLE_BYTES
        : value.byteLength > sample.byteLength,
  };
}

function redact(
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (isSensitiveKey(key) || isRawQueryKey(key)) return REDACTED;
  if (typeof value === "string") {
    return boundedLogText(value, isUrlKey(key) ? redactUrl : scrubSensitiveText);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value === "bigint") return "[BIGINT]";
  if (typeof value !== "object") return `[${typeof value}]`;
  if (depth >= MAX_LOG_DEPTH) return TRUNCATED;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    const output = value
      .slice(0, MAX_LOG_ENTRIES)
      .map((entry) => redact(entry, "", depth + 1, seen));
    if (value.length > MAX_LOG_ENTRIES) output.push(TRUNCATED);
    return output;
  }

  const output: Record<string, unknown> = {};
  let entryCount = 0;
  for (const entryKey in value) {
    if (!Object.hasOwn(value, entryKey)) continue;
    if (entryCount >= MAX_LOG_ENTRIES) {
      output.truncated = true;
      break;
    }
    const outputKey =
      entryKey.length <= MAX_LOG_KEY_CODE_UNITS
        ? entryKey
        : `${entryKey.slice(0, MAX_LOG_KEY_CODE_UNITS)}${TRUNCATED}`;
    let entryValue: unknown;
    try {
      entryValue = (value as Record<string, unknown>)[entryKey];
    } catch {
      entryValue = "[UNREADABLE]";
    }
    output[outputKey] = redact(entryValue, entryKey, depth + 1, seen);
    entryCount += 1;
  }
  return output;
}

export function redactLogFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return redact(fields, "", 0, new WeakSet<object>()) as Record<string, unknown>;
}

export function malformedPayloadMetadata(value: string | Uint8Array): TextFingerprint {
  return textFingerprint(value);
}

function errorDetails(
  error: unknown,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  if (depth >= MAX_LOG_DEPTH) return { value: TRUNCATED };
  if (error instanceof Error) {
    if (seen.has(error)) return { value: "[CIRCULAR]" };
    seen.add(error);
    const details: Record<string, unknown> = {
      type: "error",
      message: textFingerprint(error.message),
    };
    if ("code" in error) {
      const code = (error as Error & { readonly code?: unknown }).code;
      if (typeof code === "string") {
        const stableCode =
          code.length <= MAX_LOG_KEY_CODE_UNITS
            ? ErrorCodeSchema.safeParse(code)
            : { success: false as const };
        details.code = stableCode.success ? stableCode.data : textFingerprint(code);
      } else {
        details.code = typeof code;
      }
    }
    if ("retryable" in error) {
      const retryable = (error as Error & { readonly retryable?: unknown }).retryable;
      details.retryable = typeof retryable === "boolean" ? retryable : undefined;
    }
    if (error.cause !== undefined) details.cause = errorDetails(error.cause, seen, depth + 1);
    return details;
  }
  if (typeof error === "string") {
    return { type: "string", value: textFingerprint(error) };
  }
  if (error === null || typeof error !== "object") {
    return { type: typeof error };
  }
  return { type: Array.isArray(error) ? "array" : "object" };
}

export function safeErrorDetails(error: unknown): Record<string, unknown> {
  return redactLogFields(errorDetails(error, new WeakSet<object>(), 0));
}
