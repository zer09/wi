import type { Writable } from "node:stream";
import { redactLogFields, safeErrorDetails } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogRecord = Readonly<Record<string, unknown>> & {
  readonly timestampMs: number;
  readonly level: LogLevel;
  readonly event: string;
};

export interface Logger {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, error: unknown, fields?: Readonly<Record<string, unknown>>): void;
}

class NonThrowingLogger implements Logger {
  constructor(private readonly delegate: Logger) {}

  debug(event: string, fields?: Readonly<Record<string, unknown>>): void {
    try {
      this.delegate.debug(event, fields);
    } catch {
      // Diagnostics are best-effort and cannot alter application control flow.
    }
  }

  info(event: string, fields?: Readonly<Record<string, unknown>>): void {
    try {
      this.delegate.info(event, fields);
    } catch {
      // Diagnostics are best-effort and cannot alter application control flow.
    }
  }

  warn(event: string, fields?: Readonly<Record<string, unknown>>): void {
    try {
      this.delegate.warn(event, fields);
    } catch {
      // Diagnostics are best-effort and cannot alter application control flow.
    }
  }

  error(
    event: string,
    error: unknown,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.delegate.error(event, error, fields);
    } catch {
      // Diagnostics are best-effort and cannot alter application control flow.
    }
  }
}

export function nonThrowingLogger(logger: Logger): Logger {
  return logger instanceof NonThrowingLogger ? logger : new NonThrowingLogger(logger);
}

export class BoundedLogSink {
  private blocked = false;
  private failed = false;

  constructor(private readonly stream: Writable) {
    stream.on("error", () => {
      this.failed = true;
      this.blocked = true;
    });
    stream.on("drain", () => {
      if (!this.failed) this.blocked = false;
    });
  }

  readonly write = (record: LogRecord): void => {
    if (this.failed || this.blocked) return;
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      return;
    }
    try {
      if (!this.stream.write(line)) this.blocked = true;
    } catch {
      this.failed = true;
      this.blocked = true;
    }
  };
}

const productionLogSink = new BoundedLogSink(process.stdout);

export interface JsonLoggerOptions {
  readonly now?: () => number;
  readonly write?: (record: LogRecord) => void;
  readonly stream?: Writable;
}

export class JsonLogger implements Logger {
  private readonly now: () => number;
  private readonly writeRecord: (record: LogRecord) => void;

  constructor(options: JsonLoggerOptions = {}) {
    if (options.write !== undefined && options.stream !== undefined) {
      throw new TypeError("JsonLogger accepts either write or stream, not both");
    }
    this.now = options.now ?? Date.now;
    this.writeRecord =
      options.write ??
      (options.stream === undefined
        ? productionLogSink.write
        : new BoundedLogSink(options.stream).write);
  }

  private log(
    level: LogLevel,
    event: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void {
    this.writeRecord({
      timestampMs: this.now(),
      level,
      event,
      ...redactLogFields(fields),
    });
  }

  debug(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log("debug", event, fields);
  }

  info(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log("warn", event, fields);
  }

  error(
    event: string,
    error: unknown,
    fields: Readonly<Record<string, unknown>> = {},
  ): void {
    this.writeRecord({
      timestampMs: this.now(),
      level: "error",
      event,
      ...redactLogFields(fields),
      error: safeErrorDetails(error),
    });
  }
}
