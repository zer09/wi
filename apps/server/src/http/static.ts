import { lstat, open } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const MAXIMUM_STATIC_ASSET_BYTES = 5 * 1_024 * 1_024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface AssetFoundationRejection {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
  readonly reason: "static_not_found" | "transfer_not_implemented";
}

export type StaticAssetResult = "not_found" | "served";

function requestedAsset(pathname: string): { readonly relativePath: string; readonly immutable: boolean } | null {
  if (pathname === "/" || pathname === "/index.html") {
    return { relativePath: "index.html", immutable: false };
  }
  if (!/^\/assets\/[A-Za-z0-9._-]+$/u.test(pathname)) return null;
  return { relativePath: pathname.slice(1), immutable: true };
}

export async function serveStaticAsset(
  response: ServerResponse,
  pathname: string,
  webRoot: string,
): Promise<StaticAssetResult> {
  const requested = requestedAsset(pathname);
  if (requested === null) return "not_found";

  const root = resolve(webRoot);
  const filePath = resolve(root, requested.relativePath);
  if (!filePath.startsWith(`${root}${sep}`)) return "not_found";

  let fileSize: number;
  try {
    const details = await lstat(filePath);
    if (!details.isFile() || details.size > MAXIMUM_STATIC_ASSET_BYTES) return "not_found";
    fileSize = details.size;
  } catch {
    return "not_found";
  }

  const body = Buffer.alloc(fileSize);
  try {
    const file = await open(filePath, "r");
    try {
      const { bytesRead } = await file.read(body, 0, fileSize, 0);
      const extra = Buffer.alloc(1);
      const trailing = await file.read(extra, 0, 1, fileSize);
      if (bytesRead !== fileSize || trailing.bytesRead !== 0) return "not_found";
    } finally {
      await file.close();
    }
  } catch {
    return "not_found";
  }

  response.writeHead(200, {
    "cache-control": requested.immutable ? "public, max-age=31536000, immutable" : "no-store",
    "content-length": body.byteLength,
    "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
  });
  response.end(body);
  return "served";
}

export function assetFoundationRejection(pathname: string): AssetFoundationRejection | null {
  if (pathname.startsWith("/static/") || pathname.startsWith("/assets/")) {
    return {
      statusCode: 404,
      code: "http.not_found",
      message: "Static asset not found.",
      reason: "static_not_found",
    };
  }
  if (pathname.startsWith("/blobs/") || pathname.startsWith("/files/")) {
    return {
      statusCode: 501,
      code: "http.not_implemented",
      message: "Blob and file transfer is not available in this milestone.",
      reason: "transfer_not_implemented",
    };
  }
  return null;
}
