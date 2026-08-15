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

        // ~1 in 4 attempts is a deliberate rejection.
        if ((r & 3) === 0) {
            const kind = (r >>> 2) % 5;
            if (kind === 0) engine.emit(NaN, 0, 0, 0, 1);
            else if (kind === 1) engine.emit(0, Infinity, 0, 0, 1);
            else if (kind === 2) engine.emit(0, 0, NaN, 0, 1);
            else if (kind === 3) engine.emit(0, 0, 0, 0, 0);   // life <= 0
            else engine.emit(0, 0, 0, 0, -1);                  // life < 0

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
