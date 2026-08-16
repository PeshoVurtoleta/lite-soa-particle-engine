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
 * WHAT THIS SWEEP ALLOCATES, AND WHY IT IS NOT THE ENGINE
 * The child allocates the seven lanes RAW (`new Float32Array(n)` x6 +
 * `new Int32Array(n)`), not `new SoaParticleEngine(n)`. From v1.0.4 the
 * constructor enforces MAX_PARTICLES, so sweeping through it would be circular:
 * every oversized row would "fail politely" because of the cap this file exists
 * to justify. C6 would then report a catchable-failure band belonging to the
 * library rather than to V8 -- which inverts its meaning -- and C5 would observe
 * no abort at all and pass vacuously. The claim under test is a property of the
 * ALLOCATOR; the shipped constructor is checked once, separately, by C8.
 *
 * PASS CONDITION, WRITTEN BEFORE THE NUMBERS (all eight must hold):
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
 *   C8 the SHIPPED constructor enforces exactly this candidate: its exported
 *      MAX_PARTICLES equals it, it accepts n, and it rejects n+1 with a branded
 *      RangeError. The one criterion that looks at the library, so the cap
 *      cannot drift away from the evidence here without a run turning red.
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
        // RAW lane allocation -- deliberately NOT `new SoaParticleEngine(n)`.
        //
        // From v1.0.4 the constructor enforces MAX_PARTICLES, so going through it
        // would make this harness CIRCULAR: every size above the candidate would
        // "fail politely" because of the very cap this sweep exists to justify,
        // C6 would report a catchable-failure band that belongs to the library
        // rather than to V8, and C5 would find no abort at all and pass
        // vacuously (Infinity / CANDIDATE >= MARGIN is trivially true).
        //
        // The fact P-18 rests on is a property of the ALLOCATOR: seven unvalidated
        // TypedArray constructors have a size past which V8 calls abort() instead
        // of throwing. That is what must be measured here. The shipped
        // constructor's behaviour is checked separately, by C8.
        const lanes = [
            new Float32Array(n), new Float32Array(n), new Float32Array(n),
            new Float32Array(n), new Float32Array(n), new Float32Array(n),
            new Int32Array(n),
        ];
        out.constructMs = Number(process.hrtime.bigint() - t0) / 1e6;
        out.laneLen = lanes[0].length;

        if (touch) {
            const t1 = process.hrtime.bigint();
            // Write a position-dependent value into EVERY slot of EVERY lane,
            // then read it back. Reserved-but-unfaulted address space cannot
            // survive this; a lane that silently truncates cannot either.
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

        // C8 evidence: does the SHIPPED constructor agree with this sweep? Only
        // asked at the candidate, and only after the raw lanes already proved the
        // size is real -- so a disagreement means the library's cap drifted from
        // the measured evidence, not that the allocator failed.
        if (process.env.CEILING_DOOR === '1') {
            const mod = await import('../SoaParticleEngine.js');
            out.moduleMax = mod.MAX_PARTICLES;
            let e = null;
            try {
                e = new mod.SoaParticleEngine(n);
                out.doorAccepts = e.x.length === n;
            } catch (err) {
                out.doorAccepts = false;
                out.doorAcceptErr = String(err && err.message);
            } finally {
                if (e) e.destroy();
            }
            try {
                const over = new mod.SoaParticleEngine(n + 1);
                over.destroy();
                out.doorRejectsOver = false;
            } catch (err) {
                out.doorRejectsOver = err instanceof RangeError &&
                    /^SoaParticleEngine: /.test(String(err.message));
                out.doorRejectErr = String(err && err.message);
            }
        }
        lanes.length = 0;
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

/**
 * Reclaimable memory (P-25). `os.freemem()` reports only the truly-free page pool;
 * on macOS (and to a lesser degree Linux) a large share of RAM sits in INACTIVE /
 * PURGEABLE / file-backed pages that the kernel hands back on demand without
 * swapping. Ignoring them undercounts what is available, so the candidate's touch
 * is skipped, C2 cannot be measured, and the identical tree that passed minutes
 * ago now reports a criterion unmeasured. Count the reclaimable pool in the budget
 * so the measurement can actually run. Test infra only; parses `vm_stat` on
 * darwin, falls back to `os.freemem()` everywhere else.
 */
function reclaimableExtraBytes() {
    if (process.platform !== 'darwin') return 0;
    try {
        const out = spawnSync('vm_stat', [], { encoding: 'utf8', timeout: 5000 }).stdout || '';
        const pageM = out.match(/page size of (\d+) bytes/);
        const pageSize = pageM ? Number(pageM[1]) : 4096;
        const pagesOf = (label) => {
            const m = out.match(new RegExp(label + ':\\s+(\\d+)\\.'));
            return m ? Number(m[1]) : 0;
        };
        // Inactive + purgeable + speculative are reclaimable without swapping.
        const pages = pagesOf('Pages inactive') + pagesOf('Pages purgeable') + pagesOf('Pages speculative');
        return pages * pageSize;
    } catch {
        return 0;
    }
}

const freeBytes = os.freemem();
const availableBytes = freeBytes + reclaimableExtraBytes();
/** Do not touch a footprint we cannot hold: swapping is not a measurement. */
const TOUCH_LIMIT_BYTES = Math.max(0, availableBytes * 0.45);

function runOne(n, touch, door) {
    const r = spawnSync(process.execPath, [SELF], {
        env: {
            ...process.env,
            CEILING_CHILD: String(n),
            CEILING_TOUCH: touch ? '1' : '0',
            CEILING_DOOR: door ? '1' : '0',
        },
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
console.log('touch cap: ' + mb(TOUCH_LIMIT_BYTES) + ' MB (45% of available RAM = free ' +
    mb(freeBytes) + ' MB + reclaimable ' + mb(availableBytes - freeBytes) + ' MB; larger ' +
    'sizes are constructed but not touched, and are reported as such)');
console.log('');
console.log('  size            particles     footprint   status            construct   touch      RSS delta');
console.log('  --------------- ------------- ----------- ----------------- ----------- ---------- -----------');

const rows = [];
for (const n of sizes) {
    const footprint = n * BYTES_PER_PARTICLE;
    const touch = footprint <= TOUCH_LIMIT_BYTES;
    const r = runOne(n, touch, n === CANDIDATE);
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

// P-25: a criterion whose evidence could not be MEASURED (as opposed to measured
// and failed) reports SKIP, never PASS and never FAIL. C2/C3/C4 all require the
// candidate to have been TOUCHED; if the available-RAM budget prevented that, the
// gate is inconclusive, not failed -- the candidate was never shown broken.
const touchMeasured = !!(cand && cand.touched === true);
const skipDetail = 'candidate not touched (available RAM budget ' + mb(TOUCH_LIMIT_BYTES) +
    ' MB < footprint ' + mb(expectedRss) + ' MB) -- UNMEASURED, re-run with more free RAM';

const checks = [
    ['C1 candidate constructs',
        cand && cand.status === 'CONSTRUCTED',
        cand ? cand.status : 'missing'],
    ['C2 all 7 lanes writable + read back',
        touchMeasured ? (cand.readbackOk === true) : 'SKIP',
        touchMeasured ? 'readbackOk=' + cand.readbackOk : skipDetail],
    ['C3 RSS within ' + (RSS_TOLERANCE * 100) + '% of analytic ' + mb(expectedRss) + ' MB',
        touchMeasured
            ? (cand.rssDeltaBytes !== undefined &&
               Math.abs(cand.rssDeltaBytes - expectedRss) <= expectedRss * RSS_TOLERANCE)
            : 'SKIP',
        touchMeasured && cand.rssDeltaBytes !== undefined ? 'measured ' + mb(cand.rssDeltaBytes) + ' MB' : skipDetail],
    ['C4 construct+touch <= ' + TIME_BUDGET_MS + ' ms',
        touchMeasured
            ? (cand.constructMs !== undefined &&
               (cand.constructMs + (cand.touchMs || 0)) <= TIME_BUDGET_MS)
            : 'SKIP',
        touchMeasured && cand.constructMs !== undefined
            ? (cand.constructMs + (cand.touchMs || 0)).toFixed(0) + ' ms' : skipDetail],
    // An unobserved abort is NOT evidence of margin -- it means the sweep never
    // reached the failure mode, so there is nothing to be 128x below. C5 must
    // fail in that case rather than pass on Infinity / CANDIDATE >= MARGIN.
    ['C5 candidate >= ' + MARGIN + 'x below abort threshold',
        abortThreshold !== Infinity && abortThreshold / CANDIDATE >= MARGIN,
        abortThreshold === Infinity
            ? 'NO ABORT OBSERVED -- the sweep never reached the failure mode, so ' +
              'there is no measured threshold to sit below'
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
    // C1-C7 measure the ALLOCATOR through raw lanes. C8 is the only criterion
    // that touches the shipped constructor, and it exists so the library's cap
    // cannot drift away from the evidence in this file without a run turning red.
    ['C8 shipped constructor enforces exactly this ceiling',
        cand && cand.moduleMax === CANDIDATE &&
        cand.doorAccepts === true && cand.doorRejectsOver === true,
        cand && cand.moduleMax === undefined
            ? 'door not probed (candidate row missing)'
            : 'MAX_PARTICLES=' + (cand && pow2(cand.moduleMax)) +
              (cand && cand.moduleMax !== CANDIDATE ? ' != candidate ' + pow2(CANDIDATE) + ' -- DRIFT' : '') +
              '; accepts n=' + (cand && cand.doorAccepts) +
              ', rejects n+1 with a branded RangeError=' + (cand && cand.doorRejectsOver)],
];

console.log('');
console.log('VERDICT for MAX_PARTICLES = ' + pow2(CANDIDATE));
// Tri-state: a check's second element is `true` (PASS), `false` (FAIL), or the
// literal string 'SKIP' (UNMEASURED). A skipped criterion is NEVER a pass.
let anyFail = false;
let anySkip = false;
for (const [label, ok, detail] of checks) {
    const status = ok === 'SKIP' ? 'SKIP' : (ok ? 'PASS' : 'FAIL');
    if (status === 'FAIL') anyFail = true;
    if (status === 'SKIP') anySkip = true;
    console.log('  ' + status + '  ' + label.padEnd(54) + detail);
}
console.log('');

if (anyFail) {
    // A genuine measured failure takes precedence over any unmeasured criterion:
    // the candidate was shown broken.
    console.log('FAIL -- the candidate is NOT supported. Per the pre-committed fail action,');
    console.log('        pick another value from the table above. Do not widen a criterion.');
    process.exit(1);
}

if (anySkip) {
    // The load-bearing rule (P-25): a criterion that did not run must never report
    // PASS, and the run as a whole must not claim support it did not measure. This
    // is distinct from FAIL -- nothing was shown broken -- and still exits non-zero
    // so CI cannot mistake an unmeasured run for a green one. S3.1's T8 (peers
    // absent) is the next gate that needs this status to exist.
    console.log('INCONCLUSIVE -- one or more criteria could not be MEASURED on this host');
    console.log('        (see SKIP above). The candidate was NOT shown broken, but neither');
    console.log('        was it proven supported. Re-run on a host with more free/reclaimable');
    console.log('        RAM. An unmeasured run is not a pass.');
    process.exit(2);
}

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
