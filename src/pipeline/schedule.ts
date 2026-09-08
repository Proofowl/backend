/**
 * The scheduler — runs {@link runOnce} on a fixed interval.
 *
 * It is DELIBERATELY inert until `start()` is called, and `start()` is
 * only ever called from the `pipeline:loop` entrypoint (./main.ts). It
 * is never imported by `src/app.ts` / `src/server.ts`; nothing runs a
 * pass as a side effect of the HTTP server starting.
 *
 * Overlap prevention: a pass can outlast the interval (a slow GitHub
 * API, a backlog to drain). When a tick fires while the previous pass is
 * still running, the tick is SKIPPED — passes never stack and never run
 * concurrently. `triggerNow()` behaves the same way and reports the skip
 * to its caller.
 *
 * Timers are injectable so tests drive ticks by hand with no real
 * clock; production uses the global `setInterval` / `clearInterval`.
 */

import { silentPipelineLogger, type PipelineLogger } from "./log.js";

/** Opaque interval handle — `number` under Node's global, an object under a fake. */
export type IntervalHandle = ReturnType<typeof setInterval> | number | object;

export interface SchedulerDeps<T = unknown> {
  /** Milliseconds between ticks. The caller validates the floor (see ./config.ts). */
  intervalMs: number;
  /** One pipeline pass. Rejections are caught and logged — they never kill the loop. */
  run: () => Promise<T>;
  logger?: PipelineLogger;
  /** Defaults to the global `setInterval`. */
  setIntervalImpl?: (fn: () => void, ms: number) => IntervalHandle;
  /** Defaults to the global `clearInterval`. */
  clearIntervalImpl?: (handle: IntervalHandle) => void;
}

export interface Scheduler<T = unknown> {
  /**
   * Begin ticking. Kicks off one pass immediately, then one every
   * `intervalMs`. Idempotent — a second call while already started is a
   * no-op.
   */
  start(): void;
  /** Stop ticking. A pass already in flight runs to completion. Idempotent. */
  stop(): void;
  /**
   * Run a pass right now, out of band. Resolves with the pass result;
   * `"skipped-overlap"` if a pass is already running; `"error"` if the
   * pass threw (the error is logged — it never rejects, so the loop and
   * out-of-band callers stay alive).
   */
  triggerNow(): Promise<T | "skipped-overlap" | "error">;
  /** True while a pass is in flight. */
  readonly running: boolean;
  /** True between `start()` and `stop()`. */
  readonly started: boolean;
}

export function createScheduler<T>(deps: SchedulerDeps<T>): Scheduler<T> {
  const logger = deps.logger ?? silentPipelineLogger;
  const setIntervalImpl = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl =
    deps.clearIntervalImpl ?? ((h) => clearInterval(h as Parameters<typeof clearInterval>[0]));

  let handle: IntervalHandle | undefined;
  let running = false;
  let started = false;
  let ticks = 0;

  async function runGuarded(
    trigger: "start" | "tick" | "manual",
  ): Promise<T | "skipped-overlap" | "error"> {
    if (running) {
      logger.log({
        level: "warn",
        event: "schedule.skipped_overlap",
        message: `previous pipeline pass still running; skipping this ${trigger}`,
        fields: { trigger },
      });
      return "skipped-overlap";
    }
    running = true;
    const startedAt = Date.now();
    logger.log({
      level: "info",
      event: "schedule.pass_start",
      message: `pipeline pass starting (${trigger})`,
      fields: { trigger },
    });
    try {
      const result = await deps.run();
      logger.log({
        level: "info",
        event: "schedule.pass_done",
        message: `pipeline pass finished in ${Date.now() - startedAt}ms`,
        fields: { trigger, durationMs: Date.now() - startedAt },
      });
      return result;
    } catch (err) {
      logger.log({
        level: "error",
        event: "schedule.pass_error",
        message: `pipeline pass threw: ${err instanceof Error ? err.message : String(err)}`,
        fields: { trigger },
      });
      return "error";
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      logger.log({
        level: "info",
        event: "schedule.start",
        message: `scheduler started; interval ${deps.intervalMs}ms`,
        fields: { intervalMs: deps.intervalMs },
      });
      // Fire the first pass now, then on every interval. Rejections are
      // swallowed inside runGuarded, so this floating promise is safe.
      void runGuarded("start");
      handle = setIntervalImpl(() => {
        ticks += 1;
        void runGuarded("tick");
      }, deps.intervalMs);
    },

    stop() {
      if (!started) return;
      started = false;
      if (handle !== undefined) {
        clearIntervalImpl(handle);
        handle = undefined;
      }
      logger.log({
        level: "info",
        event: "schedule.stop",
        message: `scheduler stopped after ${ticks} tick(s)`,
        fields: { ticks },
      });
    },

    triggerNow() {
      return runGuarded("manual");
    },

    get running() {
      return running;
    },
    get started() {
      return started;
    },
  };
}
