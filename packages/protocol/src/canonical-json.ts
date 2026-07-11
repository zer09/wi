import { z } from "zod";

export type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export const CanonicalJsonValueSchema: z.ZodType<CanonicalJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(CanonicalJsonValueSchema),
    z.record(z.string(), CanonicalJsonValueSchema),
  ]),
);

interface SubtleDigest {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

function canonicalize(value: unknown, active: WeakSet<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }

  if (typeof value !== "object") {
    throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
  }

  if (active.has(value)) throw new TypeError("Canonical JSON cannot contain cycles");
  active.add(value);

  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      const expectedKeys = new Set([...value.keys()].map(String));
      expectedKeys.add("length");
      if (keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
        throw new TypeError("Canonical JSON arrays cannot contain extra properties");
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError("Canonical JSON arrays cannot be sparse");
      }
      return `[${value.map((item) => canonicalize(item, active)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON objects must be plain objects");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError("Canonical JSON objects cannot have symbol keys");
    }

    const entries = (keys as string[]).sort().map((key) => {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError("Canonical JSON object properties must be enumerable data properties");
      }
      return `${JSON.stringify(key)}:${canonicalize(descriptor.value, active)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, new WeakSet());
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function defaultSubtleDigest(): SubtleDigest {
  const crypto = (globalThis as { crypto?: { subtle?: SubtleDigest } }).crypto;
  if (crypto?.subtle === undefined) {
    throw new Error("Web Crypto SHA-256 is unavailable");
  }
  return crypto.subtle;
}

export async function canonicalJsonHash(
  value: unknown,
  subtle: SubtleDigest = defaultSubtleDigest(),
): Promise<string> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", canonicalJsonBytes(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
