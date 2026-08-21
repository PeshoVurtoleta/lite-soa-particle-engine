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
import { Random } from '@zakkster/lite-random';

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

    // The documented onTick loop, registered ONCE and driven per op through
    // tick(dt) (S3): age + integrate every live slot in place. Zero allocation --
    // direct indexed reads and writes on the lanes handed in by tick(). Routing it
    // through tick() puts the new hot entry point (typeof + >= 0 + clamp + call)
    // INSIDE the measured window, so a regression that made tick() allocate, or
    // that de-inlined the callback dispatch into an allocation, shows here.
    const aged = function (dt, x, y, vx, vy, life, invLife, data, max) {
        for (let s = 0; s < max; s++) {
            if (life[s] <= 0) continue;
            life[s] -= dt;
            vy[s] += 400 * dt;
            x[s] += vx[s] * dt;
            y[s] += vy[s] * dt;
            // Touch the published alpha expression so a regression that made it
            // allocate (it must not) would show here too.
            const a = life[s] * invLife[s];
            if (a < 0) x[s] += 0; // never taken; keeps `a` live without a branch cost
        }
    };
    engine.onTick(aged);

    // The burst spec is hoisted ONCE, outside every loop -- a per-op object literal
    // would allocate and fail this very gate. The injected Random is allocated once
    // too; its .next() (mulberry32) allocates nothing. emitBurst's cone (3 draws,
    // cos, sin, store) is the new hot entry point under test.
    const BURST = 4;
    const burstSpec = { speed: 200, speedVar: 50, angle: 0, angleVar: Math.PI, life: 0.5, lifeVar: 0.1, data: 3 };
    const injected = new Random(0x51ed);

    // Config A -- emitBurst with an INJECTED Random. Config B -- emitBurst with the
    // DEFAULT_RNG (rng omitted). Both include emit + tick so the whole hot surface
    // is inside one measured window. The BREAK control retains an allocation so the
    // whole-suite SOA_TORTURE_BREAK exit-non-zero contract still trips here.
    const hotInjected = (i) => {
        const idx = i & (N - 1);
        engine.emit(px[idx], py[idx], pvx[idx], pvy[idx], 0.5 + (idx & 7) * 0.1, idx & 15);
        engine.emitBurst(px[idx], py[idx], BURST, burstSpec, injected);
        engine.tick(DT);
        if (BREAK) leak.push(new Float64Array(64)); // control: retained growth
    };
    const hotDefault = (i) => {
        const idx = i & (N - 1);
        engine.emit(px[idx], py[idx], pvx[idx], pvy[idx], 0.5 + (idx & 7) * 0.1, idx & 15);
        engine.emitBurst(px[idx], py[idx], BURST, burstSpec); // DEFAULT_RNG
        engine.tick(DT);
        if (BREAK) leak.push(new Float64Array(64));
    };

    const before = new Float64Array(7);

    const configs = [['injected Random', hotInjected], ['DEFAULT_RNG', hotDefault]];
    for (let c = 0; c < configs.length; c++) {
        const label = configs[c][0], hot = configs[c][1];
        snapshotLaneBytes(engine, before);
        const { report, summary } = runOpsGate(hot, { ops: OPS, warmup: WARMUP });

        // The structural assertion no heap gate can make: every lane's backing
        // store must be byte-identical in size after the window.
        checkLaneBytes(engine, before, 'T6 (' + label + ')');

        if (!report.ok) {
            const g = summary.gc;
            die('T6 alloc gate rejected (' + label + ') -- verdict=' + report.verdict +
                ' source=' + summary.source +
                ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
                (BREAK ? ' (SOA_TORTURE_BREAK control -- expected)' : ''));
        }

        // In BREAK mode the gate was SUPPOSED to reject; reaching here means the
        // control silently passed, which is itself a failure.
        if (BREAK) die('T6: SOA_TORTURE_BREAK injected allocations but the gate passed (' + label + ')');
    }
}
