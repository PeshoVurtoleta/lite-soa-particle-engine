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
    // --- P-08 / P-28 (D2): start() validates the environment BEFORE mutating any
    // state and throws a NAMED library TypeError with no requestAnimationFrame --
    // not the bare ReferenceError v1.0.5 leaked. Save + restore the two hooks the
    // shared PUMP (see harness.mjs) installed so every OTHER tier is unaffected.
    // FLIPPED from the ReferenceError pin: the change is visible and deliberate.
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
        check(threw instanceof TypeError && /^SoaParticleEngine: /.test(String(threw.message)),
            () => 'T4.P-08 pin (flipped, D2): expected start() to throw a NAMED library TypeError with no RAF, got ' + threw);
        // Fail-closed (P-28): the throw left the engine untouched and retryable.
        check(e._isRunning === false && e._lastTime === 0,
            () => 'T4.P-28 pin: a failed start() must leave _isRunning=false and _lastTime=0, got ' +
                e._isRunning + '/' + e._lastTime);
        e.destroy();
    }

    // --- P-09 (receipt half, D4): emit() returns the written slot index -- a
    // receipt, not an identity. FLIPPED from the undefined pin: the first emit
    // writes slot 0 and returns 0; the next returns 1; a rejected emit returns
    // -1 and does not advance the cursor.
    {
        const e = new SoaParticleEngine(4);
        const r0 = e.emit(0, 0, 0, 0, 1);
        check(r0 === 0,
            () => 'T4.P-09 pin (flipped, D4): expected emit() to return slot index 0, got ' + String(r0));
        const r1 = e.emit(0, 0, 0, 0, 1);
        check(r1 === 1,
            () => 'T4.P-09 pin (flipped, D4): expected the second emit() to return slot index 1, got ' + String(r1));
        const rejected = e.emit(NaN, 0, 0, 0, 1);
        check(rejected === -1,
            () => 'T4.P-09 pin (flipped, D4): expected a rejected emit() to return -1, got ' + String(rejected));
        check(e._head === 2,
            () => 'T4.P-09 pin (flipped, D4): a rejected emit must not advance the cursor, head=' + e._head);
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

    // --- P-26 (D7): dispose-during-iteration. _loop() calls onTick() and re-arms
    // requestAnimationFrame(this._loop) only when `_isRunning && !_destroyed`. If
    // onTick just called destroy(), the guard sees _destroyed and does NOT re-arm,
    // so NO orphaned frame is left pending on a torn-down engine. FLIPPED from the
    // pinned-orphan assertion (PUMP.pending() === true) to the fixed contract
    // (=== false): the change is visible and deliberate, and a T9 control reverts
    // the guard and must fail this pin.
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
        // The guarded re-arm: no frame is pending after destroy()-during-onTick.
        check(PUMP.pending() === false,
            () => 'T4.P-26 pin (flipped, D7): expected NO orphaned re-arm after destroy()-during-onTick, PUMP.pending()=' + PUMP.pending());

        // A second pump has nothing armed to fire: no second onTick call, no throw.
        let threw2 = null;
        try {
            PUMP.setNow(32);
            PUMP.pump(32);
        } catch (err) {
            threw2 = err;
        }
        check(threw2 === null, () => 'T4.lifecycle: pumping after a guarded re-arm threw ' + threw2);
        check(ticks === 1, () => 'T4.lifecycle: no armed frame must re-invoke onTick, got ticks=' + ticks);
        check(PUMP.pending() === false,
            () => 'T4.lifecycle: still no frame pending after the second pump');
    }

    // =========================================================================
    // S3 door: the cases the tier never got. onTick's registration door (P-27),
    // tick(dt)'s new hot-path door (D3), and the lifecycle/clock sequences that
    // prove D2 and D8 fail closed.
    // =========================================================================

    // --- P-27 (D6): onTick() throws at the door for a non-callable, and only for
    // a non-callable. A function registers; null/undefined UNREGISTER (store null)
    // and return normally; anything else is a named library TypeError. The frame
    // path can then never throw for a registered value.
    {
        const e = new SoaParticleEngine(4);
        for (const bad of [42, 'x', {}, [], true, 0, 10n, Symbol('s')]) {
            let threw = null;
            try { e.onTick(bad); } catch (err) { threw = err; }
            check(threw instanceof TypeError && /^SoaParticleEngine: /.test(String(threw.message)),
                () => 'T4.P-27: onTick(' + String(bad) + ') must throw a named TypeError, got ' + threw);
        }
        // A function registers.
        const fn = function () {};
        e.onTick(fn);
        check(e._onTick === fn, () => 'T4.P-27: onTick(function) must register it');
        // null and undefined unregister, storing NULL (never undefined) so tick()
        // can test === null rather than truthiness (truthiness let 42 through).
        e.onTick(null);
        check(e._onTick === null, () => 'T4.P-27: onTick(null) must unregister (store null), got ' + String(e._onTick));
        e.onTick(fn);
        e.onTick(undefined);
        check(e._onTick === null, () => 'T4.P-27: onTick(undefined) must unregister as null, got ' + String(e._onTick));
        e.destroy();
    }

    // --- D3: tick(dt)'s hot-path door. The rejection corpus is emit()'s P-23/P-24
    // corpus one entry point over: every coerced non-number and the throwing
    // BigInt/Symbol/valueOf trio must be rejected with `false`, must NOT invoke the
    // callback (counter asserted), and must NOT throw. dt of 0, -0 and exactly
    // maxDt are accepted.
    {
        const e = new SoaParticleEngine(4);
        let calls = 0;
        e.onTick(function () { calls++; });

        const rejects = [NaN, -1, '0.05', true, [0.05], null, undefined, 10n, Symbol('s'),
            { valueOf() { throw new Error('boom'); } }, { [Symbol.toPrimitive]() { throw new Error('boom'); } }];
        for (let k = 0; k < rejects.length; k++) {
            const dt = rejects[k];
            let threw = null;
            let ret = true;
            try { ret = e.tick(dt); } catch (err) { threw = err; }
            check(threw === null,
                () => 'T4.D3: tick(' + String(dt) + ') must NOT throw (P-24 corpus), threw ' + threw);
            check(ret === false,
                () => 'T4.D3: tick(' + String(dt) + ') must return false, got ' + String(ret));
        }
        check(calls === 0,
            () => 'T4.D3: a rejected tick must NOT invoke the callback, callback ran ' + calls + ' times');

        // Accepted low-side boundary values -- 0, -0 and exactly maxDt all run.
        check(e.tick(0) === true, () => 'T4.D3: tick(0) must be accepted');
        check(e.tick(-0) === true, () => 'T4.D3: tick(-0) must be accepted');
        check(e.tick(e.maxDt) === true, () => 'T4.D3: tick(maxDt) must be accepted');
        check(calls === 3, () => 'T4.D3: three accepted ticks must invoke the callback 3 times, got ' + calls);

        // 1e9 is clamped to maxDt on the default engine.
        let seen = NaN;
        e.onTick(function (dt) { seen = dt; });
        e.tick(1e9);
        check(seen === e.maxDt, () => 'T4.D3: tick(1e9) must clamp to maxDt (' + e.maxDt + '), saw ' + seen);
        e.destroy();
    }

    // --- D3: with maxDt Infinity the high-side clamp is a no-op -- a large dt is
    // delivered unclamped, the fixed-step-accumulator contract.
    {
        const e = new SoaParticleEngine(4, { maxDt: Infinity });
        let seen = NaN;
        e.onTick(function (dt) { seen = dt; });
        check(e.tick(1e9) === true, () => 'T4.D3: tick(1e9) under maxDt:Infinity must be accepted');
        check(seen === 1e9, () => 'T4.D3: tick(1e9) under maxDt:Infinity must pass through unclamped, saw ' + seen);
        e.destroy();
    }

    // --- tick() after destroy() returns false and never throws, with no callback
    // invocation possible (the lanes are null).
    {
        const e = new SoaParticleEngine(4);
        let calls = 0;
        e.onTick(function () { calls++; });
        e.destroy();
        let threw = null;
        let ret = true;
        try { ret = e.tick(0.016); } catch (err) { threw = err; }
        check(threw === null, () => 'T4.D3: tick() after destroy() threw ' + threw);
        check(ret === false, () => 'T4.D3: tick() after destroy() must return false, got ' + String(ret));
        check(calls === 0, () => 'T4.D3: tick() after destroy() must not invoke the callback, calls=' + calls);
    }

    // --- P-28: start() twice, and the failed-start retry sequence. A first start()
    // with no RAF throws the named error and leaves the engine untouched; a second
    // start() AFTER a real RAF is installed must arm exactly one frame. On v1.0.5
    // this armed ZERO frames forever (the first start() set _isRunning before the
    // throw). Uses a private, isolated pump so the shared PUMP is unaffected.
    {
        const savedRaf = globalThis.requestAnimationFrame;
        const savedCaf = globalThis.cancelAnimationFrame;
        delete globalThis.requestAnimationFrame;
        delete globalThis.cancelAnimationFrame;
        const e = new SoaParticleEngine(4);
        let threw = null;
        try { e.start(); } catch (err) { threw = err; }
        check(threw instanceof TypeError, () => 'T4.P-28: the first start() with no RAF must throw a TypeError, got ' + threw);
        check(e._isRunning === false, () => 'T4.P-28: a failed start() must leave _isRunning false, got ' + e._isRunning);

        // Install a counting RAF and retry: exactly one frame armed.
        let rafCount = 0;
        globalThis.requestAnimationFrame = function () { rafCount++; return 1; };
        globalThis.cancelAnimationFrame = function () {};
        try {
            e.start();
        } finally {
            globalThis.requestAnimationFrame = savedRaf;
            globalThis.cancelAnimationFrame = savedCaf;
        }
        check(rafCount === 1, () => 'T4.P-28: the retried start() must arm exactly one RAF, got ' + rafCount);
        check(e._isRunning === true, () => 'T4.P-28: the retried start() must set _isRunning');
        // A second start() while running is idempotent -- no extra frame armed.
        globalThis.requestAnimationFrame = function () { rafCount++; return 1; };
        try { e.start(); } finally { globalThis.requestAnimationFrame = savedRaf; }
        check(rafCount === 1, () => 'T4.P-28: a second start() while running must be idempotent, armed ' + rafCount);
        e._isRunning = false; // drop the flag so destroy()/stop() do not touch the restored RAF
        e.destroy();
    }

    // --- D8: the clock is environment input. A poisoned clock reading (NaN or a
    // backwards time) must NOT advance _lastTime and must NOT invoke the callback,
    // and a subsequent VALID reading must produce a correct finite dt -- the engine
    // self-heals instead of dying permanently (P-28's shape through the clock door).
    {
        PUMP.reset();
        const e = new SoaParticleEngine(4);
        let last = NaN;
        let calls = 0;
        e.onTick(function (dt) { last = dt; calls++; });
        e._isRunning = true;
        e._lastTime = 100;

        // A NaN clock reading: rejected, _lastTime unchanged, callback uninvoked.
        e._loop(NaN);
        check(e._lastTime === 100, () => 'T4.D8: a NaN clock reading must not advance _lastTime, got ' + e._lastTime);
        check(calls === 0, () => 'T4.D8: a NaN clock reading must not invoke the callback, calls=' + calls);

        // A backwards clock reading: same -- rejected, no advance, no callback.
        e._loop(50);
        check(e._lastTime === 100, () => 'T4.D8: a backwards clock reading must not advance _lastTime, got ' + e._lastTime);
        check(calls === 0, () => 'T4.D8: a backwards clock reading must not invoke the callback, calls=' + calls);

        // A valid forward reading: dt is finite and correct, and the engine heals.
        e._loop(200);
        check(e._lastTime === 200, () => 'T4.D8: a valid reading must advance _lastTime to 200, got ' + e._lastTime);
        check(calls === 1, () => 'T4.D8: a valid reading after poison must invoke the callback once, calls=' + calls);
        check(last === 0.1, () => 'T4.D8: dt for a 100ms advance must be 0.1 (clamped from (200-100)/1000), got ' + last);
        e._isRunning = false;
        e.destroy();
    }
}
