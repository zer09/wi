import type { Duplex } from "node:stream";

export interface CorrelatedHttpError {
  readonly code: string;
  readonly message: string;
  readonly diagnosticId: string;
}

export function correlatedHttpError(
  code: string,
  message: string,
  diagnosticId: string,
): CorrelatedHttpError {
  return { code, message, diagnosticId };
}

function statusText(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 421:
      return "Misdirected Request";
    case 426:
      return "Upgrade Required";
    case 500:
      return "Internal Server Error";
    case 503:
      return "Service Unavailable";
    default:
      return "Rejected";
  }
}

export function endRawHttpError(
  socket: Duplex,
  statusCode: number,
  error: CorrelatedHttpError,
): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = `${JSON.stringify(error)}\n`;
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText(statusCode)}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Cache-Control: no-store\r\n" +
      "X-Content-Type-Options: nosniff\r\n" +
      `X-Wi-Diagnostic-Id: ${error.diagnosticId}\r\n` +
      "\r\n" +
      body,
  );
}
