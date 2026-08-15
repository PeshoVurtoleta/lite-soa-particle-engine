/**
 * @zakkster/lite-soa-particle-engine -- torture harness.
 *
 * One place for the seeded PRNG, the zero-alloc assertion, the RULES, the
 * lite-gc-profiler gate wrapper, the per-lane byteLength pins, and the
 * deterministic frame-pump shims. Every tier imports from here so the discipline
 * is enforced once:
 *
 *   - All scratch is allocated ONCE by the tier, outside every loop. This module
 *     hands out helpers, never per-call allocations on a hot path.
 *   - `check()` builds its message string ONLY on failure -- a template literal
 *     per iteration is an allocation and would fail the T6 gate.
 *   - The PRNG is a seeded xorshift32. On failure a tier prints the seed so the
 *     case replays with `TORTURE_SEED=... node --expose-gc test/torture.mjs`.
 *   - lite-gc-profiler is one-measurement-at-a-time; tiers run STRICTLY
 *     SEQUENTIALLY, never nested. `runOpsGate` opens and closes one window.
 *   - Every lane is an ArrayBuffer backing store, so `maxArrayBuffersGrowth: 0`
 *     with `stabilize: 'deep'` is mandatory AND each lane's `buffer.byteLength`
 *     is pinned across the measured window (a heapUsed gate is blind to all of
 *     it -- measured 152x blind spot in the profiler docs).
 *   - The RAF/clock shims live here (finding P-08). Node has no
 *     requestAnimationFrame; the pump is manual and driven by explicit
 *     timestamps, never a real timer.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';
import { installFramePump } from '../helpers/env.mjs';

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/** Whole-suite control: SOA_TORTURE_BREAK=1 injects a retained alloc into T6. */
export const BREAK = process.env.SOA_TORTURE_BREAK === '1';

/** Base zero-GC rules. maxArrayBuffersGrowth needs measureOps `stabilize:'deep'`. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/** The deterministic frame pump, installed once for the whole run. */
export const PUMP = installFramePump();

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg + '\n');
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/** The seven public lanes, in the documented callback order. */
export const LANES = ['x', 'y', 'vx', 'vy', 'life', 'invLife', 'data'];

/**
 * Snapshot every lane's backing-store byteLength into `out` (pre-allocated
 * Float64Array(7)). No allocation.
 */
export function snapshotLaneBytes(engine, out) {
    for (let i = 0; i < LANES.length; i++) out[i] = engine[LANES[i]].buffer.byteLength;
    return out;
}

/**
 * Assert every lane's backing store is byte-identical in size to `before`.
 * The structural assertion no heapUsed gate can substitute for.
 */
export function checkLaneBytes(engine, before, tag) {
    for (let i = 0; i < LANES.length; i++) {
        const lane = LANES[i];
        check(engine[lane].buffer.byteLength === before[i],
            () => tag + ': lane ' + lane + ' backing store grew ' +
                before[i] + ' -> ' + engine[lane].buffer.byteLength);
    }
}

/**
 * Raw-mode ring invariant (roadmap section 2): a healthy head is an integer in
 * [0, max). P-04 violates it on the first emit into a zero-length engine and
 * never recovers, so tiers only assert this where `max >= 1`.
 */
export function headInvariant(engine) {
    const h = engine._head;
    return Number.isInteger(h) && h >= 0 && h < engine.max;
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * `stabilize:'deep'` is what makes `maxArrayBuffersGrowth` resolvable (backing
 * stores live outside the V8 heap). Returns the checkNoGc report plus the raw
 * summary for diagnostics.
 *
 * @param {(i:number)=>void} fn      Sync, zero-alloc hot body.
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return { report: checkNoGc(res.summary, RULES), summary: res.summary };
}
