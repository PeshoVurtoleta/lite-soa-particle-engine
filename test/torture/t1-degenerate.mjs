/**
 * T1 -- degenerate values across every entry point.
 *
 * S1 fixes NOTHING, so this tier PINS the current (buggy) behaviour of the
 * degenerate inputs, each pin naming its finding ID and the session that changes
 * it. A pin like "this returns NaN today, S2 changes it" is a valid contract;
 * leaving it unpinned is not. When S2 lands, these pins are the visible diff.
 */

import { SoaParticleEngine } from '../../SoaParticleEngine.js';
import { check } from './harness.mjs';

export function run() {
    // --- Constructor (P-03): four silent-garbage outcomes + two allocator throws.
    // Current behaviour; S2 adds validation that throws a library error for each
    // non-(positive integer) argument.
    {
        const zero = new SoaParticleEngine(0);
        check(zero.max === 0 && zero.x.length === 0,
            () => 'T1.ctor(0): P-03 pin -- expected max 0 / length 0, got ' + zero.max + ' / ' + zero.x.length);
        zero.destroy();

        const frac = new SoaParticleEngine(2.5);
        check(frac.max === 2.5 && frac.x.length === 2,
            () => 'T1.ctor(2.5): P-03 pin -- expected max 2.5 / length 2, got ' + frac.max + ' / ' + frac.x.length);
        frac.destroy();

        const nan = new SoaParticleEngine(NaN);
        check(Number.isNaN(nan.max) && nan.x.length === 0,
            () => 'T1.ctor(NaN): P-03 pin -- expected NaN max / length 0, got ' + nan.max + ' / ' + nan.x.length);
        nan.destroy();

        const str = new SoaParticleEngine('10');
        check(typeof str.max === 'string' && str.max === '10' && str.x.length === 10,
            () => 'T1.ctor("10"): P-03 pin -- expected string max "10" / length 10, got ' +
                typeof str.max + ' ' + str.max + ' / ' + str.x.length);
        str.destroy();

        const nul = new SoaParticleEngine(null);
        check(nul.max === null && nul.x.length === 0,
            () => 'T1.ctor(null): P-03 pin -- expected null max / length 0, got ' + nul.max + ' / ' + nul.x.length);
        nul.destroy();

        const def = new SoaParticleEngine(undefined);
        check(def.max === 1000 && def.x.length === 1000,
            () => 'T1.ctor(undefined): default pin -- expected max 1000 / length 1000, got ' + def.max + ' / ' + def.x.length);
        def.destroy();

        // Raw allocator throws (P-03): a negative or infinite length surfaces as a
        // bare RangeError today (S2 replaces them with a named library error).
        // 2**31 and Number.MAX_SAFE_INTEGER are deliberately NOT crossed here: the
        // former reserves ~8GB of virtual pages instead of throwing on machines
        // with the address space, so its outcome is memory-dependent. S2's
        // constructor validation pins those against a documented ceiling.
        for (const bad of [-1, Infinity]) {
            let threw = false;
            try { new SoaParticleEngine(bad); } catch { threw = true; }
            check(threw, () => 'T1.ctor(' + bad + '): P-03 pin -- expected a throw from the allocator');
        }
    }

    // --- P-04: emit into a zero-length engine sets _head to NaN, permanently, and
    // every later emit is a silent no-op. Pinned; S2 makes the constructor throw,
    // so this sequence becomes unreachable.
    {
        const z = new SoaParticleEngine(0);
        z.emit(1, 1, 0, 0, 1);
        check(Number.isNaN(z._head),
            () => 'T1.P-04 pin: _head expected NaN after emit into a 0-length engine, got ' + z._head);
        z.emit(2, 2, 0, 0, 1);
        check(Number.isNaN(z._head),
            () => 'T1.P-04 pin: _head expected still-NaN after a second emit, got ' + z._head);
        z.destroy();
    }

    // --- life boundary (P-05): the precision floor below which invLife becomes
    // Infinity and the documented alpha (life*invLife) becomes NaN. Rejections
    // (non-finite / <= 0) leave the engine byte-identical. Pinned; S2 rejects
    // sub-floor life too.
    {
        const emitLife = (life) => {
            const e = new SoaParticleEngine(4);
            e.emit(0, 0, 0, 0, life, 3);
            return e;
        };

        // Rejected: head unchanged, slot 0 still zero.
        for (const life of [Infinity, NaN, 0, -0, -1]) {
            const e = emitLife(life);
            check(e._head === 0 && e.life[0] === 0,
                () => 'T1.life(' + life + '): expected rejection (head 0, life 0), got head ' + e._head + ' life ' + e.life[0]);
            e.destroy();
        }

        // 1e-46: accepted, but life rounds to 0 and invLife overflows to Infinity
        // -> alpha is NaN. The exact P-05 reproduction.
        {
            const e = emitLife(1e-46);
            check(e._head === 1, () => 'T1.life(1e-46): P-05 pin -- expected accepted (head 1), got head ' + e._head);
            check(e.life[0] === 0, () => 'T1.life(1e-46): P-05 pin -- expected life 0, got ' + e.life[0]);
            check(e.invLife[0] === Infinity, () => 'T1.life(1e-46): P-05 pin -- expected invLife Infinity, got ' + e.invLife[0]);
            check(Number.isNaN(e.life[0] * e.invLife[0]),
                () => 'T1.life(1e-46): P-05 pin -- expected alpha NaN, got ' + (e.life[0] * e.invLife[0]));
            e.destroy();
        }

        // 1e-40: subnormal life, invLife still overflows to Infinity.
        {
            const e = emitLife(1e-40);
            check(e.invLife[0] === Infinity, () => 'T1.life(1e-40): P-05 pin -- expected invLife Infinity, got ' + e.invLife[0]);
            e.destroy();
        }

        // 1e-30: above the floor -- invLife is finite and alpha is well-defined.
        {
            const e = emitLife(1e-30);
            check(Number.isFinite(e.invLife[0]) && e.invLife[0] > 0,
                () => 'T1.life(1e-30): expected finite invLife, got ' + e.invLife[0]);
            e.destroy();
        }

        // life = 1: the trivial case, invLife exactly 1.
        {
            const e = emitLife(1);
            check(e.invLife[0] === 1, () => 'T1.life(1): expected invLife 1, got ' + e.invLife[0]);
            e.destroy();
        }

        // life = 3.4e38 (~f32 max): accepted, invLife finite (subnormal).
        {
            const e = emitLife(3.4e38);
            check(Number.isFinite(e.invLife[0]) && e.invLife[0] > 0,
                () => 'T1.life(3.4e38): expected finite invLife, got ' + e.invLife[0]);
            e.destroy();
        }
    }

    // --- dataFlag (P-06): four silent coercions through the Int32Array. Pinned;
    // S2 adds a dataFlag policy.
    {
        const emitFlag = (flag) => {
            const e = new SoaParticleEngine(4);
            e.emit(0, 0, 0, 0, 1, flag);
            return e;
        };
        const cases = [
            [3.7, 3, 'truncated'],
            [2 ** 31, -2147483648, 'wrapped'],
            [-1, -1, 'passthrough'],
            [NaN, 0, 'NaN->0'],
            ['x', 0, 'string->0'],
            [null, 0, 'null->0'],
        ];
        for (const [flag, expected, why] of cases) {
            const e = emitFlag(flag);
            check(e.data[0] === expected,
                () => 'T1.dataFlag(' + String(flag) + '): P-06 pin (' + why + ') expected ' + expected + ', got ' + e.data[0]);
            e.destroy();
        }
        // omitted dataFlag defaults to 0.
        {
            const e = new SoaParticleEngine(4);
            e.emit(0, 0, 0, 0, 1);
            check(e.data[0] === 0, () => 'T1.dataFlag(omitted): expected default 0, got ' + e.data[0]);
            e.destroy();
        }
    }

    // --- dt into the frame path (P-02): the "cap" fabricates a fixed 0.016 frame
    // for ANY gap > 100ms instead of clamping. Pinned; S2 replaces it with a real
    // maxDt clamp.
    {
        const dtOf = (gapMs) => {
            let dt = NaN;
            const e = new SoaParticleEngine(4);
            e.onTick((d) => { dt = d; });
            e._isRunning = true;
            e._lastTime = 0;
            e._loop(gapMs);
            e.destroy();
            return dt;
        };

        // Gaps <= 100ms pass through unchanged.
        check(dtOf(0) === 0, () => 'T1.dt(0ms): expected 0, got ' + dtOf(0));
        check(Math.abs(dtOf(99.9) - 0.0999) < 1e-9, () => 'T1.dt(99.9ms): expected 0.0999, got ' + dtOf(99.9));
        check(Math.abs(dtOf(100) - 0.1) < 1e-9, () => 'T1.dt(100ms): expected 0.1, got ' + dtOf(100));
        check(Math.abs(dtOf(-1) - -0.001) < 1e-9, () => 'T1.dt(-1ms): expected -0.001, got ' + dtOf(-1));

        // Gaps > 100ms are ALL fabricated to exactly 0.016 (P-02).
        for (const gap of [100.1, 101, 200, 5000]) {
            check(dtOf(gap) === 0.016,
                () => 'T1.dt(' + gap + 'ms): P-02 pin -- expected fabricated 0.016, got ' + dtOf(gap));
        }

        // A NaN timestamp yields NaN dt (NaN > 0.1 is false); Infinity yields 0.016.
        check(Number.isNaN(dtOf(NaN)), () => 'T1.dt(NaN): P-02 pin -- expected NaN dt, got ' + dtOf(NaN));
        check(dtOf(Infinity) === 0.016, () => 'T1.dt(Infinity): P-02 pin -- expected 0.016, got ' + dtOf(Infinity));
    }
}
