import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  isValidSessionPrefix,
  sessionDatabaseRelativePath,
  sessionPrefixFromId,
} from "@wi/storage";

const seed = Number.parseInt(process.env.WI_FC_SEED ?? "737373", 10);
const path = process.env.WI_FC_PATH;
const options = { numRuns: 1_000, seed, ...(path === undefined ? {} : { path }) } as const;

const firstSuffixCharacter = fc.constantFrom(
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
);
const laterSuffixCharacter = fc.constantFrom(
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-",
);
const sessionId = fc
  .tuple(firstSuffixCharacter, fc.array(laterSuffixCharacter, { maxLength: 119 }))
  .map(([first, rest]) => `ses_${first}${rest.join("")}`);

describe("generated session storage paths", () => {
  it("derives a scanner-valid canonical prefix for every valid session ID", () => {
    fc.assert(
      fc.property(sessionId, (value) => {
        const prefix = sessionPrefixFromId(value);
        expect(isValidSessionPrefix(prefix)).toBe(true);
        expect(sessionDatabaseRelativePath(value)).toBe(
          `sessions/${prefix}/${value}/session.sqlite3`,
        );
      }),
      options,
    );
  });
});
