/**
 * T9 -- controls. Every gate must be provably able to fail.
 *
 * This tier runs deliberately-broken variants IN PROCESS and asserts the
 * corresponding gate flags each one. If a control slips through, T9 fails the run
 * -- a gate that cannot fail is decorative. Each control also proves it is NOT
 * vacuous: it confirms the checker reports healthy on a valid input first.
 *
 * A control must not assert a behaviour the package does not have yet, so S1's
 * controls cover only the gates S1 actually wired: the alloc gate, the raw-mode
 * head invariant (T7), the per-lane byteLength pin (T6), and the lane-diff
 * backbone of T0's total-rejection law.
 *
 * The whole-suite control is separate: SOA_TORTURE_BREAK=1 injects retained
 * allocations into T6 and exits non-zero. T9 exercises the same alloc lane here
 * so a plain run already proves the gate bites.
 */

import { SoaParticleEngine, LIFE_MIN, LIFE_MAX, LANE_MAX } from '../../SoaParticleEngine.js';
import { runOpsGate, headInvariant, snapshotLaneBytes, die } from './harness.mjs';
import { run as t1 } from './t1-degenerate.mjs';
import { run as t4 } from './t4-handles.mjs';
import { makeOracle, diverge, integrateLanes } from './t5-fuzz.mjs';

/** Retained sink so the control's allocations survive GC (arrayBuffers grows). */
const leak = [];

/**
 * Whole-tier control (P-19): SOA_TORTURE_REVERT_BAND=1 reverts the x/y/vx/vy
 * guard to v1.0.4's Number.isFinite process-wide, then re-runs the T1 tier, whose
 * band pin MUST die on it. Run both ways and compare the two exit codes: a control
 * you did not observe failing is not a control.
 */
const REVERT = process.env.SOA_TORTURE_REVERT_BAND === '1';

/**
 * Whole-tier control (P-23): SOA_TORTURE_DROP_TYPEOF=1 drops the typeof half of
 * every band/life guard process-wide -- the exact shape of the first S2.1 draft's
 * regression -- then re-runs the T1 tier, whose P-23 non-number corpus pin MUST
 * die on it. Run both ways and compare exit codes.
 */
const DROP_TYPEOF = process.env.SOA_TORTURE_DROP_TYPEOF === '1';

/**
 * Whole-tier control (P-24): SOA_TORTURE_DROP_DATAFLAG_TYPEOF=1 reverts the
 * dataFlag guard to v1.0.4's typeof-less `(dataFlag | 0) !== dataFlag`
 * process-wide, then drives a hostile emit. `|` reaches ToNumeric on a BigInt and
 * THROWS, breaking emit()'s never-throws contract, so the run MUST exit non-zero.
 * Run both ways and compare exit codes.
 */
const DROP_DATAFLAG_TYPEOF = process.env.SOA_TORTURE_DROP_DATAFLAG_TYPEOF === '1';

/**
 * S3 whole-tier controls, one per new gate. Each reverts a shipped method
 * process-wide and re-runs the T4 tier, whose corresponding flipped/new pin MUST
 * die. Run both ways and compare exit codes: a control you did not observe failing
 * is not a control.
 *   SOA_TORTURE_TICK_BARE_CLAMP     -- tick() with dt's typeof + low-side guard
 *                                      dropped to a bare `dt > maxDt` clamp (D3).
 *   SOA_TORTURE_ONTICK_NO_VALIDATE  -- onTick() stores any value unvalidated (P-27).
 *   SOA_TORTURE_START_MUTATE_FIRST  -- start() mutates state before the RAF check (P-28).
 *   SOA_TORTURE_LOOP_UNGUARDED_REARM-- _loop() re-arms RAF unconditionally (P-26).
 *   SOA_TORTURE_LOOP_ADVANCE_ALWAYS -- _loop() advances _lastTime on a bad clock (D8).
 */
const TICK_BARE_CLAMP = process.env.SOA_TORTURE_TICK_BARE_CLAMP === '1';
const ONTICK_NO_VALIDATE = process.env.SOA_TORTURE_ONTICK_NO_VALIDATE === '1';
const START_MUTATE_FIRST = process.env.SOA_TORTURE_START_MUTATE_FIRST === '1';
const LOOP_UNGUARDED_REARM = process.env.SOA_TORTURE_LOOP_UNGUARDED_REARM === '1';
const LOOP_ADVANCE_ALWAYS = process.env.SOA_TORTURE_LOOP_ADVANCE_ALWAYS === '1';

/**
 * The reverted emit: v1.0.4's Number.isFinite guard for x/y/vx/vy (which passes
 * for any finite f64, so 1e300 stores as Infinity), life band and dataFlag
 * unchanged. Installed on the prototype only under SOA_TORTURE_REVERT_BAND.
 */
function revertedEmit(x, y, vx, vy, life, dataFlag = 0) {
    if (this._destroyed) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) return;
    if (!(life >= LIFE_MIN && life <= LIFE_MAX)) return;
    if ((dataFlag | 0) !== dataFlag) return;
    const i = this._head;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.invLife[i] = 1.0 / life;
    this.data[i] = dataFlag;
    this._head = (i + 1) % this.max;
}

/**
 * The typeof-less emit: the shipped band relational tests with the typeof half
 * REMOVED (the P-23 draft regression). Relational operators coerce, so null,
 * "5", true and [7] are laundered into a lane. Installed on the prototype only
 * under SOA_TORTURE_DROP_TYPEOF.
 */
function noTypeofEmit(x, y, vx, vy, life, dataFlag = 0) {
    if (this._destroyed) return;
    if (!(x  >= -LANE_MAX && x  <= LANE_MAX)) return;
    if (!(y  >= -LANE_MAX && y  <= LANE_MAX)) return;
    if (!(vx >= -LANE_MAX && vx <= LANE_MAX)) return;
    if (!(vy >= -LANE_MAX && vy <= LANE_MAX)) return;
    if (!(life >= LIFE_MIN && life <= LIFE_MAX)) return;
    if ((dataFlag | 0) !== dataFlag) return;
    const i = this._head;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.invLife[i] = 1.0 / life;
    this.data[i] = dataFlag;
    this._head = (i + 1) % this.max;
}

/**
 * The typeof-less dataFlag emit: the shipped guards with the dataFlag typeof half
 * REMOVED (the v1.0.4 shape). `(dataFlag | 0)` reaches ToNumeric, which THROWS on
 * a BigInt/Symbol and runs caller code for objects. Installed on the prototype
 * only under SOA_TORTURE_DROP_DATAFLAG_TYPEOF.
 */
function noTypeofDataFlagEmit(x, y, vx, vy, life, dataFlag = 0) {
    if (this._destroyed) return;
    if (!(typeof x  === 'number' && x  >= -LANE_MAX && x  <= LANE_MAX)) return;
    if (!(typeof y  === 'number' && y  >= -LANE_MAX && y  <= LANE_MAX)) return;
    if (!(typeof vx === 'number' && vx >= -LANE_MAX && vx <= LANE_MAX)) return;
    if (!(typeof vy === 'number' && vy >= -LANE_MAX && vy <= LANE_MAX)) return;
    if (!(typeof life === 'number' && life >= LIFE_MIN && life <= LIFE_MAX)) return;
    if ((dataFlag | 0) !== dataFlag) return; // typeof half dropped -- throws on BigInt/Symbol
    const i = this._head;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.invLife[i] = 1.0 / life;
    this.data[i] = dataFlag;
    this._head = (i + 1) % this.max;
}

/**
 * The reverted tick(): the shipped clamp with the typeof + low-side `dt >= 0`
 * guard DROPPED to a bare `dt > maxDt` clamp (the pre-D3 shape). '0.05' coerces
 * past the clamp and is handed to the callback; -1 runs the sim backwards;
 * Symbol() throws in the relational operator. Installed only under the env var.
 */
function bareClampTick(dt) {
    if (this._destroyed) return false;
    if (dt > this.maxDt) dt = this.maxDt; // bare clamp: no typeof, no low-side reject
    if (this._onTick === null) return false;
    this._onTick(dt, this.x, this.y, this.vx, this.vy, this.life, this.invLife, this.data, this.max);
    return true;
}

/** The reverted onTick(): stores any value unvalidated (P-27). */
function unvalidatedOnTick(callback) {
    this._onTick = callback;
}

/** The reverted start(): mutates _isRunning/_lastTime BEFORE the RAF check (P-28). */
function mutateFirstStart() {
    if (this._isRunning || this._destroyed) return;
    this._isRunning = true;
    this._lastTime = performance.now();
    this._rafId = requestAnimationFrame(this._loop); // throws AFTER mutating when no RAF
}

/** The reverted _loop(): re-arms RAF unconditionally after the callback (P-26). */
function unguardedRearmLoop(time) {
    if (!this._isRunning || this._destroyed) return;
    if (typeof time === 'number' && time >= this._lastTime) {
        const dt = (time - this._lastTime) / 1000;
        this._lastTime = time;
        this.tick(dt);
    }
    this._rafId = requestAnimationFrame(this._loop); // UNCONDITIONAL re-arm
}

/** The reverted _loop(): advances _lastTime on ANY clock reading (the D8 revert). */
function advanceAlwaysLoop(time) {
    if (!this._isRunning || this._destroyed) return;
    const dt = (time - this._lastTime) / 1000;
    this._lastTime = time; // advanced unconditionally -- a NaN reading poisons it forever
    this.tick(dt);
    if (this._isRunning && !this._destroyed) {
        this._rafId = requestAnimationFrame(this._loop);
    }
}

export function run() {
    // Control 1 -- the alloc gate. A hot body that retains an allocation every
    // iteration MUST be rejected by runOpsGate (maxArrayBuffersGrowth:0). Proven
    // non-vacuous by control 1b below (a clean body passes the same gate).
    {
        const { report } = runOpsGate(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
        if (report.ok) die('T9 control: an allocating hot loop passed the zero-alloc gate');
        leak.length = 0; // release the control's garbage
    }

    // Control 1b -- the alloc gate is not a blanket reject. A zero-alloc body must
    // PASS, so control 1 is a real property and not a gate that fails on anything.
    {
        const e = new SoaParticleEngine(64);
        const clean = (i) => { e.emit(i & 63, 0, 1, -1, 0.5, i & 15); };
        const { report } = runOpsGate(clean, { ops: 8000, warmup: 500 });
        if (!report.ok) die('T9 control: a zero-alloc emit loop was rejected by the alloc gate (gate is not discriminating)');
        e.destroy();
    }

    // Control 2 -- the raw-mode head invariant (the T7 checker). Healthy first,
    // then each fabricated corruption must be caught.
    {
        const e = new SoaParticleEngine(8);
        e.emit(0, 0, 0, 0, 1);
        if (!headInvariant(e)) die('T9 control: head invariant false on a valid engine (checker is broken)');
        e._head = 1.5;
        if (headInvariant(e)) die('T9 control: head invariant held for a non-integer _head');
        e._head = e.max;
        if (headInvariant(e)) die('T9 control: head invariant held for _head === max (out of range)');
        e._head = -1;
        if (headInvariant(e)) die('T9 control: head invariant held for a negative _head');
        e._head = NaN;
        if (headInvariant(e)) die('T9 control: head invariant held for a NaN _head (the P-04 shape)');
        e.destroy();
    }

    // Control 3 -- the per-lane byteLength pin (the T6 structural assertion). The
    // equality that backs it must DETECT a changed size and PASS an unchanged one.
    {
        const e = new SoaParticleEngine(16);
        const before = new Float64Array(7);
        snapshotLaneBytes(e, before);
        // The x lane is unchanged -> the pin holds.
        if (e.x.buffer.byteLength !== before[0]) die('T9 control: byteLength pin reported a change on an untouched lane');
        // Fabricate a "before" that is one element larger -> the pin must flag it.
        before[0] += 4;
        if (e.x.buffer.byteLength === before[0]) die('T9 control: byteLength pin cannot detect a changed backing store');
        e.destroy();
    }

    // Control 4 -- the lane-diff backbone of T0's total-rejection law. An accepted
    // emit MUST change a lane cell, and a rejected emit MUST change nothing -- so
    // "byte-identical after a rejected emit" is a real property, not a no-op on an
    // engine that never changes.
    {
        const e = new SoaParticleEngine(4);
        const life0 = e.life[0];
        e.emit(1, 2, 3, 4, 1.5, 9);
        if (e.life[0] === life0) die('T9 control: an accepted emit did not change the life lane (the rejection law would be vacuous)');
        const snap = e.life[0];
        e.emit(NaN, 0, 0, 0, 1);          // rejected
        if (e.life[0] !== snap) die('T9 control: a rejected emit changed the life lane');
        if (e._head !== 1) die('T9 control: a rejected emit advanced the head');
        e.destroy();
    }

    // Control 5 -- the dt clamp law, now measured through tick() (R6). After S3
    // task 5 _loop() no longer clamps: it computes dt from the clock and delegates
    // to tick(), where the single clamp site lives. So a 101 ms gap driven through
    // _loop measures TICK's clamp, not _loop's -- relabelled accordingly. Prove the
    // law CATCHES the reverted 0.016 fabrication, then holds for the real engine
    // via BOTH paths: _loop(101) (the clock path) and tick(0.101) (direct).
    {
        const maxDt = 0.1;
        const oldRule = (gapMs) => { let dt = gapMs / 1000; if (dt > 0.1) dt = 0.016; return dt; };
        // Old rule on a 101 ms gap fabricates 0.016, so the clamp predicate is false.
        if (oldRule(101) === maxDt) die('T9 control: the reverted 0.016 dt rule passed the clamp law (the law cannot catch P-02)');

        // Path A -- the clock path: _loop(101) -> tick(0.101) -> clamp to maxDt.
        const e = new SoaParticleEngine(4);
        let dt = NaN;
        e.onTick((d) => { dt = d; });
        e._isRunning = true;
        e._lastTime = 0;
        e._loop(101);
        if (dt !== maxDt) die('T9 control: _loop(101) -> tick clamp failed (dt=' + dt + ')');

        // Path B -- tick() directly: the clamp site under test, no clock involved.
        let dt2 = NaN;
        e.onTick((d) => { dt2 = d; });
        e._isRunning = false;
        if (e.tick(0.101) !== true) die('T9 control: tick(0.101) unexpectedly rejected');
        if (dt2 !== maxDt) die('T9 control: tick(0.101) did not clamp to maxDt (dt=' + dt2 + ')');
        e.destroy();
    }

    // Control 6 -- the constructor-validation law is not vacuous. T1 asserts every
    // garbage arg throws; prove a VALID arg does NOT throw, so the law is a real
    // property and not a constructor that throws on everything.
    {
        let threw = false;
        let e = null;
        try { e = new SoaParticleEngine(16); } catch { threw = true; }
        if (threw) die('T9 control: a valid maxParticles (16) threw (the ctor-validation law would be vacuous)');
        if (e) e.destroy();
    }

    // Control 7 -- the position/velocity band pin (P-19), proven non-vacuous
    // in-process. The reverted Number.isFinite guard ACCEPTS 1e300 (which the f32
    // lane stores as Infinity), so it would violate the T1 band pin; the SHIPPED
    // engine REJECTS it. A pin that both implementations pass is decorative.
    {
        // The reverted guard accepts 1e300 -- and 1e300 genuinely cannot be stored
        // in an f32 lane (it frounds to Infinity), so acceptance is real corruption.
        if (!Number.isFinite(1e300)) die('T9 control: 1e300 is not a finite f64 (premise broken)');
        if (Number.isFinite(Math.fround(1e300))) die('T9 control: 1e300 unexpectedly stores as a finite f32 (the band pin would be pointless)');
        // The shipped engine rejects it: head unmoved, x and vx untouched, on each
        // of the two lanes 1e300 was placed in.
        const e = new SoaParticleEngine(4);
        e.emit(1e300, 0, 1e300, 0, 1);
        if (e._head !== 0) die('T9 control: the shipped engine advanced head on emit(1e300,...) -- the band is not closed');
        if (e.x[0] !== 0 || e.vx[0] !== 0) die('T9 control: the shipped engine wrote a lane on emit(1e300,...) -- the band is not closed');
        e.destroy();
    }

    // Control 8 -- the WHOLE-TIER revert (SOA_TORTURE_REVERT_BAND=1). Swap the
    // shipped band back to Number.isFinite process-wide and re-run T1; its band
    // pin MUST die (process exits non-zero). This block runs ONLY when the env var
    // is set, so a normal run stays green and the reverted run is the observed
    // failure. Run both ways and compare exit codes.
    if (REVERT) {
        SoaParticleEngine.prototype.emit = revertedEmit;
        t1(); // the T1 band pin must call die() here -> process.exit(1)
        // Reaching this line means the reverted band slipped past the T1 pin:
        // that is itself a control failure.
        die('T9 control: SOA_TORTURE_REVERT_BAND reverted the band but T1 still passed (the band pin cannot catch P-19)');
    }

    // Control 9 -- the typeof half (P-23), proven non-vacuous in-process. The
    // shipped engine rejects a coerced non-number in a position lane AND in life;
    // a band without the typeof half would ACCEPT both and store 0 / 1. A pin the
    // typeof-less draft passes is decorative.
    {
        const e = new SoaParticleEngine(4);
        e.emit(null, 0, 0, 0, 1);   // null -> 0 under coercion; typeof must reject
        if (e._head !== 0 || e.x[0] !== 0) die('T9 control: the shipped engine accepted null in the x lane (the typeof half is missing)');
        e.emit(0, 0, 0, 0, '1');    // "1" -> 1 under coercion; typeof must reject
        if (e._head !== 0 || e.life[0] !== 0) die('T9 control: the shipped engine accepted "1" as life (the typeof half is missing on life)');
        // The typeof-less predicate genuinely accepts these -- confirm the premise
        // so the whole-tier control below is not decorative.
        if (!(null >= -LANE_MAX && null <= LANE_MAX)) die('T9 control: premise broken -- null does not coerce into the band');
        if (!('1' >= LIFE_MIN && '1' <= LIFE_MAX)) die('T9 control: premise broken -- "1" does not coerce into the life band');
        e.destroy();
    }

    // Control 10 -- the WHOLE-TIER typeof drop (SOA_TORTURE_DROP_TYPEOF=1). Remove
    // the typeof half from every guard process-wide and re-run T1; its P-23
    // non-number corpus pin MUST die (process exits non-zero). Runs ONLY when the
    // env var is set, so a normal run stays green and the dropped run is the
    // observed failure. Run both ways and compare exit codes.
    if (DROP_TYPEOF) {
        SoaParticleEngine.prototype.emit = noTypeofEmit;
        t1(); // the T1 P-23 corpus pin must call die() here -> process.exit(1)
        die('T9 control: SOA_TORTURE_DROP_TYPEOF dropped the typeof half but T1 still passed (the P-23 corpus pin cannot catch coercion)');
    }

    // Control 11 -- the dataFlag typeof half (P-24), proven non-vacuous in-process.
    // emit()'s never-throws contract is load-bearing. The shipped engine does NOT
    // throw on a hostile dataFlag and rejects it; the typeof-less predicate WOULD
    // throw. A pin both implementations pass is decorative.
    {
        const e = new SoaParticleEngine(4);
        let threw = null;
        try { e.emit(0, 0, 0, 0, 1, 10n); } catch (err) { threw = String(err); }
        if (threw) die('T9 control: the shipped engine THREW on a BigInt dataFlag (the typeof half is missing) -- ' + threw);
        if (e._head !== 0 || e.data[0] !== 0) die('T9 control: the shipped engine accepted a BigInt dataFlag');
        e.destroy();
        // Premise: the typeof-less operator genuinely throws, so the whole-tier
        // control below is not decorative.
        let premiseThrew = false;
        try { void (10n | 0); } catch { premiseThrew = true; }
        if (!premiseThrew) die('T9 control: premise broken -- (10n | 0) did not throw');
    }

    // Control 12 -- the WHOLE-TIER dataFlag typeof drop (SOA_TORTURE_DROP_DATAFLAG_TYPEOF=1).
    // Revert the dataFlag guard to v1.0.4's typeof-less form process-wide and drive
    // a hostile emit; the `|` reaches ToNumeric on a BigInt and THROWS, so this run
    // MUST exit non-zero. Runs ONLY under the env var, so a normal run stays green
    // and the reverted run is the observed failure. Run both ways, compare exit codes.
    if (DROP_DATAFLAG_TYPEOF) {
        SoaParticleEngine.prototype.emit = noTypeofDataFlagEmit;
        const e = new SoaParticleEngine(4);
        let threw = null;
        try { e.emit(0, 0, 0, 0, 1, 10n); } catch (err) { threw = String(err); }
        if (threw) die('T9 control: SOA_TORTURE_DROP_DATAFLAG_TYPEOF made emit() THROW on a BigInt dataFlag (P-24), as it must -- ' + threw);
        die('T9 control: SOA_TORTURE_DROP_DATAFLAG_TYPEOF did not make emit() throw -- the P-24 pin cannot catch the regression');
    }

    // Control 13 -- the T5 differential comparator is not vacuous. A CORRECT oracle
    // tracks the engine tuple-for-tuple (diverge returns null); a DELIBERATELY
    // WRONG oracle (a different gravity) is flagged. A comparator that passed both
    // would certify nothing. life is kept high so no particle expires -- a wrong
    // oracle is invisible if everything is already dead.
    {
        const maxDt = 0.1;
        const e = new SoaParticleEngine(16, { maxDt });
        e.onTick(integrateLanes);
        const good = makeOracle(16, maxDt);        // default gravity -- matches the engine
        const bad = makeOracle(16, maxDt, 800);    // wrong gravity -- must be caught
        for (let i = 0; i < 16; i++) {
            const x = i - 8, y = i, vx = (i & 3) - 1, vy = 1, life = 5.0, flag = i;
            e.emit(x, y, vx, vy, life, flag);
            good.emit(x, y, vx, vy, life, flag);
            bad.emit(x, y, vx, vy, life, flag);
        }
        for (let f = 0; f < 10; f++) { e.tick(0.05); good.tick(0.05); bad.tick(0.05); }
        if (diverge(e, good, 1e-3) !== null)
            die('T9 control: the T5 comparator flagged a CORRECT oracle (it is over-sensitive / broken)');
        if (diverge(e, bad, 1e-3) === null)
            die('T9 control: the T5 comparator did NOT flag a wrong-gravity oracle (it cannot catch physics divergence)');
        e.destroy();
    }

    // Control 14 -- WHOLE-TIER tick() revert (SOA_TORTURE_TICK_BARE_CLAMP=1). Drop
    // the typeof + low-side guard to a bare `dt > maxDt` clamp and re-run T4; its
    // D3 dt pin MUST die ('0.05' is laundered / Symbol() throws / -1 accepted).
    if (TICK_BARE_CLAMP) {
        SoaParticleEngine.prototype.tick = bareClampTick;
        t4();
        die('T9 control: SOA_TORTURE_TICK_BARE_CLAMP reverted tick() but T4 still passed (the D3 dt pin cannot catch the bare clamp)');
    }

    // Control 15 -- WHOLE-TIER onTick() revert (SOA_TORTURE_ONTICK_NO_VALIDATE=1).
    // Store any value unvalidated and re-run T4; its P-27 pin MUST die (onTick(42)
    // no longer throws at the door).
    if (ONTICK_NO_VALIDATE) {
        SoaParticleEngine.prototype.onTick = unvalidatedOnTick;
        t4();
        die('T9 control: SOA_TORTURE_ONTICK_NO_VALIDATE reverted onTick() but T4 still passed (the P-27 pin cannot catch the unvalidated store)');
    }

    // Control 16 -- WHOLE-TIER start() revert (SOA_TORTURE_START_MUTATE_FIRST=1).
    // Mutate _isRunning/_lastTime before the RAF check and re-run T4; its P-08/P-28
    // pin MUST die (a failed start() leaves the engine running and the throw is a
    // bare ReferenceError, not the named library error).
    if (START_MUTATE_FIRST) {
        SoaParticleEngine.prototype.start = mutateFirstStart;
        t4();
        die('T9 control: SOA_TORTURE_START_MUTATE_FIRST reverted start() but T4 still passed (the P-28 pin cannot catch mutate-before-validate)');
    }

    // Control 17 -- WHOLE-TIER _loop() re-arm revert (SOA_TORTURE_LOOP_UNGUARDED_REARM=1).
    // Re-arm RAF unconditionally and re-run T4; its flipped P-26 pin MUST die (a
    // destroy()-during-onTick leaves an orphaned frame, PUMP.pending() === true).
    if (LOOP_UNGUARDED_REARM) {
        SoaParticleEngine.prototype._loop = unguardedRearmLoop;
        t4();
        die('T9 control: SOA_TORTURE_LOOP_UNGUARDED_REARM reverted the re-arm but T4 still passed (the P-26 pin cannot catch the orphaned frame)');
    }

    // Control 18 -- WHOLE-TIER _loop() clock revert (SOA_TORTURE_LOOP_ADVANCE_ALWAYS=1).
    // Advance _lastTime on any clock reading (the D8 revert) and re-run T4; its D8
    // self-heal pin MUST die (a NaN reading poisons _lastTime permanently).
    if (LOOP_ADVANCE_ALWAYS) {
        SoaParticleEngine.prototype._loop = advanceAlwaysLoop;
        t4();
        die('T9 control: SOA_TORTURE_LOOP_ADVANCE_ALWAYS reverted the clock guard but T4 still passed (the D8 pin cannot catch _lastTime poisoning)');
    }
}
