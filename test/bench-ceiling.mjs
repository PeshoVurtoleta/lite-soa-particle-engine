/**
 * bench-ceiling -- the falsifiable gate behind MAX_PARTICLES (findings P-03, P-18).
 *
 * WHY THIS EXISTS
 * P-18: past a hardware-dependent size, `new Float32Array(n)` does not throw --
 * V8's backing-store allocator hits `Check failed: change_in_bytes <
 * kMaxReasonableBytes` and calls abort(). There is no JS stack and no catch.
 * A library that hands an unvalidated integer to seven TypedArray constructors
 * therefore has a caller-typo-to-dead-process path. S2 caps it. This harness is
 * the evidence that the chosen cap is the right one, in the same role
 * test/bench-soa.mjs plays for @zakkster/lite-particles decisions/0010.
 *
 * PASS CONDITION, WRITTEN BEFORE THE NUMBERS (all six must hold):
 *   C1 the candidate ceiling constructs
 *   C2 all 7 lanes at the candidate are writable AND read back end-to-end
 *   C3 resident footprint matches the analytic 28*C bytes within tolerance
 *   C4 construct+touch completes inside the time budget
 *   C5 the candidate sits at least MARGIN x below the measured abort threshold
 *   C6 there is NO catchable-failure band above the candidate -- i.e. the
 *      failure mode really is abort, which is what makes a cap mandatory
 *      rather than cosmetic. If C6 ever fails, the cap could be relaxed to
 *      "let it throw", so this is the load-bearing one.
 *   C7 the candidate fits the PORTABILITY budget, and the next power of two
 *      does not. C1-C6 only prove the candidate works on the machine running
 *      the sweep; they would equally bless 2^25 or 2^26 on a 24 GB desktop.
 *      MAX_PARTICLES is a compiled-in library constant shipped to every
 *      consumer, so the binding constraint is the SMALLEST device the package
 *      targets, not the largest it was measured on. Without C7 this harness
 *      would rubber-stamp whatever the developer's workstation happened to
 *      hold, which is how a ceiling becomes an accident of hardware.
 * FAIL ACTION: do not ship the candidate. Record the measured numbers and pick
 * again from this table. Never widen a criterion to make a run pass.
 *
 * Every size runs in its OWN subprocess: an abort kills the child, not the
 * sweep, and RSS is measured against a fresh process rather than a dirty one.
 *
 *   node test/bench-ceiling.mjs            # sweep + verdict
 *   node test/bench-ceiling.mjs --quick    # skip the slow high end
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const SELF = fileURLToPath(import.meta.url);
const LANES = 7;                       // x y vx vy life invLife data
const BYTES_PER_PARTICLE = LANES * 4;  // 6 Float32 + 1 Int32

/**
 * The value under test. CEILING_CANDIDATE overrides it so the criteria can be
 * shown to REJECT wrong values -- a gate that only ever passes proves nothing.
 * Change the candidate and re-run; never edit a criterion to make one pass.
 */
const CANDIDATE = Number(process.env.CEILING_CANDIDATE || 2 ** 24);
/** How far below the abort threshold the candidate must sit (C5). */
const MARGIN = 128;
/** C4 budget for construct + full touch of the candidate. */
const TIME_BUDGET_MS = 5000;
/** C3 tolerance: RSS accounting is not exact, allow this fraction of slack. */
const RSS_TOLERANCE = 0.25;
/**
 * C7 portability budget. The smallest device class this package claims to run
 * on is a low-end mobile browser, where a single tab is commonly killed above
 * a few hundred MB. 512 MB is the declared budget: one fully-saturated engine
 * may cost half a gigabyte and no more. This number is a PRODUCT decision --
 * argue with it in decisions/0002, do not tune it to make a run pass.
 */
const PORTABILITY_BUDGET_BYTES = 512 * 2 ** 20;

// ---------------------------------------------------------------- child mode
if (process.env.CEILING_CHILD !== undefined) {
    const n = Number(process.env.CEILING_CHILD);
    const touch = process.env.CEILING_TOUCH === '1';
    const rss0 = process.memoryUsage().rss;
    const out = { n, touched: touch };
    try {
        const t0 = process.hrtime.bigint();
        const { SoaParticleEngine } = await import('../SoaParticleEngine.js');
        const e = new SoaParticleEngine(n);
        out.constructMs = Number(process.hrtime.bigint() - t0) / 1e6;
        out.laneLen = e.x.length;
        out.maxField = e.max;

        if (touch) {
            const t1 = process.hrtime.bigint();
            // Write a position-dependent value into EVERY slot of EVERY lane,
            // then read it back. Reserved-but-unfaulted address space cannot
            // survive this; a lane that silently truncates cannot either.
            const lanes = [e.x, e.y, e.vx, e.vy, e.life, e.invLife, e.data];
            for (const lane of lanes) {
                for (let i = 0; i < lane.length; i++) lane[i] = (i & 1023) + 1;
            }
            let bad = -1;
            outer:
            for (let L = 0; L < lanes.length; L++) {
                const lane = lanes[L];
                for (let i = 0; i < lane.length; i++) {
                    if (lane[i] !== (i & 1023) + 1) { bad = L * 1e12 + i; break outer; }
                }
            }
            out.touchMs = Number(process.hrtime.bigint() - t1) / 1e6;
            out.readbackOk = bad === -1;
            out.firstBadAt = bad;
        }
        const m = process.memoryUsage();
        out.rssDeltaBytes = m.rss - rss0;
        out.arrayBuffersBytes = m.arrayBuffers;
        out.status = 'CONSTRUCTED';
        e.destroy();
    } catch (err) {
        out.status = 'THREW';
        out.errName = err && err.constructor ? err.constructor.name : String(err);
        out.errMessage = err && err.message ? err.message : String(err);
    }
    process.stdout.write('@@' + JSON.stringify(out) + '@@');
    process.exit(0);
}

// --------------------------------------------------------------- parent mode
const quick = process.argv.includes('--quick');
const freeBytes = os.freemem();
/** Do not touch a footprint we cannot hold: swapping is not a measurement. */
const TOUCH_LIMIT_BYTES = Math.max(0, freeBytes * 0.45);

function runOne(n, touch) {
    const r = spawnSync(process.execPath, [SELF], {
        env: { ...process.env, CEILING_CHILD: String(n), CEILING_TOUCH: touch ? '1' : '0' },
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 1 << 20,
    });
    const raw = r.stdout || '';
    const m = raw.match(/@@([\s\S]*?)@@/);
    if (m) {
        const parsed = JSON.parse(m[1]);
        parsed.exitCode = r.status;
        return parsed;
    }
    // No payload: the child died before it could report.
    const stderr = r.stderr || '';
    const aborted = /Check failed|Fatal error/.test(stderr);
    return {
        n,
        touched: touch,
        status: r.signal === 'SIGTERM' ? 'TIMEOUT' : (aborted ? 'ABORTED' : 'DIED'),
        exitCode: r.status,
        signal: r.signal,
        detail: (stderr.split('\n').find((l) => /Check failed/.test(l)) || '').trim(),
    };
}

const mb = (b) => (b / 2 ** 20).toFixed(1);
const pow2 = (n) => {
    const e = Math.log2(n);
    return Number.isInteger(e) ? '2^' + e : String(n);
};

const sizes = [
    2 ** 10, 2 ** 16, 2 ** 20, 2 ** 22, 2 ** 23,
    CANDIDATE,
    2 ** 25, 2 ** 26,
    ...(quick ? [] : [2 ** 27, 2 ** 28]),
    2 ** 30, 2 ** 32, 6 * 2 ** 30, 2 ** 33, 2 ** 34,
];

console.log('bench-ceiling -- MAX_PARTICLES evidence (P-03, P-18)');
console.log('machine  : ' + os.cpus()[0].model + ', ' + (os.totalmem() / 2 ** 30).toFixed(0) +
    ' GB RAM, node ' + process.version);
console.log('candidate: ' + pow2(CANDIDATE) + ' = ' + CANDIDATE + ' particles = ' +
    mb(CANDIDATE * BYTES_PER_PARTICLE) + ' MB across ' + LANES + ' lanes');
console.log('touch cap: ' + mb(TOUCH_LIMIT_BYTES) + ' MB (45% of free RAM; larger sizes are ' +
    'constructed but not touched, and are reported as such)');
console.log('');
console.log('  size            particles     footprint   status            construct   touch      RSS delta');
console.log('  --------------- ------------- ----------- ----------------- ----------- ---------- -----------');

const rows = [];
for (const n of sizes) {
    const footprint = n * BYTES_PER_PARTICLE;
    const touch = footprint <= TOUCH_LIMIT_BYTES;
    const r = runOne(n, touch);
    r.footprint = footprint;
    rows.push(r);

    let status = r.status;
    if (r.status === 'CONSTRUCTED' && r.touched) status = r.readbackOk ? 'USABLE' : 'CORRUPT';
    else if (r.status === 'CONSTRUCTED') status = 'CONSTRUCTED(untouched)';

    console.log(
        '  ' + pow2(n).padEnd(15) +
        String(n).padEnd(14) +
        (mb(footprint) + ' MB').padStart(10) + '  ' +
        status.padEnd(18) +
        (r.constructMs === undefined ? '-' : r.constructMs.toFixed(1) + ' ms').padStart(10) + '  ' +
        (r.touchMs === undefined ? '-' : r.touchMs.toFixed(0) + ' ms').padStart(9) + '  ' +
        (r.rssDeltaBytes === undefined ? '-' : mb(r.rssDeltaBytes) + ' MB').padStart(10)
    );
    if (r.status === 'ABORTED') console.log('                  ^ ' + (r.detail || 'fatal, uncatchable') +
        '  (exit ' + r.exitCode + ')');
    if (r.status === 'THREW') console.log('                  ^ ' + r.errName + ': ' + r.errMessage);
}

// ------------------------------------------------------------------ criteria
const byN = (n) => rows.find((r) => r.n === n);
const cand = byN(CANDIDATE);
const aborts = rows.filter((r) => r.status === 'ABORTED').map((r) => r.n).sort((a, b) => a - b);
const abortThreshold = aborts.length ? aborts[0] : Infinity;
const throwers = rows.filter((r) => r.status === 'THREW');
const expectedRss = CANDIDATE * BYTES_PER_PARTICLE;

const checks = [
    ['C1 candidate constructs',
        cand && cand.status === 'CONSTRUCTED',
        cand ? cand.status : 'missing'],
    ['C2 all 7 lanes writable + read back',
        cand && cand.touched === true && cand.readbackOk === true,
        cand && cand.touched ? 'readbackOk=' + cand.readbackOk : 'NOT TOUCHED (raise free RAM and re-run)'],
    ['C3 RSS within ' + (RSS_TOLERANCE * 100) + '% of analytic ' + mb(expectedRss) + ' MB',
        cand && cand.rssDeltaBytes !== undefined &&
        Math.abs(cand.rssDeltaBytes - expectedRss) <= expectedRss * RSS_TOLERANCE,
        cand && cand.rssDeltaBytes !== undefined ? 'measured ' + mb(cand.rssDeltaBytes) + ' MB' : 'n/a'],
    ['C4 construct+touch <= ' + TIME_BUDGET_MS + ' ms',
        cand && cand.constructMs !== undefined &&
        (cand.constructMs + (cand.touchMs || 0)) <= TIME_BUDGET_MS,
        cand && cand.constructMs !== undefined
            ? (cand.constructMs + (cand.touchMs || 0)).toFixed(0) + ' ms' : 'n/a'],
    ['C5 candidate >= ' + MARGIN + 'x below abort threshold',
        abortThreshold / CANDIDATE >= MARGIN,
        abortThreshold === Infinity
            ? 'no abort observed in sweep'
            : 'abort at ' + pow2(abortThreshold) + ', margin ' + (abortThreshold / CANDIDATE).toFixed(0) + 'x'],
    ['C6 no catchable-failure band (cap is mandatory)',
        throwers.length === 0 && abortThreshold !== Infinity,
        throwers.length
            ? throwers.length + ' size(s) threw catchably: ' + throwers.map((r) => pow2(r.n)).join(', ')
            : 'sizes go straight from constructing to aborting'],
    ['C7 fits ' + mb(PORTABILITY_BUDGET_BYTES) + ' MB budget, next size up does not',
        expectedRss <= PORTABILITY_BUDGET_BYTES &&
        CANDIDATE * 2 * BYTES_PER_PARTICLE > PORTABILITY_BUDGET_BYTES,
        mb(expectedRss) + ' MB ' +
        (expectedRss <= PORTABILITY_BUDGET_BYTES ? 'fits' : 'OVER BUDGET') + '; ' +
        pow2(CANDIDATE * 2) + ' would need ' + mb(CANDIDATE * 2 * BYTES_PER_PARTICLE) + ' MB ' +
        (CANDIDATE * 2 * BYTES_PER_PARTICLE > PORTABILITY_BUDGET_BYTES ? '(over)' : '(ALSO FITS -- ceiling is too low)')],
];

console.log('');
console.log('VERDICT for MAX_PARTICLES = ' + pow2(CANDIDATE));
let allOk = true;
for (const [label, ok, detail] of checks) {
    if (!ok) allOk = false;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label.padEnd(48) + detail);
}
console.log('');
if (allOk) {
    const usable = rows.filter((r) => r.readbackOk === true).map((r) => r.n);
    const overBudget = usable.filter((n) => n * BYTES_PER_PARTICLE > PORTABILITY_BUDGET_BYTES);
    console.log('ok -- ' + pow2(CANDIDATE) + ' is supported by measurement.');
    console.log('     C6 is load-bearing: there is no size at which the allocator fails');
    console.log('     politely, so validation is the only thing preventing the abort.');
    if (overBudget.length) {
        console.log('     C7 is what picks BETWEEN the working sizes. Also fully usable on');
        console.log('     this machine: ' + overBudget.map(pow2).join(', ') + ' -- rejected not because they');
        console.log('     failed here but because they exceed the ' + mb(PORTABILITY_BUDGET_BYTES) +
            ' MB budget a shipped');
        console.log('     constant has to honour on the smallest targeted device.');
    }
    process.exit(0);
}
console.log('FAIL -- the candidate is NOT supported. Per the pre-committed fail action,');
console.log('        pick another value from the table above. Do not widen a criterion.');
process.exit(1);
