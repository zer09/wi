export interface AssetFoundationRejection {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
  readonly reason: "static_not_found" | "transfer_not_implemented";
}

export function assetFoundationRejection(pathname: string): AssetFoundationRejection | null {
  if (pathname.startsWith("/static/")) {
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
