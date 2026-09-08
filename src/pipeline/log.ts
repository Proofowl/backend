/**
 * A tiny structured logger for the pipeline. Not a logging framework —
 * just enough shape that `runOnce` can emit one record per routed
 * outcome and the tests can assert on those records without scraping
 * stdout.
 *
 * Every record carries a machine-readable `event` key (e.g.
 * `"drain.submitted"`, `"discovery.enqueued"`) plus arbitrary structured
 * fields. `ATTESTOR_SECRET_KEY` never reaches here — callers pass hashes,
 * wallet strkeys, and tx hashes, never secrets.
 */

export type PipelineLogLevel = "info" | "warn" | "error";

export interface PipelineLogRecord {
  level: PipelineLogLevel;
  /** Stable machine key for the thing that happened. */
  event: string;
  /** Human-readable one-liner. */
  message: string;
  /** Structured context (ids, counts, tx hashes …). */
  fields?: Record<string, unknown>;
}

export interface PipelineLogger {
  log(record: PipelineLogRecord): void;
}

/** Writes one compact line per record to the console. */
export const consolePipelineLogger: PipelineLogger = {
  log(record) {
    const suffix =
      record.fields && Object.keys(record.fields).length > 0 ? ` ${j(record.fields)}` : "";
    const line = `[pipeline] ${record.level.toUpperCase()} ${record.event} — ${record.message}${suffix}`;
    if (record.level === "error") console.error(line);
    else if (record.level === "warn") console.warn(line);
    else console.log(line);
  },
};

/** Swallows everything — the default when no logger is injected in a test. */
export const silentPipelineLogger: PipelineLogger = { log() {} };

export interface CollectingLogger extends PipelineLogger {
  readonly records: PipelineLogRecord[];
  /** Records whose `event` equals `event`. */
  byEvent(event: string): PipelineLogRecord[];
}

/** In-memory logger for assertions in tests. */
export function createCollectingLogger(): CollectingLogger {
  const records: PipelineLogRecord[] = [];
  return {
    records,
    log(record) {
      records.push(record);
    },
    byEvent(event) {
      return records.filter((r) => r.event === event);
    },
  };
}

function j(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return "<unserialisable>";
  }
}
