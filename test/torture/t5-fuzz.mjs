/**
 * T5 -- differential fuzz against an AoS oracle (S3).
 *
 * The SoA engine keeps particles in flat f32 lanes and integrates them through a
 * caller-supplied onTick, driven here by tick(dt). The ORACLE is a plain
 * array-of-structs particle system with the identical ring semantics and the
 * identical physics, driven through the SAME seeded emit sequence and the SAME dt
 * sequence. If the two ever disagree on which slots are alive, or on a live slot's
 * (x, y, vx, vy, life) beyond an f32 tolerance, the run dies with the seed, the
 * frame index, the op index and a minimal replay.
 *
 * The oracle is DELIBERATELY SLOW and OBVIOUSLY CORRECT and is never optimized:
 * one plain object per slot, one branch per slot per frame, Math.fround at every
 * store so it models the f32 lanes exactly. Its only job is to be a second,
 * independent implementation -- if it were clever it could share the engine's bug.
 *
 * The emit corpus INCLUDES rejected emits (out-of-band x, sub-floor life, a
 * hostile dataFlag) and the dt corpus INCLUDES clamped and rejected dt, so the
 * emit()==-1 receipt, the tick() low-side rejection, and the byte-identical
 * guarantee are all inside the fuzz and not only in the named T0/T4 cases.
 *
 * `makeOracle` and `diverge` are exported so T9's deliberately-wrong-oracle
 * control can prove the comparator actually bites.
 */

import { SoaParticleEngine, LANE_MAX, LIFE_MIN, LIFE_MAX } from '../../SoaParticleEngine.js';
import { makePrng, SEED, check } from './harness.mjs';
import { Random } from '@zakkster/lite-random';

const MAX = 128;          // ring size
const FRAMES = 10000;     // frames driven through tick(dt)
const EMITS_PER_FRAME = 3;
const G = 400;            // gravity, applied to vy each step
const TOL = 1e-3;         // f32 slack; fround-matched stores make real divergence ~0

/** The one physics definition, shared by the engine callback and the oracle. */
export function integrateLanes(dt, x, y, vx, vy, life, invLife, data, max) {
    for (let s = 0; s < max; s++) {
        if (life[s] <= 0) continue;
        life[s] -= dt;
        vy[s] += G * dt;
        x[s] += vx[s] * dt;
        y[s] += vy[s] * dt;
    }
}

/** Same accept/reject door the engine's emit() applies, so the ring stays in sync. */
function emitAccepted(x, y, vx, vy, life, dataFlag) {
    if (!(typeof x === 'number' && x >= -LANE_MAX && x <= LANE_MAX)) return false;
    if (!(typeof y === 'number' && y >= -LANE_MAX && y <= LANE_MAX)) return false;
    if (!(typeof vx === 'number' && vx >= -LANE_MAX && vx <= LANE_MAX)) return false;
    if (!(typeof vy === 'number' && vy >= -LANE_MAX && vy <= LANE_MAX)) return false;
    if (!(typeof life === 'number' && life >= LIFE_MIN && life <= LIFE_MAX)) return false;
    if (!(typeof dataFlag === 'number' && (dataFlag | 0) === dataFlag)) return false;
    return true;
}

/**
 * The array-of-structs oracle. One object per ring slot, its own head cursor,
 * Math.fround at every store. `physicsG` lets a control build a DELIBERATELY WRONG
 * oracle (a different gravity) so the comparator can be shown non-vacuous.
 */
export function makeOracle(max, maxDt, physicsG) {
    const g = physicsG === undefined ? G : physicsG;
    const slots = new Array(max);
    for (let i = 0; i < max; i++) slots[i] = { x: 0, y: 0, vx: 0, vy: 0, life: 0, invLife: 0, data: 0 };
    let head = 0;
    return {
        emit(x, y, vx, vy, life, dataFlag) {
            if (!emitAccepted(x, y, vx, vy, life, dataFlag)) return -1;
            const o = slots[head];
            o.x = Math.fround(x); o.y = Math.fround(y);
            o.vx = Math.fround(vx); o.vy = Math.fround(vy);
            o.life = Math.fround(life); o.invLife = Math.fround(1 / life);
            o.data = dataFlag | 0;
            const i = head;
            head = (head + 1) % max;
            return i;
        },
        // Mirrors emitBurst EXACTLY: same door, same envelope, same 3-draw order
        // (angle, speed, life), same store through this.emit (which frounds). Given
        // the same rng stream the oracle and engine land on byte-identical lanes.
        burst(x, y, count, rng, spec) {
            const r = rng;
            if (!(typeof x === 'number' && x >= -LANE_MAX && x <= LANE_MAX)) return -1;
            if (!(typeof y === 'number' && y >= -LANE_MAX && y <= LANE_MAX)) return -1;
            if (!(typeof count === 'number' && count >= 1 && (count | 0) === count)) return -1;
            if (!(r !== null && typeof r === 'object' && typeof r.next === 'function')) return -1;
            const useSpec = (spec === null || spec === undefined) ? {} : spec;
            const rSpeed = useSpec.speed, rSpeedVar = useSpec.speedVar,
                  rAngle = useSpec.angle, rAngleVar = useSpec.angleVar,
                  rLife = useSpec.life, rLifeVar = useSpec.lifeVar, rData = useSpec.data;
            const speed    = rSpeed    === undefined ? 100     : rSpeed;
            const speedVar = rSpeedVar === undefined ? 0       : rSpeedVar;
            const angle    = rAngle    === undefined ? 0       : rAngle;
            const angleVar = rAngleVar === undefined ? Math.PI : rAngleVar;
            const life     = rLife     === undefined ? 1       : rLife;
            const lifeVar  = rLifeVar  === undefined ? 0       : rLifeVar;
            const data     = rData     === undefined ? 0       : rData;
            if (!(typeof speed === 'number' && typeof speedVar === 'number' &&
                  typeof angle === 'number' && typeof angleVar === 'number' &&
                  typeof life  === 'number' && typeof lifeVar  === 'number' &&
                  typeof data  === 'number' && (data | 0) === data)) return -1;
            if (!(angle    >= -LANE_MAX && angle    <= LANE_MAX)) return -1;
            if (!(angleVar >= -LANE_MAX && angleVar <= LANE_MAX)) return -1;
            if (!(Math.abs(speed) + Math.abs(speedVar) <= LANE_MAX)) return -1;
            const loLife = life - lifeVar, hiLife = life + lifeVar;
            if (!(loLife >= LIFE_MIN && loLife <= LIFE_MAX &&
                  hiLife >= LIFE_MIN && hiLife <= LIFE_MAX)) return -1;
            let n = 0;
            for (let k = 0; k < count; k++) {
                const a = angle + (r.next() * 2 - 1) * angleVar;
                const sp = speed + (r.next() * 2 - 1) * speedVar;
                const l = life  + (r.next() * 2 - 1) * lifeVar;
                if (this.emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, l, data) !== -1) n++;
            }
            return n;
        },
        tick(dt) {
            if (!(typeof dt === 'number' && dt >= 0)) return false;
            if (dt > maxDt) dt = maxDt;
            for (let s = 0; s < max; s++) {
                const o = slots[s];
                if (o.life <= 0) continue;
                o.life = Math.fround(o.life - dt);
                o.vy = Math.fround(o.vy + g * dt);
                o.x = Math.fround(o.x + o.vx * dt);
                o.y = Math.fround(o.y + o.vy * dt);
            }
            return true;
        },
        slots,
        get head() { return head; },
    };
}

/** Count live slots (life > 0) in an engine. */
function liveCountEngine(engine) {
    let n = 0;
    for (let s = 0; s < engine.max; s++) if (engine.life[s] > 0) n++;
    return n;
}

/** Count live slots in an oracle. */
function liveCountOracle(oracle) {
    let n = 0;
    for (let s = 0; s < oracle.slots.length; s++) if (oracle.slots[s].life > 0) n++;
    return n;
}

/**
 * Compare the two live populations. Returns null on agreement, or a reason string
 * on divergence: the live-count mismatch, or the first sorted-tuple slot whose
 * (x, y, vx, vy, life) differs by more than `tol`. The tuples are sorted so the
 * comparison does not assume slot alignment.
 */
export function diverge(engine, oracle, tol) {
    const ec = liveCountEngine(engine), oc = liveCountOracle(oracle);
    if (ec !== oc) return 'live count engine=' + ec + ' oracle=' + oc;

    const et = [], ot = [];
    for (let s = 0; s < engine.max; s++) {
        if (engine.life[s] > 0) et.push([engine.x[s], engine.y[s], engine.vx[s], engine.vy[s], engine.life[s]]);
    }
    for (let s = 0; s < oracle.slots.length; s++) {
        const o = oracle.slots[s];
        if (o.life > 0) ot.push([o.x, o.y, o.vx, o.vy, o.life]);
    }
    const key = (t) => t[0] * 1e9 + t[1] * 1e6 + t[2] * 1e3 + t[3] + t[4] * 1e-3;
    et.sort((a, b) => key(a) - key(b));
    ot.sort((a, b) => key(a) - key(b));
    for (let i = 0; i < et.length; i++) {
        for (let k = 0; k < 5; k++) {
            if (Math.abs(et[i][k] - ot[i][k]) > tol) {
                return 'tuple ' + i + ' field ' + k + ' engine=' + et[i][k] + ' oracle=' + ot[i][k] +
                    ' (|diff|=' + Math.abs(et[i][k] - ot[i][k]) + ' > tol ' + tol + ')';
            }
        }
    }
    return null;
}

export function run() {
    const prng = makePrng(SEED);
    const maxDt = 0.1;
    const engine = new SoaParticleEngine(MAX, { maxDt });
    engine.onTick(integrateLanes);
    const oracle = makeOracle(MAX, maxDt);

    for (let f = 0; f < FRAMES; f++) {
        // Emit corpus: mostly valid, ~1-in-6 a deliberate reject. Both the engine
        // and the oracle must make the SAME accept/reject decision and, on accept,
        // land in the SAME slot, or the ring cursors drift and every later frame
        // diverges -- which is itself a real failure this catches.
        for (let e = 0; e < EMITS_PER_FRAME; e++) {
            const r = prng();
            let x, y, vx, vy, life, flag;
            if ((r % 6) === 0) {
                // A rejected emit: pick a cause by the next bits.
                const kind = (r >>> 3) % 3;
                if (kind === 0) { x = 1e300; y = 0; vx = 0; vy = 0; life = 1; flag = 0; }       // x out of f32 band
                else if (kind === 1) { x = 0; y = 0; vx = 0; vy = 0; life = 0; flag = 0; }        // life <= 0
                else { x = 0; y = 0; vx = 0; vy = 0; life = 1; flag = 2.5; }                      // non-int32 flag
            } else {
                x = ((r >>> 2) % 4000) - 2000;
                y = ((r >>> 5) % 4000) - 2000;
                vx = ((r >>> 8) % 800) - 400;
                vy = ((r >>> 11) % 800) - 400;
                life = 0.05 + ((r >>> 14) % 300) / 100; // [0.05, 3.04]
                flag = (r >>> 20) % 1000;
            }
            const re = engine.emit(x, y, vx, vy, life, flag);
            const ro = oracle.emit(x, y, vx, vy, life, flag);
            check(re === ro,
                () => 'T5: emit receipt diverged engine=' + re + ' oracle=' + ro +
                    ' (seed=' + SEED + ' frame=' + f + ' emit=' + e + ')');
        }

        // A burst step (S3.1): both engine and oracle consume the SAME rng stream
        // via two Random instances seeded alike, in the SAME 3-draw order (R3), so
        // they must land on byte-identical lanes. ~1 in 3 frames drives a
        // deliberately envelope-violating spec so the shared -1 path is fuzzed too.
        {
            const rb = prng();
            const seed = (rb ^ (f * 2654435761)) | 0;
            const count = 1 + (rb % 5); // 1..5
            let spec;
            if ((rb % 3) === 0) {
                spec = { speed: LANE_MAX, speedVar: LANE_MAX, life: 1 }; // envelope violation -> both -1
            } else {
                const sp = 40 + (rb % 200);
                spec = { speed: sp, speedVar: (rb % 30), angle: 0, angleVar: Math.PI, life: 0.3 + (rb % 200) / 100, lifeVar: (rb % 10) / 100 };
            }
            const be = engine.emitBurst(20, -10, count, spec, new Random(seed));
            const bo = oracle.burst(20, -10, count, new Random(seed), spec);
            check(be === bo,
                () => 'T5: burst receipt diverged engine=' + be + ' oracle=' + bo +
                    ' (seed=' + SEED + ' frame=' + f + ')');
        }

        // dt corpus: mostly valid, occasionally clamped (> maxDt), occasionally
        // rejected (negative). tick() and the oracle must treat all three the same.
        const rd = prng();
        let dt;
        const dkind = rd % 10;
        if (dkind === 0) dt = -0.01;              // rejected: no advance in either
        else if (dkind === 1) dt = 0.5;           // clamped to maxDt in both
        else dt = 0.008 + (rd % 90) / 1000;       // [0.008, 0.098], within maxDt

        const te = engine.tick(dt);
        const to = oracle.tick(dt);
        check(te === to,
            () => 'T5: tick receipt diverged engine=' + te + ' oracle=' + to +
                ' (seed=' + SEED + ' frame=' + f + ' dt=' + dt + ')');

        const why = diverge(engine, oracle, TOL);
        check(why === null,
            () => 'T5: engine/oracle diverged -- ' + why +
                ' (seed=' + SEED + ' frame=' + f + ' dt=' + dt +
                '); replay with TORTURE_SEED=' + SEED);
    }

    engine.destroy();
}
