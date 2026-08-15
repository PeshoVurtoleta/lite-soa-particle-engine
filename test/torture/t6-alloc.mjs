/**
 * T6 -- the zero-alloc gate.
 *
 * A mixed hot loop -- emit + the documented aging/iteration pass over every slot
 * -- measured with lite-gc-profiler and gated at maxMajor:0 / maxPauseMs:4 /
 * maxArrayBuffersGrowth:0. The last rule is the one that matters here: ALL SEVEN
 * lanes are ArrayBuffer backing stores, which live OUTSIDE the V8 heap and are
 * invisible to a heapUsed gate (measured 152x blind spot). It requires
 * `stabilize:'deep'`, which `runOpsGate` supplies.
 *
 * A heap gate cannot substitute for the direct structural assertion either, so
 * every lane's `buffer.byteLength` is pinned across the window: nothing may grow.
 *
 * SOA_TORTURE_BREAK=1 injects a retained allocation into the hot body: the gate
 * must then reject the window and the process exits non-zero. That is the
 * whole-suite control, exercisable from here.
 */

import { SoaParticleEngine } from '../../SoaParticleEngine.js';
import {
    runOpsGate, BREAK, check, die, snapshotLaneBytes, checkLaneBytes,
} from './harness.mjs';

const N = 256;             // ring size (power of two)
const OPS = 60000;         // hot iterations -> the ring wraps ~234 times
const WARMUP = 2000;
const DT = 0.016;

/** Retained sink for the BREAK control -- survives GC so arrayBuffers grows. */
const leak = [];

export function run() {
    const engine = new SoaParticleEngine(N);

    // Everything the hot body reads is pre-computed here, once. A pre-filled
    // position table keeps the emit inputs varied without per-op arithmetic that
    // could allocate.
    const px = new Float32Array(N);
    const py = new Float32Array(N);
    const pvx = new Float32Array(N);
    const pvy = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        px[i] = (i * 131) % 2048;
        py[i] = (i * 257) % 2048;
        pvx[i] = ((i * 17) % 400) - 200;
        pvy[i] = ((i * 29) % 400) - 200;
    }

    const hot = (i) => {
        const idx = i & (N - 1);
        // One emit per op: safe finite values, life above the P-05 floor.
        engine.emit(px[idx], py[idx], pvx[idx], pvy[idx], 0.5 + (idx & 7) * 0.1, idx & 15);

        // The documented onTick loop: age + integrate every live slot in place.
        // Zero allocation -- direct indexed reads and writes on the lanes.
        const life = engine.life, invLife = engine.invLife;
        const x = engine.x, y = engine.y, vx = engine.vx, vy = engine.vy;
        for (let s = 0; s < N; s++) {
            if (life[s] <= 0) continue;
            life[s] -= DT;
            vy[s] += 400 * DT;
            x[s] += vx[s] * DT;
            y[s] += vy[s] * DT;
            // Touch the published alpha expression so a regression that made it
            // allocate (it must not) would show here too.
            const a = life[s] * invLife[s];
            if (a < 0) x[s] += 0; // never taken; keeps `a` live without a branch cost
        }

        if (BREAK) leak.push(new Float64Array(64)); // control: retained growth
    };

    const before = new Float64Array(7);
    snapshotLaneBytes(engine, before);

    const { report, summary } = runOpsGate(hot, { ops: OPS, warmup: WARMUP });

    // The structural assertion no heap gate can make: every lane's backing store
    // must be byte-identical in size after the window.
    checkLaneBytes(engine, before, 'T6');

    if (!report.ok) {
        const g = summary.gc;
        die('T6 alloc gate rejected -- verdict=' + report.verdict +
            ' source=' + summary.source +
            ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
            (BREAK ? ' (SOA_TORTURE_BREAK control -- expected)' : ''));
    }

    // In BREAK mode the gate was SUPPOSED to reject; reaching here means the
    // control silently passed, which is itself a failure.
    if (BREAK) die('T6: SOA_TORTURE_BREAK injected allocations but the gate passed');
}
