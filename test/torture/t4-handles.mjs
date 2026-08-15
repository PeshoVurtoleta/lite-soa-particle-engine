/**
 * T4 -- slot / handle / input / lifecycle abuse. RESERVED, mostly empty.
 *
 * The full tier (emit-after-destroy variants, tick(dt) reentrancy, slot-index
 * abuse after death, etc.) is filled by S2 (lifecycle-abuse cases) and S3
 * (emit() returns a slot index -- the handle with all the abuse potential).
 * Asserting the post-S2/S3 contract here would assert behaviour the package
 * does not have yet.
 *
 * Several S1 findings ARE lifecycle/hygiene hazards with no coverage anywhere
 * else in the repo (roadmap QA pass). Each pin below touches the exact hazard's
 * code path and captures CURRENT (pre-fix) behaviour only -- the same
 * pin-the-present discipline T1 applies to P-02..P-06 and T3 now applies to
 * P-01. Findings intentionally NOT pinned here:
 *   - P-07 (O(max) not O(alive) iteration): the caller-side documented loop has
 *     no aliveCount/high-water mark to instrument, and the claim is a scaling
 *     cost, not a state transition -- a meaningful assertion needs either an
 *     internal counter that does not exist yet (S4) or a timing benchmark,
 *     which this zero-behaviour-change session and this non-timing gate cannot
 *     provide. Untestable today without inventing a benchmark out of scope.
 *   - P-11 (destroy() nulls public lanes, forcing `Float32Array | null` in the
 *     d.ts): the RUNTIME half is already pinned by
 *     `test/SoaParticleEngine.test.js` ("destroy() nulls all arrays"). The
 *     d.ts/type-level half is not runtime-checkable via node:test without a
 *     tsc invocation this package's pipeline does not run -- untestable here.
 */
import { SoaParticleEngine } from '../../SoaParticleEngine.js';
import { check, PUMP } from './harness.mjs';

export function run() {
    // --- P-08: start() calls requestAnimationFrame unconditionally, and Node
    // has no such global. Save + restore the two hooks the shared PUMP (see
    // harness.mjs) installed so every OTHER tier is unaffected.
    {
        const savedRaf = globalThis.requestAnimationFrame;
        const savedCaf = globalThis.cancelAnimationFrame;
        delete globalThis.requestAnimationFrame;
        delete globalThis.cancelAnimationFrame;
        const e = new SoaParticleEngine(4);
        let threw = null;
        try {
            e.start();
        } catch (err) {
            threw = err;
        } finally {
            globalThis.requestAnimationFrame = savedRaf;
            globalThis.cancelAnimationFrame = savedCaf;
        }
        check(threw instanceof ReferenceError,
            () => 'T4.P-08 pin: expected start() to throw a ReferenceError with no RAF shim, got ' + threw);
        e.destroy();
    }

    // --- P-09: emit() returns void today -- no slot handle, so a caller cannot
    // learn which slot was written. S3 changes the return to a slot index.
    {
        const e = new SoaParticleEngine(4);
        const ret = e.emit(0, 0, 0, 0, 1);
        check(ret === undefined,
            () => 'T4.P-09 pin: expected emit() to return undefined (no slot handle) today, got ' + String(ret));
        e.destroy();
    }

    // --- P-13: clear() only zeroes life and resets the head; x/y/vx/vy/data
    // retain the previous scene's values. Exact roadmap repro.
    {
        const e = new SoaParticleEngine(4);
        e.emit(5, 6, 7, 8, 1, 42);
        e.clear();
        check(e.life[0] === 0, () => 'T4.P-13 pin: expected life[0] zeroed after clear(), got ' + e.life[0]);
        check(e._head === 0, () => 'T4.P-13 pin: expected head reset to 0 after clear(), got ' + e._head);
        check(e.x[0] === 5, () => 'T4.P-13 pin: expected x[0] to remain stale at 5 after clear(), got ' + e.x[0]);
        check(e.vx[0] === 7, () => 'T4.P-13 pin: expected vx[0] to remain stale at 7 after clear(), got ' + e.vx[0]);
        check(e.data[0] === 42, () => 'T4.P-13 pin: expected data[0] to remain stale at 42 after clear(), got ' + e.data[0]);
        e.destroy();
    }

    // --- P-14: nothing is frozen or sealed. Lane reassignment by consumer code
    // is unguarded -- proof by doing exactly what destroy() itself does,
    // without calling destroy().
    {
        const e = new SoaParticleEngine(4);
        check(Object.isFrozen(e) === false,
            () => 'T4.P-14 pin: expected the engine instance to NOT be frozen, got isFrozen=' + Object.isFrozen(e));
        const before = e.x;
        e.x = null;
        check(e.x === null && e.x !== before,
            () => 'T4.P-14 pin: expected a lane to be freely reassignable by consumer code');
        e.x = before; // restore before destroy() so destroy() nulls it exactly once
        e.destroy();
    }

    // --- P-15: pause() is a bare alias for stop() -- no distinct semantics.
    // Proven by identical resulting state, not just "isRunning becomes false".
    {
        const a = new SoaParticleEngine(4);
        a.start();
        a.stop();
        const b = new SoaParticleEngine(4);
        b.start();
        b.pause();
        check(a._isRunning === b._isRunning && a._rafId === b._rafId,
            () => 'T4.P-15 pin: expected pause() to produce state identical to stop() (' +
                'isRunning=' + a._isRunning + '/' + b._isRunning + ', rafId=' + a._rafId + '/' + b._rafId + ')');
        a.destroy();
        b.destroy();
    }

    // --- P-16: no validate() / stats(out) introspection exists yet.
    {
        const e = new SoaParticleEngine(4);
        check(typeof e.validate === 'undefined',
            () => 'T4.P-16 pin: expected no validate() method to exist yet, got ' + typeof e.validate);
        check(typeof e.stats === 'undefined',
            () => 'T4.P-16 pin: expected no stats() method to exist yet, got ' + typeof e.stats);
        e.destroy();
    }

    // =========================================================================
    // S2 lifecycle abuse: every method after destroy() must be a silent no-op
    // (never throw), destroy() itself is idempotent, out-of-order start/stop is
    // safe, and re-entrant calls from inside onTick() do not corrupt state.
    // The shared PUMP (harness.mjs) drives every frame here -- never a real
    // timer -- so the sequence is exactly reproducible.
    // =========================================================================

    // --- Double destroy(): idempotent, lanes stay null both times.
    {
        const e = new SoaParticleEngine(4);
        e.destroy();
        const firstX = e.x;
        let threw = null;
        try { e.destroy(); } catch (err) { threw = err; }
        check(threw === null, () => 'T4.lifecycle: second destroy() threw ' + threw);
        check(e.x === null && firstX === null,
            () => 'T4.lifecycle: expected x lane to remain null across duplicate dispose, got ' + e.x);
    }

    // --- Every public method after destroy() is a silent no-op: none may throw,
    // and none may resurrect a lane or restart the loop.
    {
        const e = new SoaParticleEngine(4);
        e.destroy();

        let threw = null;
        try {
            e.emit(1, 2, 3, 4, 1, 5);
            e.clear();
            e.start();
            e.stop();
            e.pause();
            e.onTick(function () {});
            e.destroy();
        } catch (err) {
            threw = err;
        }
        check(threw === null, () => 'T4.lifecycle: a method call after destroy() threw ' + threw);
        check(e.x === null, () => 'T4.lifecycle: emit() after destroy() must not resurrect the x lane, got ' + e.x);
        check(e._isRunning === false, () => 'T4.lifecycle: start() after destroy() must not set _isRunning, got ' + e._isRunning);
    }

    // --- clear() before any emit(): no-op on an already-clean engine.
    {
        const e = new SoaParticleEngine(4);
        let threw = null;
        try { e.clear(); } catch (err) { threw = err; }
        check(threw === null, () => 'T4.lifecycle: clear() before any emit() threw ' + threw);
        check(e._head === 0, () => 'T4.lifecycle: clear() before any emit() must leave head at 0, got ' + e._head);
        e.destroy();
    }

    // --- stop() before start(): no-op, never throws, _isRunning stays false.
    {
        const e = new SoaParticleEngine(4);
        let threw = null;
        try { e.stop(); } catch (err) { threw = err; }
        check(threw === null, () => 'T4.lifecycle: stop() before start() threw ' + threw);
        check(e._isRunning === false, () => 'T4.lifecycle: stop() before start() must leave _isRunning false, got ' + e._isRunning);
        e.destroy();
    }

    // --- start() after destroy(): the destroyed guard wins over the running one.
    {
        const e = new SoaParticleEngine(4);
        e.destroy();
        let threw = null;
        try { e.start(); } catch (err) { threw = err; }
        check(threw === null, () => 'T4.lifecycle: start() after destroy() threw ' + threw);
        check(e._isRunning === false, () => 'T4.lifecycle: start() after destroy() must not run, got _isRunning=' + e._isRunning);
    }

    // --- Interleaved start/stop/destroy: a longer adversarial sequence that
    // mixes every transition, none of which may throw or leave the loop armed
    // once destroy() has fired.
    {
        PUMP.reset();
        const e = new SoaParticleEngine(4);
        let threw = null;
        try {
            PUMP.setNow(0);
            e.start();
            e.stop();
            e.start();
            e.pause();
            e.start();
            e.destroy();
            e.stop();   // after destroy -- no-op
            e.start();  // after destroy -- no-op
            e.pause();  // after destroy -- no-op
        } catch (err) {
            threw = err;
        }
        check(threw === null, () => 'T4.lifecycle: interleaved start/stop/destroy threw ' + threw);
        check(e._destroyed === true, () => 'T4.lifecycle: expected the engine to end destroyed');
        check(e._isRunning === false, () => 'T4.lifecycle: expected _isRunning false after the interleaved sequence');
        check(PUMP.pending() === false,
            () => 'T4.lifecycle: expected no armed frame after start() following destroy()');
    }

    // --- Re-entrant emit(): writing to the engine FROM INSIDE its own onTick
    // callback (mid-iteration) must not throw and must land in the current head
    // slot exactly as a top-level emit() would.
    {
        PUMP.reset();
        const e = new SoaParticleEngine(4);
        let threw = null;
        try {
            e.onTick(function () { e.emit(9, 9, 0, 0, 1, 7); });
            PUMP.setNow(0);
            e.start();
            PUMP.setNow(16);
            PUMP.pump(16);
        } catch (err) {
            threw = err;
        }
        check(threw === null, () => 'T4.lifecycle: re-entrant emit() from inside onTick threw ' + threw);
        check(e.x[0] === 9 && e.data[0] === 7,
            () => 'T4.lifecycle: re-entrant emit() did not land in slot 0, got x=' + e.x[0] + ' data=' + e.data[0]);
        check(e._head === 1, () => 'T4.lifecycle: re-entrant emit() did not advance head, got ' + e._head);
        e.stop();
        e.destroy();
    }

    // --- Adversarial case the planner did not name: dispose-during-iteration.
    // _loop() calls onTick() and THEN unconditionally re-arms
    // requestAnimationFrame(this._loop), even when onTick just called destroy().
    // The re-arm is not guarded by _isRunning/_destroyed, so one orphaned frame
    // is left pending on an already-destroyed engine. This does not throw and
    // self-heals -- the very next frame hits the `if (!this._isRunning) return;`
    // guard at the top of _loop before doing anything else, so onTick is never
    // invoked twice and no second re-arm happens -- but the orphaned frame
    // between destroy() and that guard firing IS an observable state (a real
    // engine would see one wasted RAF callback after teardown). Pinned as
    // CURRENT behaviour, not fixed here: SoaParticleEngine.js is out of scope
    // for this QA stage. Reported separately as a finding.
    {
        PUMP.reset();
        const e = new SoaParticleEngine(4);
        let ticks = 0;
        let threw = null;
        try {
            e.onTick(function () { ticks++; e.destroy(); });
            PUMP.setNow(0);
            e.start();
            PUMP.setNow(16);
            PUMP.pump(16); // onTick fires, calls destroy() re-entrantly
        } catch (err) {
            threw = err;
        }
        check(threw === null, () => 'T4.lifecycle: destroy() called from inside onTick threw ' + threw);
        check(e._destroyed === true, () => 'T4.lifecycle: expected the engine destroyed after the re-entrant call');
        check(ticks === 1, () => 'T4.lifecycle: expected onTick to fire exactly once, got ' + ticks);
        // The orphaned re-arm: pin it so a future fix to _loop's re-arm guard is
        // a visible, deliberate change to this exact assertion, not a silent one.
        check(PUMP.pending() === true,
            () => 'T4.lifecycle: expected the KNOWN orphaned re-arm after destroy()-during-onTick (pinned current behaviour)');

        // Firing the orphaned frame must be harmless: no second onTick call, no
        // throw, and no further re-arm once the top-of-_loop guard returns.
        let threw2 = null;
        try {
            PUMP.setNow(32);
            PUMP.pump(32);
        } catch (err) {
            threw2 = err;
        }
        check(threw2 === null, () => 'T4.lifecycle: firing the orphaned post-destroy frame threw ' + threw2);
        check(ticks === 1, () => 'T4.lifecycle: the orphaned frame must not re-invoke onTick, got ticks=' + ticks);
        check(PUMP.pending() === false,
            () => 'T4.lifecycle: expected the orphaned frame to self-heal (no further re-arm)');
    }
}
