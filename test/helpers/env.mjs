/**
 * Deterministic frame pump + clock shims.
 *
 * Node has no `requestAnimationFrame` / `cancelAnimationFrame` and gives no DOM
 * `performance.now` guarantee (finding P-08). The engine owns the RAF loop, so to
 * drive it under Node -- from the node:test suite AND from the torture harness --
 * the shims must live in ONE place and be driven by EXPLICIT timestamps, never a
 * real timer and never a wall clock. This module is that one place.
 *
 * `installFramePump()` swaps the three globals for a manual pump and returns a
 * controller:
 *   - `pump(timestamp)`  invoke the pending RAF callback once with `timestamp`.
 *   - `setNow(ms)`       set what `performance.now()` returns.
 *   - `rafCalls` / `cancelCalls`  call counters (live fields).
 *   - `pending()`        true iff a RAF callback is armed.
 *   - `reset()`          zero the counters and drop any armed callback.
 *   - `uninstall()`      restore the original globals.
 *
 * The pump NEVER schedules real work: a frame happens only when the caller calls
 * `pump()`. `performance.now()` returns a frozen, caller-set value so `dt` is a
 * pure function of the timestamps a test chooses.
 */

export function installFramePump(target = globalThis) {
    const perf = target.performance;
    const saved = {
        raf: target.requestAnimationFrame,
        caf: target.cancelAnimationFrame,
        now: perf ? perf.now : undefined,
        hadRaf: 'requestAnimationFrame' in target,
        hadCaf: 'cancelAnimationFrame' in target,
    };

    const ctrl = {
        rafCalls: 0,
        cancelCalls: 0,
        _pendingCb: null,
        _pendingId: 0,
        _nextId: 1,
        _now: 0,
    };

    target.requestAnimationFrame = function (cb) {
        ctrl._pendingCb = cb;
        ctrl._pendingId = ctrl._nextId++;
        ctrl.rafCalls++;
        return ctrl._pendingId;
    };

    target.cancelAnimationFrame = function (id) {
        ctrl.cancelCalls++;
        if (id === ctrl._pendingId) {
            ctrl._pendingCb = null;
            ctrl._pendingId = 0;
        }
    };

    if (perf) {
        perf.now = function () { return ctrl._now; };
    }

    ctrl.setNow = function (ms) { ctrl._now = ms; };

    ctrl.pending = function () { return ctrl._pendingCb !== null; };

    // Drive exactly one frame with an explicit timestamp. The armed callback is
    // cleared BEFORE invocation so a callback that re-schedules (the engine loop)
    // arms a fresh frame rather than being re-invoked in a loop.
    ctrl.pump = function (timestamp) {
        const cb = ctrl._pendingCb;
        ctrl._pendingCb = null;
        ctrl._pendingId = 0;
        if (cb) cb(timestamp);
    };

    ctrl.reset = function () {
        ctrl.rafCalls = 0;
        ctrl.cancelCalls = 0;
        ctrl._pendingCb = null;
        ctrl._pendingId = 0;
        ctrl._now = 0;
    };

    ctrl.uninstall = function () {
        if (saved.hadRaf) target.requestAnimationFrame = saved.raf;
        else delete target.requestAnimationFrame;
        if (saved.hadCaf) target.cancelAnimationFrame = saved.caf;
        else delete target.cancelAnimationFrame;
        if (perf && saved.now) perf.now = saved.now;
    };

    return ctrl;
}
