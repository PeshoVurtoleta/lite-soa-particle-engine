/**
 * T1 -- degenerate values across every entry point.
 *
 * S2 lands the door policy (decisions/0002-the-door.md): the constructor throws a
 * named library error for every argument that is not a valid positive integer in
 * [1, MAX_PARTICLES], emit() silently rejects any out-of-band life or non-int32
 * dataFlag before touching a lane, and the frame loop clamps dt to maxDt instead
 * of fabricating a 0.016 frame. This tier PINS that contract, each pin naming its
 * finding ID -- the inversion of the S1 pins is the visible diff of this session.
 */

import { SoaParticleEngine, MAX_PARTICLES, LIFE_MIN, LIFE_MAX, LANE_MAX } from '../../SoaParticleEngine.js';
import { check } from './harness.mjs';

export function run() {
    // --- Constructor (P-03 + P-18): every non-(positive integer in [1, ceiling])
    // argument throws a library error naming the package and the argument. Never
    // the bare "RangeError: Invalid typed array length" the allocator produces.
    {
        // TypeError (not a number) and RangeError (a number outside the legal set)
        // both carry the identifying prefix and name the argument.
        for (const bad of [0, 2.5, NaN, '10', null, -1, Infinity]) {
            let msg = null;
            try { new SoaParticleEngine(bad); } catch (err) { msg = String(err && err.message); }
            check(msg !== null && msg.indexOf('SoaParticleEngine:') !== -1 && msg.indexOf('maxParticles') !== -1,
                () => 'T1.ctor(' + String(bad) + '): P-03 contract -- expected a named library throw ' +
                    'mentioning SoaParticleEngine: and maxParticles, got message ' + msg);
        }

        // undefined -> the documented default of 1000.
        const def = new SoaParticleEngine(undefined);
        check(def.max === 1000 && def.x.length === 1000,
            () => 'T1.ctor(undefined): default pin -- expected max 1000 / length 1000, got ' + def.max + ' / ' + def.x.length);
        def.destroy();

        // P-18 ceiling: MAX_PARTICLES + 1 throws. The POSITIVE case (constructing
        // MAX_PARTICLES lanes, 470 MB) is NOT allocated here -- it is proven by
        // test/bench-ceiling.mjs, criteria C1..C7. Allocating it in the torture run
        // would cost 470 MB for a fact already gated elsewhere.
        {
            let msg = null;
            try { new SoaParticleEngine(MAX_PARTICLES + 1); } catch (err) { msg = String(err && err.message); }
            check(msg !== null && msg.indexOf('SoaParticleEngine:') !== -1 && msg.indexOf('maxParticles') !== -1,
                () => 'T1.ctor(MAX_PARTICLES + 1): P-18 contract -- expected a named library throw, got message ' + msg);
        }
    }

    // --- P-04: dead by construction. new SoaParticleEngine(0) throws (asserted
    // above), so the old NaN-_head sequence -- emit into a zero-length engine sets
    // _head to NaN permanently -- is now UNREACHABLE. A validated max makes
    // (i + 1) % max total; nothing can drive _head to NaN. This block only
    // re-asserts the throw so the "unreachable" claim is anchored to a test.
    {
        let threw = false;
        try { new SoaParticleEngine(0); } catch { threw = true; }
        check(threw, () => 'T1.P-04: new SoaParticleEngine(0) must throw; the NaN-_head sequence is dead by construction');
    }

    // --- life band (P-05 low end, P-17 high end): emit() accepts life only in
    // [LIFE_MIN, LIFE_MAX]. Out-of-band life is rejected BEFORE any lane write, so
    // head stays 0 and every lane stays 0. The two measured boundary values behave
    // exactly as decisions/0002-the-door.md records.
    {
        const emitLife = (life) => {
            const e = new SoaParticleEngine(4);
            e.emit(0, 0, 0, 0, life);
            return e;
        };

        // Rejected: NaN and Infinity (the load-bearing property of the single
        // range test -- a De Morgan "simplification" to life < LIFE_MIN ||
        // life > LIFE_MAX would ACCEPT NaN and poison the lanes; this pin catches
        // it), then sub-floor (P-05), over-max (P-17), and the two values that sit
        // one f32 step OUTSIDE each measured boundary. Lanes byte-identical after.
        //   2.9387359646368754e-39 : one f32 step below LIFE_MIN (invLife -> Inf)
        //   3.4028235677973366e+38 : one f32 step above LIFE_MAX (life -> Inf)
        for (const life of [NaN, Infinity, 1e-46, 1e-40, 1e39, 1e300, 2.9387359646368754e-39, 3.4028235677973366e+38]) {
            const e = emitLife(life);
            check(e._head === 0 && e.life[0] === 0 && e.invLife[0] === 0 && e.data[0] === 0,
                () => 'T1.life(' + life + '): P-05/P-17 contract -- out-of-band life rejected, lanes untouched, got head ' +
                    e._head + ' life ' + e.life[0] + ' invLife ' + e.invLife[0]);
            e.destroy();
        }

        // LIFE_MIN: accepted, invLife finite (exactly f32 max). alpha within the
        // measured tolerance -- 2 ** -22, NOT 2 ** -23 (which is below the worst
        // case measured in the subnormal region and would fail on legal input).
        {
            const e = emitLife(LIFE_MIN);
            check(e._head === 1, () => 'T1.life(LIFE_MIN): expected accepted (head 1), got head ' + e._head);
            check(Number.isFinite(e.invLife[0]) && e.invLife[0] > 0,
                () => 'T1.life(LIFE_MIN): expected finite positive invLife, got ' + e.invLife[0]);
            check(Math.abs(e.life[0] * e.invLife[0] - 1) <= 2 ** -22,
                () => 'T1.life(LIFE_MIN): alpha out of tolerance, got ' + (e.life[0] * e.invLife[0]));
            e.destroy();
        }

        // LIFE_MAX: accepted, life stored as a finite f32.
        {
            const e = emitLife(LIFE_MAX);
            check(e._head === 1 && Number.isFinite(e.life[0]) && e.life[0] > 0,
                () => 'T1.life(LIFE_MAX): expected accepted with finite life, got head ' + e._head + ' life ' + e.life[0]);
            check(Math.abs(e.life[0] * e.invLife[0] - 1) <= 2 ** -22,
                () => 'T1.life(LIFE_MAX): alpha out of tolerance, got ' + (e.life[0] * e.invLife[0]));
            e.destroy();
        }

        // life = 1: the trivial case, invLife exactly 1, alpha exactly 1.
        {
            const e = emitLife(1);
            check(e.invLife[0] === 1, () => 'T1.life(1): expected invLife 1, got ' + e.invLife[0]);
            check(Math.abs(e.life[0] * e.invLife[0] - 1) <= 2 ** -22,
                () => 'T1.life(1): alpha out of tolerance, got ' + (e.life[0] * e.invLife[0]));
            e.destroy();
        }
    }

    // --- position/velocity band (P-19): x/y/vx/vy share the SYMMETRIC f32 band
    // [-LANE_MAX, LANE_MAX]. Out-of-band values are rejected BEFORE any lane
    // write, so head stays 0 and every lane stays 0. Each of the four lanes is
    // exercised INDEPENDENTLY -- a guard that checks x but forgets vy must fail
    // here. Unlike the one-sided `life` band this one has NO floor: 0, -0,
    // ordinary negatives and subnormals are all accepted. LANE_MAX and the value
    // one f32 step past it are the bisection-measured pair from
    // decisions/0002-the-door.md, not literals anyone typed.
    {
        const OVER = 3.4028235677973366e+38; // one f32 step past LANE_MAX -> f32 Infinity
        const SUB = 1.4e-45;                  // smallest positive f32 subnormal
        const laneName = ['x', 'y', 'vx', 'vy'];

        // Emit `value` in exactly one of the four position/velocity slots; every
        // other argument legal (life 1, flag 0).
        const emitLane = (li, value) => {
            const e = new SoaParticleEngine(4);
            const a = [0, 0, 0, 0, 1, 0];
            a[li] = value;
            e.emit(a[0], a[1], a[2], a[3], a[4], a[5]);
            return e;
        };

        for (let li = 0; li < 4; li++) {
            // Rejected: NaN, +/-Infinity, and the first value PAST each endpoint.
            for (const value of [NaN, Infinity, -Infinity, OVER, -OVER]) {
                const e = emitLane(li, value);
                check(e._head === 0 && e.x[0] === 0 && e.y[0] === 0 && e.vx[0] === 0 && e.vy[0] === 0,
                    () => 'T1.band(' + laneName[li] + '=' + value + '): P-19 contract -- out-of-band rejected, ' +
                        'lanes untouched, got head ' + e._head + ' x ' + e.x[0] + ' y ' + e.y[0] +
                        ' vx ' + e.vx[0] + ' vy ' + e.vy[0]);
                e.destroy();
            }

            // Accepted: both measured endpoints store as a finite f32 (NOT Infinity).
            for (const value of [LANE_MAX, -LANE_MAX]) {
                const e = emitLane(li, value);
                check(e._head === 1 && e[laneName[li]][0] === Math.fround(value) && Number.isFinite(e[laneName[li]][0]),
                    () => 'T1.band(' + laneName[li] + '=' + value + '): P-19 contract -- measured endpoint must be ' +
                        'accepted and finite, got head ' + e._head + ' stored ' + e[laneName[li]][0]);
                e.destroy();
            }

            // Accepted with NO floor: 0, -0, an ordinary negative, and both signs
            // of the smallest f32 subnormal. Copying the one-sided life test would
            // reject these -- that is the known-wrong implementation, pinned here.
            for (const value of [0, -0, -12345.678, SUB, -SUB]) {
                const e = emitLane(li, value);
                check(e._head === 1 && e[laneName[li]][0] === Math.fround(value),
                    () => 'T1.band(' + laneName[li] + '=' + value + '): P-19 contract -- no-floor value must be ' +
                        'accepted, got head ' + e._head + ' stored ' + e[laneName[li]][0]);
                e.destroy();
            }
        }

        // Non-number corpus (P-23): relational operators COERCE, so null -> 0,
        // "5" -> 5, [7] -> 7, true -> 1 would be laundered into a lane without the
        // typeof half of the guard. Every one is rejected by v1.0.4's isFinite and
        // must STILL be rejected -- on all four position/velocity lanes AND on life
        // (li 4), which carried the identical hole since v1.0.4. A guard that drops
        // typeof on any one lane fails here.
        const laneName5 = ['x', 'y', 'vx', 'vy', 'life'];
        for (let li = 0; li <= 4; li++) {
            for (const value of [null, '5', '', false, true, [], [7], undefined, {}]) {
                const e = emitLane(li, value);
                check(e._head === 0 && e.x[0] === 0 && e.y[0] === 0 && e.vx[0] === 0 &&
                    e.vy[0] === 0 && e.life[0] === 0,
                    () => 'T1.band(' + laneName5[li] + '=' + String(value) + '): P-23 contract -- coerced ' +
                        'non-number must be rejected by the typeof guard, got head ' + e._head +
                        ' x ' + e.x[0] + ' vx ' + e.vx[0] + ' life ' + e.life[0]);
                e.destroy();
            }
        }

        // The P-19 headline, measured against shipped v1.0.4: under the old
        // Number.isFinite guard this ACCEPTED and stored Infinity into x and vx.
        // The band rejects it: head unmoved, x and vx untouched.
        {
            const e = new SoaParticleEngine(4);
            e.emit(1e300, 0, 1e300, 0, 1);
            check(e._head === 0 && e.x[0] === 0 && e.vx[0] === 0,
                () => 'T1.band headline: emit(1e300,0,1e300,0,1) must be rejected, got head ' +
                    e._head + ' x ' + e.x[0] + ' vx ' + e.vx[0]);
            e.destroy();
        }
    }

    // --- dataFlag (P-06): validated at the door. Only an exact int32
    // ((flag | 0) === flag) is accepted; anything else is rejected before any lane
    // write, so head stays 0 and data[0] stays 0. 0 is the default and a legal id.
    {
        const emitFlag = (flag) => {
            const e = new SoaParticleEngine(4);
            e.emit(0, 0, 0, 0, 1, flag);
            return e;
        };

        // Rejected: fraction, out-of-int32-range, NaN, string, null.
        for (const flag of [3.7, 2 ** 31, NaN, 'x', null]) {
            const e = emitFlag(flag);
            check(e._head === 0 && e.data[0] === 0,
                () => 'T1.dataFlag(' + String(flag) + '): P-06 contract -- non-int32 flag rejected, got head ' +
                    e._head + ' data ' + e.data[0]);
            e.destroy();
        }

        // Accepted: -1 and 0 store exactly and advance the head.
        for (const flag of [-1, 0]) {
            const e = emitFlag(flag);
            check(e._head === 1 && e.data[0] === flag,
                () => 'T1.dataFlag(' + flag + '): P-06 contract -- valid int32 accepted, got head ' +
                    e._head + ' data ' + e.data[0]);
            e.destroy();
        }

        // Omitted dataFlag defaults to 0 and is accepted.
        {
            const e = new SoaParticleEngine(4);
            e.emit(0, 0, 0, 0, 1);
            check(e._head === 1 && e.data[0] === 0,
                () => 'T1.dataFlag(omitted): expected default 0 accepted, got head ' + e._head + ' data ' + e.data[0]);
            e.destroy();
        }
    }

    // --- dt into the frame path (P-02): the loop now CLAMPS to maxDt instead of
    // fabricating a fixed 0.016 frame for any gap > 100ms. A clamped frame loses
    // the excess time by design. S3/D8: _loop() also validates the clock reading
    // (`typeof time === 'number' && time >= _lastTime`) and does NOT advance
    // _lastTime or invoke the callback on a bad reading -- so a backwards or NaN
    // clock self-heals instead of poisoning _lastTime permanently.
    {
        const dtOf = (gapMs, opts) => {
            let dt = NaN;
            const e = new SoaParticleEngine(4, opts);
            e.onTick((d) => { dt = d; });
            e._isRunning = true;
            e._lastTime = 0;
            e._loop(gapMs);
            e.destroy();
            return dt;
        };

        // Gaps <= 100ms (the default maxDt) pass through unchanged.
        check(dtOf(0) === 0, () => 'T1.dt(0ms): expected 0, got ' + dtOf(0));
        check(Math.abs(dtOf(99.9) - 0.0999) < 1e-9, () => 'T1.dt(99.9ms): expected 0.0999, got ' + dtOf(99.9));
        check(Math.abs(dtOf(100) - 0.1) < 1e-9, () => 'T1.dt(100ms): expected 0.1, got ' + dtOf(100));
        // FLIPPED (D8): a backwards clock reading (time < _lastTime) is now
        // REJECTED -- the callback is not invoked, so dt is never assigned and
        // stays NaN. v1.0.5 passed the raw -0.001 through ("negative untouched").
        check(Number.isNaN(dtOf(-1)), () => 'T1.dt(-1ms): D8 -- a backwards clock reading is rejected, callback not invoked, got ' + dtOf(-1));

        // Gaps > maxDt are clamped to EXACTLY maxDt (0.1), never fabricated to 0.016.
        for (const gap of [100.1, 101, 200, 5000]) {
            check(dtOf(gap) === 0.1,
                () => 'T1.dt(' + gap + 'ms): P-02 contract -- expected clamp to 0.1, got ' + dtOf(gap));
            check(dtOf(gap) !== 0.016,
                () => 'T1.dt(' + gap + 'ms): P-02 contract -- must NOT fabricate 0.016, got ' + dtOf(gap));
        }

        // The maxDt option is honoured: a custom clamp of 0.25 clamps a 300ms gap
        // (0.3s, over the clamp) to 0.25, while a 50ms gap (under it) passes
        // through unchanged as 0.05.
        check(dtOf(300, { maxDt: 0.25 }) === 0.25,
            () => 'T1.dt(300ms, maxDt 0.25): expected clamp to 0.25, got ' + dtOf(300, { maxDt: 0.25 }));
        check(Math.abs(dtOf(50, { maxDt: 0.25 }) - 0.05) < 1e-9,
            () => 'T1.dt(50ms, maxDt 0.25): under the clamp, expected 0.05, got ' + dtOf(50, { maxDt: 0.25 }));

        // A NaN timestamp yields NaN dt -- but now because D8's `time >= _lastTime`
        // gate REJECTS it (NaN >= 0 is false), so the callback is not invoked,
        // rather than the old reason (NaN reaching the clamp, NaN > maxDt false).
        // Infinity is a valid forward reading (Infinity >= 0), so dt = Infinity
        // reaches tick() and clamps to 0.1 (Infinity > 0.1 is true).
        check(Number.isNaN(dtOf(NaN)), () => 'T1.dt(NaN): D8 -- a NaN clock reading is rejected, callback not invoked, got ' + dtOf(NaN));
        check(dtOf(Infinity) === 0.1, () => 'T1.dt(Infinity): P-02 contract -- expected clamp to 0.1, got ' + dtOf(Infinity));
    }
}
