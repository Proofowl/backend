/**
 * Offline unit tests for the pipeline scheduler.
 *
 * No real clock: `setInterval` / `clearInterval` are injected fakes and
 * the test drives ticks by hand. `run` is a controllable promise so the
 * test can hold a pass "in flight" and prove overlapping ticks are
 * skipped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createCollectingLogger } from "../../src/pipeline/log.js";
import { createScheduler, type IntervalHandle } from "../../src/pipeline/schedule.js";

/** A fake interval: captures the callback so the test fires ticks itself. */
function fakeTimer() {
  let cb: (() => void) | null = null;
  let cleared = false;
  const handle: IntervalHandle = { id: "fake" };
  return {
    setIntervalImpl: (fn: () => void, _ms: number): IntervalHandle => {
      cb = fn;
      return handle;
    },
    clearIntervalImpl: (h: IntervalHandle) => {
      assert.equal(h, handle, "clears the handle it was given");
      cleared = true;
      cb = null;
    },
    tick: () => {
      if (!cb) throw new Error("no interval registered (or it was cleared)");
      cb();
    },
    get cleared() {
      return cleared;
    },
    get hasCallback() {
      return cb !== null;
    },
  };
}

/** A `run` whose resolution the test controls. */
function controllableRun() {
  let resolve!: (v: number) => void;
  let calls = 0;
  const run = (): Promise<number> => {
    calls += 1;
    return new Promise<number>((r) => {
      resolve = r;
    });
  };
  return {
    run,
    get calls() {
      return calls;
    },
    finishCurrent: (v = 0) => {
      resolve(v);
    },
  };
}

test("start() runs one pass immediately, then one per interval tick", async () => {
  const timer = fakeTimer();
  const r = controllableRun();
  const sched = createScheduler<number>({
    intervalMs: 60_000,
    run: r.run,
    setIntervalImpl: timer.setIntervalImpl,
    clearIntervalImpl: timer.clearIntervalImpl,
  });

  sched.start();
  assert.equal(r.calls, 1, "immediate pass on start()");
  r.finishCurrent();
  await Promise.resolve();

  timer.tick();
  assert.equal(r.calls, 2);
  r.finishCurrent();
  await Promise.resolve();

  timer.tick();
  assert.equal(r.calls, 3);
});

test("start() is idempotent — a second call registers no second interval", async () => {
  const timer = fakeTimer();
  const r = controllableRun();
  let intervals = 0;
  const sched = createScheduler<number>({
    intervalMs: 1000,
    run: r.run,
    setIntervalImpl: (fn, ms) => {
      intervals += 1;
      return timer.setIntervalImpl(fn, ms);
    },
    clearIntervalImpl: timer.clearIntervalImpl,
  });

  sched.start();
  sched.start();
  assert.equal(intervals, 1);
  assert.equal(r.calls, 1, "no second immediate pass either");
});

test("overlap prevention: a tick during an in-flight pass is skipped", async () => {
  const timer = fakeTimer();
  const r = controllableRun();
  const logger = createCollectingLogger();
  const sched = createScheduler<number>({
    intervalMs: 1000,
    run: r.run,
    logger,
    setIntervalImpl: timer.setIntervalImpl,
    clearIntervalImpl: timer.clearIntervalImpl,
  });

  sched.start(); // pass #1 starts, does not resolve
  assert.equal(r.calls, 1);
  assert.equal(sched.running, true);

  timer.tick(); // would be pass #2 — but #1 is still running
  timer.tick(); // and again
  assert.equal(r.calls, 1, "no overlapping run started");
  assert.equal(logger.byEvent("schedule.skipped_overlap").length, 2);

  r.finishCurrent(); // pass #1 done
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sched.running, false);

  timer.tick(); // now a fresh pass may start
  assert.equal(r.calls, 2);
});

test("triggerNow() resolves 'skipped-overlap' while a pass is running, else the result", async () => {
  const timer = fakeTimer();
  const r = controllableRun();
  const sched = createScheduler<number>({
    intervalMs: 1000,
    run: r.run,
    setIntervalImpl: timer.setIntervalImpl,
    clearIntervalImpl: timer.clearIntervalImpl,
  });

  sched.start(); // pass in flight
  const overlapped = sched.triggerNow();
  assert.equal(await overlapped, "skipped-overlap");

  r.finishCurrent(7);
  await Promise.resolve();

  const p = sched.triggerNow();
  r.finishCurrent(9);
  assert.equal(await p, 9);
});

test("stop() clears the interval and prevents further passes", async () => {
  const timer = fakeTimer();
  const r = controllableRun();
  const sched = createScheduler<number>({
    intervalMs: 1000,
    run: r.run,
    setIntervalImpl: timer.setIntervalImpl,
    clearIntervalImpl: timer.clearIntervalImpl,
  });

  sched.start();
  r.finishCurrent();
  await Promise.resolve();
  sched.stop();

  assert.equal(timer.cleared, true);
  assert.equal(timer.hasCallback, false);
  assert.equal(sched.started, false);
});

test("a rejecting pass does not kill the scheduler — the next tick still runs", async () => {
  const timer = fakeTimer();
  const logger = createCollectingLogger();
  let calls = 0;
  const sched = createScheduler<number>({
    intervalMs: 1000,
    run: async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom on first pass");
      return 0;
    },
    logger,
    setIntervalImpl: timer.setIntervalImpl,
    clearIntervalImpl: timer.clearIntervalImpl,
  });

  sched.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sched.running, false, "running is reset even when the pass threw");
  assert.equal(logger.byEvent("schedule.pass_error").length, 1);

  timer.tick();
  await Promise.resolve();
  assert.equal(calls, 2, "the loop kept going");
});

test("triggerNow() resolves 'error' when the pass throws (never rejects)", async () => {
  const sched = createScheduler<number>({
    intervalMs: 1000,
    run: async () => {
      throw new Error("nope");
    },
    setIntervalImpl: () => ({}),
    clearIntervalImpl: () => {},
  });

  assert.equal(await sched.triggerNow(), "error");
});
