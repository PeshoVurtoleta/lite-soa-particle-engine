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
import { check } from './harness.mjs';

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
}
