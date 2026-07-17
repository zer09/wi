import { describe, expect, it } from "vitest";
import {
  malformedPayloadMetadata,
  redactLogFields,
  safeErrorDetails,
} from "./redaction.js";

describe("logging redaction", () => {
  it("redacts structured and embedded credentials and removes sensitive query strings", () => {
    const redacted = redactLogFields({
      cookie: "wi_browser_session=secret-cookie",
      nested: {
        authorization: "Bearer secret-token",
        apiKey: "api-secret",
        oauthToken: "oauth-secret",
        clientSecret: "client-secret",
        url: "http://localhost/callback?code=oauth-code#fragment",
      },
      preview: '{"authorization":"Bearer AUDIT_BEARER_SECRET"}',
      commandId: "cmd_visible",
    });

    expect(redacted).toEqual({
      cookie: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        apiKey: "[REDACTED]",
        oauthToken: "[REDACTED]",
        clientSecret: "[REDACTED]",
        url: "http://localhost/callback",
      },
      preview: '{"authorization":"[REDACTED] [REDACTED]"}',
      commandId: "cmd_visible",
    });
    expect(JSON.stringify(redacted)).not.toContain("AUDIT_BEARER_SECRET");
  });

  it("redacts credential header variants, raw queries, and URL userinfo recursively", () => {
    const secrets = [
      "AUDIT_PASSWORD_SECRET",
      "AUDIT_X_API_KEY_SECRET",
      "AUDIT_PROXY_SECRET",
      "AUDIT_QUERY_SECRET",
      "AUDIT_URL_PASSWORD",
      "AUDIT_EMBEDDED_SECRET",
    ];
    const redacted = redactLogFields({
      password: secrets[0],
      headers: {
        "x-api-key": secrets[1],
        "proxy-authorization": `Basic ${secrets[2]}`,
      },
      requestUrl: `https://user:${secrets[4]}@example.com/path?token=${secrets[3]}#fragment`,
      query: `token=${secrets[3]}`,
      nested: [{ callbackUri: `/callback?code=${secrets[3]}` }],
      message: `x-api-key=${secrets[5]} password=${secrets[0]}`,
      diagnosticId: "err_visible",
    });

    expect(redacted).toMatchObject({
      password: "[REDACTED]",
      headers: {
        "x-api-key": "[REDACTED]",
        "proxy-authorization": "[REDACTED]",
      },
      requestUrl: "https://example.com/path",
      query: "[REDACTED]",
      nested: [{ callbackUri: "/callback" }],
      diagnosticId: "err_visible",
    });
    for (const secret of secrets) expect(JSON.stringify(redacted)).not.toContain(secret);
  });

  it("redacts opaque values under composite credential field names", () => {
    const secrets = {
      authorizationHeader: "opaque-auth-secret",
      apiKeyHeader: "opaque-api-secret",
      clientSecretValue: "opaque-client-secret",
      oauthCodeField: "opaque-oauth-code",
      credentialValue: "opaque-credential",
      userPwdValue: "opaque-password",
    };

    const redacted = redactLogFields(secrets);

    expect(redacted).toEqual(
      Object.fromEntries(Object.keys(secrets).map((key) => [key, "[REDACTED]"])),
    );
    for (const secret of Object.values(secrets)) {
      expect(JSON.stringify(redacted)).not.toContain(secret);
    }
  });

  it("redacts cookie headers and sensitive query assignments embedded in arbitrary strings", () => {
    const secrets = [
      "AUDIT_COOKIE_SECRET",
      "AUDIT_SET_COOKIE_SECRET",
      "AUDIT_BROWSER_COOKIE_SECRET",
      "AUDIT_QUERY_TOKEN_SECRET",
      "AUDIT_QUERY_CODE_SECRET",
    ];
    const redacted = redactLogFields({
      headerPreview: `Cookie: other=value; wi_browser_session=${secrets[0]}`,
      responsePreview: `Set-Cookie: wi_browser_session=${secrets[1]}; HttpOnly; SameSite=Strict`,
      jsonPreview: `{"cookie":"wi_browser_session=${secrets[2]}"}`,
      requestPreview: `GET /callback?token=${secrets[3]}&code=${secrets[4]} HTTP/1.1`,
    });

    expect(redacted).toMatchObject({
      headerPreview: "Cookie: [REDACTED]",
      responsePreview: "Set-Cookie: [REDACTED]",
    });
    for (const secret of secrets) expect(JSON.stringify(redacted)).not.toContain(secret);
  });

  it("logs only a length and digest for malformed payloads", () => {
    const metadata = malformedPayloadMetadata(
      '{"authorization":"Bearer AUDIT_BEARER_SECRET"',
    );
    expect(metadata).toMatchObject({
      sourceUnit: "utf16_code_units",
      sourceLength: 45,
      sampledByteLength: 45,
      sampledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      truncated: false,
    });
    expect(JSON.stringify(metadata)).not.toContain("AUDIT_BEARER_SECRET");
  });

  it("preserves allowlisted error categories and fingerprints unknown codes", () => {
    const stable = Object.assign(new Error("disk details must stay fingerprinted"), {
      code: "storage.disk_full",
    });
    const unknown = Object.assign(new Error("unknown details must stay fingerprinted"), {
      code: "SQLITE_SECRET_EXTENSION",
    });

    expect(safeErrorDetails(stable)).toMatchObject({
      code: "storage.disk_full",
      message: { sampledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    });
    expect(safeErrorDetails(unknown)).toMatchObject({
      code: {
        sourceUnit: "utf16_code_units",
        sourceLength: "SQLITE_SECRET_EXTENSION".length,
        sampledByteLength: Buffer.byteLength("SQLITE_SECRET_EXTENSION"),
        sampledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        truncated: false,
      },
    });
  });

  it("fingerprints exception messages instead of retaining untrusted text", () => {
    const details = safeErrorDetails(
      new Error("Provider failed with Bearer AUDIT_PROVIDER_SECRET"),
    );
    expect(details).toMatchObject({
      type: "error",
      message: {
        sourceUnit: "utf16_code_units",
        sourceLength: 49,
        sampledByteLength: 49,
        sampledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        truncated: false,
      },
    });
    expect(JSON.stringify(details)).not.toContain("AUDIT_PROVIDER_SECRET");
  });

  it("samples oversized untrusted strings before scrubbing, UTF-8 encoding, and hashing", () => {
    const secret = "AUDIT_OVERSIZED_ERROR_SECRET";
    const oversized = `Bearer ${secret} ${"x".repeat(8 * 1_024 * 1_024)}`;

    const details = safeErrorDetails(new Error(oversized));
    expect(details).toMatchObject({
      type: "error",
      message: {
        sourceUnit: "utf16_code_units",
        sourceLength: oversized.length,
        sampledByteLength: 4_096,
        sampledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        truncated: true,
      },
    });
    const redacted = redactLogFields({ detail: oversized });
    expect(redacted.detail).toMatch(/^Bearer \[REDACTED\]/u);
    expect(String(redacted.detail).length).toBeLessThanOrEqual(1_024 + "[TRUNCATED]".length);
    expect(JSON.stringify({ details, redacted })).not.toContain(secret);
  });
});
