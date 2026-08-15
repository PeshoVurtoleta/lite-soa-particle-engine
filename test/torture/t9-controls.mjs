/**
 * T9 -- controls. Every gate must be provably able to fail.
 *
 * This tier runs deliberately-broken variants IN PROCESS and asserts the
 * corresponding gate flags each one. If a control slips through, T9 fails the run
 * -- a gate that cannot fail is decorative. Each control also proves it is NOT
 * vacuous: it confirms the checker reports healthy on a valid input first.
 *
 * A control must not assert a behaviour the package does not have yet, so S1's
 * controls cover only the gates S1 actually wired: the alloc gate, the raw-mode
 * head invariant (T7), the per-lane byteLength pin (T6), and the lane-diff
 * backbone of T0's total-rejection law.
 *
 * The whole-suite control is separate: SOA_TORTURE_BREAK=1 injects retained
 * allocations into T6 and exits non-zero. T9 exercises the same alloc lane here
 * so a plain run already proves the gate bites.
 */

import { SoaParticleEngine } from '../../SoaParticleEngine.js';
import { runOpsGate, headInvariant, snapshotLaneBytes, die } from './harness.mjs';

/** Retained sink so the control's allocations survive GC (arrayBuffers grows). */
const leak = [];

export function run() {
    // Control 1 -- the alloc gate. A hot body that retains an allocation every
    // iteration MUST be rejected by runOpsGate (maxArrayBuffersGrowth:0). Proven
    // non-vacuous by control 1b below (a clean body passes the same gate).
    {
        const { report } = runOpsGate(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
        if (report.ok) die('T9 control: an allocating hot loop passed the zero-alloc gate');
        leak.length = 0; // release the control's garbage
    }

    // Control 1b -- the alloc gate is not a blanket reject. A zero-alloc body must
    // PASS, so control 1 is a real property and not a gate that fails on anything.
    {
        const e = new SoaParticleEngine(64);
        const clean = (i) => { e.emit(i & 63, 0, 1, -1, 0.5, i & 15); };
        const { report } = runOpsGate(clean, { ops: 8000, warmup: 500 });
        if (!report.ok) die('T9 control: a zero-alloc emit loop was rejected by the alloc gate (gate is not discriminating)');
        e.destroy();
    }

    // Control 2 -- the raw-mode head invariant (the T7 checker). Healthy first,
    // then each fabricated corruption must be caught.
    {
        const e = new SoaParticleEngine(8);
        e.emit(0, 0, 0, 0, 1);
        if (!headInvariant(e)) die('T9 control: head invariant false on a valid engine (checker is broken)');
        e._head = 1.5;
        if (headInvariant(e)) die('T9 control: head invariant held for a non-integer _head');
        e._head = e.max;
        if (headInvariant(e)) die('T9 control: head invariant held for _head === max (out of range)');
        e._head = -1;
        if (headInvariant(e)) die('T9 control: head invariant held for a negative _head');
        e._head = NaN;
        if (headInvariant(e)) die('T9 control: head invariant held for a NaN _head (the P-04 shape)');
        e.destroy();
    }

    // Control 3 -- the per-lane byteLength pin (the T6 structural assertion). The
    // equality that backs it must DETECT a changed size and PASS an unchanged one.
    {
        const e = new SoaParticleEngine(16);
        const before = new Float64Array(7);
        snapshotLaneBytes(e, before);
        // The x lane is unchanged -> the pin holds.
        if (e.x.buffer.byteLength !== before[0]) die('T9 control: byteLength pin reported a change on an untouched lane');
        // Fabricate a "before" that is one element larger -> the pin must flag it.
        before[0] += 4;
        if (e.x.buffer.byteLength === before[0]) die('T9 control: byteLength pin cannot detect a changed backing store');
        e.destroy();
    }

    // Control 4 -- the lane-diff backbone of T0's total-rejection law. An accepted
    // emit MUST change a lane cell, and a rejected emit MUST change nothing -- so
    // "byte-identical after a rejected emit" is a real property, not a no-op on an
    // engine that never changes.
    {
        const e = new SoaParticleEngine(4);
        const life0 = e.life[0];
        e.emit(1, 2, 3, 4, 1.5, 9);
        if (e.life[0] === life0) die('T9 control: an accepted emit did not change the life lane (the rejection law would be vacuous)');
        const snap = e.life[0];
        e.emit(NaN, 0, 0, 0, 1);          // rejected
        if (e.life[0] !== snap) die('T9 control: a rejected emit changed the life lane');
        if (e._head !== 1) die('T9 control: a rejected emit advanced the head');
        e.destroy();
    }
}
