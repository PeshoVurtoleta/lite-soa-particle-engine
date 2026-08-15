/**
 * bench-emit -- emit() throughput, with the harness's own resolution limit
 * measured before any number is published (finding P-10; the S2 correction to
 * the perf assertion).
 *
 * WHY THIS IS NOT AN ORDINARY BENCHMARK
 * emit() throughput on Apple silicon is BIMODAL: the identical loop alternates
 * between roughly 110 and 200 Mops/s as the process migrates between
 * performance and efficiency cores. A naive before/after reports whichever
 * mode each side happened to land in. Two builds of this file already proved
 * how easily that fabricates a result:
 *
 *   - taking max|ratio-1| over raw pairs let ONE contaminated pair set the
 *     limit at 84%, which is far more pessimistic than the median-of-pairs
 *     statistic actually published;
 *   - with only 15 pairs and a JIT-cold baseline class, phase 3 reported a
 *     +48.1% "improvement" of emit() over a byte-identical frozen copy of
 *     ITSELF.
 *
 * Both are fixed below and both are now guarded by controls that fail loudly.
 *
 *   Phase 1  CONTROL. Two instances of the SAME implementation, interleaved
 *            with seeded order flipping. True answer 0%. The bootstrap
 *            half-width of the median-of-pairs is the RESOLUTION LIMIT R --
 *            the smallest delta this machine can support today. The control
 *            must also be UNBIASED (|median - 1| <= R) or the run aborts.
 *   Phase 2  ABSOLUTE + MODES. Long windows, descriptive only. Reports the
 *            clusters instead of averaging the hardware artifact away.
 *   Phase 3  A/B. Current emit() vs the frozen v1.0.3 baseline. The delta is
 *            reported ONLY if it exceeds R; otherwise BELOW RESOLUTION, which
 *            is an honest answer, not a failure.
 *
 * Ratio phases use MANY SHORT windows: a ratio needs independent samples, not
 * long ones, and a short window is less likely to be split by a core
 * migration. Absolute throughput uses few long windows, because that question
 * does need steady state. Different statistics for different questions.
 *
 *   node --expose-gc test/bench-emit.mjs
 *   node --expose-gc test/bench-emit.mjs --selftest      # prove it finds no
 *                                                        # difference where
 *                                                        # none exists
 *   BENCH_SEED=12345 node --expose-gc test/bench-emit.mjs
 */

import { measureOps } from '@zakkster/lite-gc-profiler';
import { SoaParticleEngine } from '../SoaParticleEngine.js';
import { SoaParticleEngineV103 } from './baseline/SoaParticleEngineV103.mjs';
import os from 'node:os';

const arg = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? dflt : Number(process.argv[i + 1]);
};

/** Ratio protocol: many short windows. Tuned until the control came back clean. */
const PAIRS = arg('--pairs', 51);
const RATIO_OPS = arg('--ops', 300000);
/** Absolute protocol: few long windows, for a steady-state figure. */
const ABS_OPS = 2000000;
const ABS_REPS = 9;
const MAX = 4096;

/** The control must be unbiased and R must be usable, or nothing is published. */
const CONTROL_SANITY = 0.25;

const SELFTEST = process.argv.includes('--selftest');

const median = (v) => { const s = v.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
const pct = (x) => (x * 100).toFixed(1) + '%';

/** Seeded xorshift32, matching the torture suite's replay habit. */
const SEED = (() => {
    const raw = process.env.BENCH_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n;
})();
let _s = SEED;
const rnd = () => {
    _s ^= _s << 13; _s >>>= 0;
    _s ^= _s >>> 17;
    _s ^= _s << 5; _s >>>= 0;
    return _s / 4294967296;
};

const WORK = (e) => (i) => { e.emit(i & 1023, 1, 1, -1, 0.5, i & 15); };
const once = (fn, ops) =>
    measureOps(fn, { ops, warmup: Math.min(20000, ops >> 3), stabilize: 'deep' }).opsPerSec / 1e6;

/**
 * Resolution limit of the MEDIAN-OF-PAIRS estimator, by bootstrap. The
 * published delta is a median, so the honest limit is how far THAT statistic
 * wanders on identical code -- not how far a single pair can.
 */
function bootstrapLimit(ratios, resamples = 6000) {
    const n = ratios.length, meds = [], devs = [];
    const buf = new Array(n);
    for (let r = 0; r < resamples; r++) {
        for (let i = 0; i < n; i++) buf[i] = ratios[(rnd() * n) | 0];
        const m = median(buf);
        meds.push(m);
        devs.push(Math.abs(m - 1));
    }
    meds.sort((a, b) => a - b);
    devs.sort((a, b) => a - b);
    // R is the 99th percentile of |median - 1| under the null, NOT a 90% CI.
    // A 90% band means a 1-in-10 chance of calling identical code different,
    // and a gate that fabricates a result every tenth run is not a gate. Seed
    // 12345 did exactly that during development: +6.2% "improvement" over a
    // byte-identical baseline, against a 90%-derived R of 4.9%. The 99th
    // percentile costs 1-2 points of resolution and removes that class of lie.
    return {
        lo: meds[Math.floor(resamples * 0.005)],
        hi: meds[Math.floor(resamples * 0.995)],
        halfWidth: devs[Math.floor(resamples * 0.99)],
    };
}

/** Interleaved A/B with seeded order flipping, so neither side owns the first slot. */
function interleave(mkA, mkB, pairs, ops) {
    const a = [], b = [];
    for (let i = 0; i < pairs; i++) {
        if (rnd() < 0.5) { a.push(once(mkA, ops)); b.push(once(mkB, ops)); }
        else { b.push(once(mkB, ops)); a.push(once(mkA, ops)); }
    }
    return { a, b, ratios: a.map((v, i) => v / b[i]) };
}

/** Both classes equally hot before the first sample, at the ratio window size. */
function prewarm(rounds = 3) {
    const a = new SoaParticleEngine(MAX), b = new SoaParticleEngineV103(MAX);
    for (let k = 0; k < rounds; k++) { once(WORK(a), RATIO_OPS); once(WORK(b), RATIO_OPS); }
    a.destroy(); b.destroy();
}

/** Bimodality by largest gap in the sorted samples. */
function modes(samples, rel = 0.25) {
    const s = samples.slice().sort((x, y) => x - y);
    const med = s[s.length >> 1];
    let gap = 0, at = -1;
    for (let i = 1; i < s.length; i++) {
        const g = s[i] - s[i - 1];
        if (g > gap) { gap = g; at = i; }
    }
    if (at === -1 || gap < med * rel) {
        return { bimodal: false, median: med, spread: (s[s.length - 1] - s[0]) / med };
    }
    const lo = s.slice(0, at), hi = s.slice(at);
    return {
        bimodal: true, median: med, lo: median(lo), hi: median(hi),
        nLo: lo.length, nHi: hi.length, ratio: median(hi) / median(lo),
    };
}

// --------------------------------------------------------------------------
console.log('bench-emit -- emit() throughput with a measured resolution limit');
console.log('machine : ' + os.cpus()[0].model + ', node ' + process.version);
console.log('ratio   : ' + PAIRS + ' interleaved pairs, ops=' + RATIO_OPS + ', seeded order flip, seed ' + SEED);
console.log('absolute: ' + ABS_REPS + ' reps, ops=' + ABS_OPS + ', stabilize=deep, max=' + MAX);
console.log('');

prewarm();

// -- Phase 1: control -------------------------------------------------------
// Both sides are the FROZEN BASELINE. That stays a valid control after S2
// changes the shipping emit(), and it is the class that sits on side B of
// phase 3, so its noise is the noise that matters.
const k1 = new SoaParticleEngineV103(MAX), k2 = new SoaParticleEngineV103(MAX);
const ctl = interleave(WORK(k1), WORK(k2), PAIRS, RATIO_OPS);
const ctlSorted = ctl.ratios.slice().sort((a, b) => a - b);
const ctlMed = median(ctl.ratios);
const boot = bootstrapLimit(ctl.ratios);
const R = boot.halfWidth;
const bias = Math.abs(ctlMed - 1);

console.log('PHASE 1  control -- identical implementations on both sides, true answer 0%');
console.log('  median ratio      : ' + ctlMed.toFixed(3) + '   (want ~1.000)');
console.log('  raw pair range    : ' + ctlSorted[0].toFixed(3) + ' .. ' +
    ctlSorted[ctlSorted.length - 1].toFixed(3) + '   <- the hardware artifact, not the limit');
console.log('  median 99% CI     : ' + boot.lo.toFixed(3) + ' .. ' + boot.hi.toFixed(3) + '   (bootstrap)');
console.log('  RESOLUTION LIMIT R: ' + pct(R) + '   <- no delta below this is meaningful');
console.log('  control bias      : ' + pct(bias) + (bias <= R ? '   (within R, unbiased)' : '   BIASED'));
k1.destroy(); k2.destroy();

if (R > CONTROL_SANITY || bias > R) {
    console.log('');
    console.log('ABORT -- the control ' + (bias > R
        ? 'is biased: it reports a ' + pct(bias) + ' difference between identical code.'
        : 'cannot resolve better than ' + pct(R) + ' on this machine right now.'));
    console.log('        No throughput claim can be made from this run. Close other work');
    console.log('        and re-run, or raise --pairs. Publishing anyway would be fabrication.');
    process.exit(1);
}

// -- Phase 2: absolute + modes (descriptive) --------------------------------
const abs = new SoaParticleEngine(MAX);
const absSamples = [];
for (let r = 0; r < ABS_REPS; r++) absSamples.push(once(WORK(abs), ABS_OPS));
abs.destroy();
const m = modes(absSamples);

console.log('');
console.log('PHASE 2  absolute throughput (descriptive, not a gate)');
if (m.bimodal) {
    console.log('  BIMODAL -- two clusters, ' + m.ratio.toFixed(2) + 'x apart');
    console.log('    slow mode : ' + m.lo.toFixed(1) + ' Mops/s  (' + m.nLo + ' samples)');
    console.log('    fast mode : ' + m.hi.toFixed(1) + ' Mops/s  (' + m.nHi + ' samples)');
    console.log('  A single median (' + m.median.toFixed(1) + ' Mops/s) describes neither mode.');
    console.log('  Quote the pair, or quote nothing.');
} else {
    console.log('  unimodal -- median ' + m.median.toFixed(1) + ' Mops/s, full spread ' + pct(m.spread));
}

// -- Phase 3: A/B -----------------------------------------------------------
const cur = new SoaParticleEngine(MAX), old = new SoaParticleEngineV103(MAX);
const ab = interleave(WORK(cur), WORK(old), PAIRS, RATIO_OPS);
const delta = median(ab.ratios) - 1;
const resolved = Math.abs(delta) > R;
cur.destroy(); old.destroy();

console.log('');
console.log('PHASE 3  current emit() vs frozen v1.0.3 baseline');
console.log('  median ratio : ' + median(ab.ratios).toFixed(3) + '   (current / v1.0.3)');
console.log('  delta        : ' + (delta >= 0 ? '+' : '') + pct(delta));
console.log('  vs limit R   : ' + pct(R));
console.log('');
if (!resolved) {
    console.log('VERDICT: BELOW RESOLUTION. |' + pct(delta) + '| <= R=' + pct(R) + ', so this run');
    console.log('         supports NO throughput claim in either direction. Say exactly that.');
    console.log('         "No measurable change" is a result; a number smaller than the');
    console.log('         noise that produced it is not.');
} else {
    console.log('VERDICT: RESOLVED. |' + pct(delta) + '| > R=' + pct(R) + '.');
    console.log('         ' + (delta < 0 ? 'REGRESSION' : 'improvement') + ' of ' + pct(Math.abs(delta)) +
        ' vs v1.0.3. Quote this protocol alongside the number.');
}

// -- Self-test --------------------------------------------------------------
// While SoaParticleEngine.emit and the frozen copy are identical in logic, the
// only correct phase-3 verdict is BELOW RESOLUTION. S2 changes emit(), and at
// that point this assertion stops being valid: re-point it at two copies of
// the same implementation. Guard it, do not delete it.
if (SELFTEST) {
    console.log('');
    if (resolved) {
        console.log('SELFTEST FAIL -- resolved a ' + pct(delta) + ' difference between two');
        console.log('                byte-identical implementations. Every number this');
        console.log('                protocol produces is unsafe until that is fixed.');
        process.exit(1);
    }
    console.log('SELFTEST PASS -- identical implementations correctly reported as');
    console.log('                indistinguishable (' + pct(Math.abs(delta)) + ' <= R=' + pct(R) + ').');
}
