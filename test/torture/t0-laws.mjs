/**
 * T0 -- emit/tick algebra. Metamorphic properties that must hold for ANY in-scope
 * input, checked over a seeded corpus. These pin the CURRENT (v1.0.3) behaviour;
 * S1 fixes nothing, so the corpus deliberately stays inside the domain where the
 * current code is already correct:
 *
 *   - values are finite,
 *   - life is above the P-05 precision floor (sub-floor life is T1's job),
 *   - max is a valid positive integer (degenerate max is T1's job).
 *
 * The laws: write locality, head advance, total rejection, exact round-trip, the
 * birth-alpha bound, the clear law, and destroy idempotence.
 */

import { SoaParticleEngine } from '../../SoaParticleEngine.js';
import { makePrng, SEED, check } from './harness.mjs';

const MAX = 64;
const N = 4000;            // emit attempts
const ALPHA_TOL = 1e-6;    // f32 rounding slack on birth alpha (life*invLife ~ 1)

export function run() {
    const prng = makePrng(SEED);
    const engine = new SoaParticleEngine(MAX);

    // Shadow lanes, allocated once. A law never allocates per op.
    const sx = new Float32Array(MAX);
    const sy = new Float32Array(MAX);
    const svx = new Float32Array(MAX);
    const svy = new Float32Array(MAX);
    const slife = new Float32Array(MAX);
    const sinv = new Float32Array(MAX);
    const sdata = new Int32Array(MAX);

    const snapshot = () => {
        sx.set(engine.x); sy.set(engine.y); svx.set(engine.vx); svy.set(engine.vy);
        slife.set(engine.life); sinv.set(engine.invLife); sdata.set(engine.data);
    };
    // First slot (other than `skip`) that differs from the shadow, or -1.
    const firstDiffExcept = (skip) => {
        for (let i = 0; i < MAX; i++) {
            if (i === skip) continue;
            if (engine.x[i] !== sx[i] || engine.y[i] !== sy[i] ||
                engine.vx[i] !== svx[i] || engine.vy[i] !== svy[i] ||
                engine.life[i] !== slife[i] || engine.invLife[i] !== sinv[i] ||
                engine.data[i] !== sdata[i]) return i;
        }
        return -1;
    };

    for (let op = 0; op < N; op++) {
        const r = prng();
        const head0 = engine._head;
        snapshot();

        // ~1 in 4 attempts is a deliberate rejection. The corpus covers every
        // rejection cause: non-finite x/y/vx/vy, the P-19 out-of-band f32 lane
        // values (finite f64 that overflows the f32 lane, exercised independently
        // per lane), the P-23 coerced non-numbers (which relational operators
        // would launder into a lane without the typeof guard) on position AND life
        // lanes, life <= 0, and life < 0. Each must leave the engine bit-for-bit
        // unchanged.
        if ((r & 3) === 0) {
            const kind = (r >>> 2) % 13;
            if (kind === 0) engine.emit(NaN, 0, 0, 0, 1);
            else if (kind === 1) engine.emit(0, Infinity, 0, 0, 1);
            else if (kind === 2) engine.emit(0, 0, NaN, 0, 1);
            else if (kind === 3) engine.emit(0, 0, 0, 0, 0);   // life <= 0
            else if (kind === 4) engine.emit(0, 0, 0, 0, -1);  // life < 0
            else if (kind === 5) engine.emit(1e300, 0, 0, 0, 1);                 // P-19: x out of f32 band
            else if (kind === 6) engine.emit(0, 0, 0, 1e300, 1);                 // P-19: vy out of f32 band (independent lane)
            else if (kind === 7) engine.emit(0, 0, 3.4028235677973366e+38, 0, 1); // P-19: vx one f32 step past LANE_MAX
            else if (kind === 8) engine.emit(null, 0, 0, 0, 1);                  // P-23: null coerces to 0 -- typeof rejects
            else if (kind === 9) engine.emit(0, '5', 0, 0, 1);                   // P-23: numeric string in y
            else if (kind === 10) engine.emit(0, 0, 0, [7], 1);                  // P-23: array in vy
            else if (kind === 11) engine.emit(0, 0, 0, 0, '1');                  // P-23: string laundered into life=1 by v1.0.4
            else engine.emit(0, 0, 0, 0, true);                                  // P-23: boolean life

            // Rejection is total: head unchanged AND every lane byte-identical.
            check(engine._head === head0,
                () => 'T0.reject: head moved on a rejected emit (seed=' + SEED + ' op=' + op + ')');
            check(firstDiffExcept(-1) === -1,
                () => 'T0.reject: a rejected emit mutated a lane (seed=' + SEED + ' op=' + op + ')');
            continue;
        }

        // An accepted emit: safe finite values, life above the precision floor.
        const x = ((r >>> 2) % 4000) - 2000;
        const y = ((r >>> 5) % 4000) - 2000;
        const vx = ((r >>> 8) % 800) - 400;
        const vy = ((r >>> 11) % 800) - 400;
        const life = 0.05 + ((r >>> 14) % 500) / 100; // [0.05, 5.04]
        const flag = (r >>> 20) % 1000;

        engine.emit(x, y, vx, vy, life, flag);

        // Head advance: exactly one slot forward, mod max.
        check(engine._head === (head0 + 1) % MAX,
            () => 'T0.head: head ' + head0 + ' -> ' + engine._head +
                ' expected ' + ((head0 + 1) % MAX) + ' (seed=' + SEED + ' op=' + op + ')');

        // Write locality: only slot head0 changed.
        const diff = firstDiffExcept(head0);
        check(diff === -1,
            () => 'T0.locality: emit also changed slot ' + diff + ' (wrote ' + head0 +
                ') (seed=' + SEED + ' op=' + op + ')');

        // Round-trip: each lane reads back the exact f32/i32 rounding of the input.
        check(engine.x[head0] === Math.fround(x), () => 'T0.roundtrip: x (seed=' + SEED + ' op=' + op + ')');
        check(engine.y[head0] === Math.fround(y), () => 'T0.roundtrip: y (seed=' + SEED + ' op=' + op + ')');
        check(engine.vx[head0] === Math.fround(vx), () => 'T0.roundtrip: vx (seed=' + SEED + ' op=' + op + ')');
        check(engine.vy[head0] === Math.fround(vy), () => 'T0.roundtrip: vy (seed=' + SEED + ' op=' + op + ')');
        check(engine.life[head0] === Math.fround(life), () => 'T0.roundtrip: life (seed=' + SEED + ' op=' + op + ')');
        check(engine.invLife[head0] === Math.fround(1 / life), () => 'T0.roundtrip: invLife (seed=' + SEED + ' op=' + op + ')');
        check(engine.data[head0] === (flag | 0), () => 'T0.roundtrip: data (seed=' + SEED + ' op=' + op + ')');

        // Birth-alpha law: normalized progress at birth is finite and in [0,1]
        // within f32 slack. This is the executable form of P-05 -- an invLife of
        // Infinity (life below the floor) would make it NaN. The corpus stays
        // above the floor, so the current code satisfies it. Sub-floor life is
        // pinned in T1.
        const alpha = engine.life[head0] * engine.invLife[head0];
        check(Number.isFinite(alpha) && alpha >= -ALPHA_TOL && alpha <= 1 + ALPHA_TOL,
            () => 'T0.alpha: birth alpha ' + alpha + ' out of [0,1] (seed=' + SEED + ' op=' + op + ')');
    }

    // =====================================================================
    // tick(dt) laws (S3). Two properties, on fresh engines so the emit corpus
    // above is untouched.
    // =====================================================================

    // Law A -- a REJECTED tick leaves all seven lanes byte-identical AND does not
    // invoke the callback. The callback here MUTATES every lane, so if it ran even
    // once on a rejected dt the byte-identity check would catch it -- but a counter
    // is asserted too, because a callback that ran and then exactly restored the
    // lanes would fool the lanes alone.
    {
        const e = new SoaParticleEngine(MAX);
        for (let i = 0; i < MAX; i++) e.emit(i - 32, i + 1, i & 7, -(i & 7), 0.5 + (i & 3) * 0.1, i);
        let tickCalls = 0;
        e.onTick(function (dt, x, y, vx, vy, life) {
            tickCalls++;
            for (let s = 0; s < MAX; s++) { x[s] += 1; y[s] -= 1; vx[s] += dt; life[s] -= dt; }
        });
        const bx = new Float32Array(MAX), by = new Float32Array(MAX);
        const bvx = new Float32Array(MAX), bvy = new Float32Array(MAX);
        const bl = new Float32Array(MAX), bi = new Float32Array(MAX);
        const bd = new Int32Array(MAX);
        bx.set(e.x); by.set(e.y); bvx.set(e.vx); bvy.set(e.vy); bl.set(e.life); bi.set(e.invLife); bd.set(e.data);

        const rejects = [NaN, -1, '0.05', true, [0.05], null, undefined, 10n, Symbol('s'),
            { valueOf() { throw new Error('boom'); } }];
        for (let k = 0; k < rejects.length; k++) {
            const ret = e.tick(rejects[k]);
            check(ret === false, () => 'T0.tick.reject: tick(' + String(rejects[k]) + ') returned ' + String(ret) + ' not false (seed=' + SEED + ')');
        }
        check(tickCalls === 0, () => 'T0.tick.reject: a rejected tick invoked the callback ' + tickCalls + ' times (seed=' + SEED + ')');
        for (let s = 0; s < MAX; s++) {
            check(e.x[s] === bx[s] && e.y[s] === by[s] && e.vx[s] === bvx[s] && e.vy[s] === bvy[s] &&
                e.life[s] === bl[s] && e.invLife[s] === bi[s] && e.data[s] === bd[s],
                () => 'T0.tick.reject: a rejected tick mutated lane slot ' + s + ' (seed=' + SEED + ')');
        }
        e.destroy();
    }

    // Law B -- tick additivity for CONSTANT-VELOCITY integration (no gravity, no
    // drag): tick(a); tick(b) equals tick(a+b) within an f32 tolerance. R7: this
    // needs a gravity-free body -- with gravity, vy changes between sub-steps and
    // the split integral no longer equals the single one, so the law is asserted
    // over its own physics, never over the gravity corpus above.
    {
        const TICK_TOL = 1e-4; // f32 slack over a constant-velocity step
        const A = 0.02, B = 0.03; // A + B = 0.05 <= maxDt, so no clamp differs
        const integrate = function (dt, x, y, vx, vy, life, invLife, data, max) {
            for (let s = 0; s < max; s++) {
                if (life[s] <= 0) continue;
                x[s] += vx[s] * dt;   // constant velocity -- vx/vy are NOT modified
                y[s] += vy[s] * dt;
                life[s] -= dt;
            }
        };
        const split = new SoaParticleEngine(MAX);
        const whole = new SoaParticleEngine(MAX);
        for (let i = 0; i < MAX; i++) {
            const x = i - 32, y = i + 5, vx = (i & 15) - 8, vy = 8 - (i & 15), life = 0.4 + (i & 7) * 0.1;
            split.emit(x, y, vx, vy, life, i);
            whole.emit(x, y, vx, vy, life, i);
        }
        split.onTick(integrate);
        whole.onTick(integrate);
        split.tick(A); split.tick(B);
        whole.tick(A + B);
        for (let s = 0; s < MAX; s++) {
            check(Math.abs(split.x[s] - whole.x[s]) <= TICK_TOL,
                () => 'T0.tick.additive: x slot ' + s + ' split=' + split.x[s] + ' whole=' + whole.x[s] + ' (seed=' + SEED + ')');
            check(Math.abs(split.y[s] - whole.y[s]) <= TICK_TOL,
                () => 'T0.tick.additive: y slot ' + s + ' split=' + split.y[s] + ' whole=' + whole.y[s] + ' (seed=' + SEED + ')');
            check(Math.abs(split.life[s] - whole.life[s]) <= TICK_TOL,
                () => 'T0.tick.additive: life slot ' + s + ' split=' + split.life[s] + ' whole=' + whole.life[s] + ' (seed=' + SEED + ')');
        }
        split.destroy();
        whole.destroy();
    }

    // Clear law: after clear(), no slot is alive and head === 0.
    engine.clear();
    check(engine._head === 0, () => 'T0.clear: head not 0 after clear (seed=' + SEED + ')');
    for (let i = 0; i < MAX; i++) {
        check(!(engine.life[i] > 0),
            () => 'T0.clear: slot ' + i + ' still alive after clear (seed=' + SEED + ')');
    }

    // Destroy idempotence: destroy() twice does not throw, and every public
    // method is a no-op afterward (each early-returns on _destroyed / falls
    // through harmlessly).
    engine.destroy();
    let threw = false;
    try {
        engine.destroy();
        engine.emit(0, 0, 0, 0, 1);
        engine.clear();
        engine.start();
        engine.stop();
        engine.pause();
    } catch {
        threw = true;
    }
    check(!threw, () => 'T0.destroy: a public method threw after destroy (seed=' + SEED + ')');
}
