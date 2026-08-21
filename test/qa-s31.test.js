/**
 * QA S3.1 (v1.2.0) -- boundary coverage the planner/coder/reviewer rounds did
 * not exercise, found by attacking the ONE claim S3.1 rests on: R4's collapse
 * law, "an accepted burst returns exactly `count`". `SoaParticleEngine.js` is
 * frozen for this stage; this file only adds tests, it never edits production
 * code.
 *
 * QA found P-32 here. The collapse law is stated UNCONDITIONALLY at six sites
 * (SoaParticleEngine.js:129, :334, :375, :387; SoaParticleEngine.d.ts:95;
 * llms.txt:56; README.md:104). It is falsifiable two ways, neither of which
 * makes emitBurst throw and neither of which the wording excludes:
 *
 *   (a) CALLER CODE MUTATES THE ENGINE MID-BURST. `_destroyed` is read ONCE,
 *       at the top of emitBurst. An `rng.next()` that calls `destroy()` part
 *       way through leaves every remaining per-particle `emit()` returning -1,
 *       so the burst reports fewer stores than `count`. The rng here honours
 *       its `.next() -> [0,1)` contract perfectly; this is not an RNG-contract
 *       violation at all, which is why the return-contract scope clause the
 *       reviewer round added to the THROW enumeration does not cover it.
 *
 *   (b) AN RNG RETURNING A NUMBER OUTSIDE [0, 1). The once-per-burst envelope
 *       proves every drawn value lands inside emit()'s bands, but that proof
 *       assumes the multiplier `(d * 2 - 1)` lies in [-1, 1). A `next()`
 *       returning 2 makes the multiplier 3, so `s = speed + 3 * speedVar`
 *       escapes LANE_MAX and every store is rejected. Reachable without anyone
 *       writing a bad number on purpose: an `rng.next()` returning a plain
 *       object coerces to NaN at the `next() * 2` site, and NaN fails every
 *       band.
 *
 * NOT a regression: emitBurst is new in 1.2.0, so there is no v1.1.0 behaviour
 * to regress from. The BEHAVIOUR in both cases is arguably correct -- the
 * return is an honest count of what was stored, and swallowing caller code or
 * validating `next()`'s return per draw are both changes this session did not
 * decide on. The defect is the unconditional WORDING of the law. Recorded, not
 * repaired, for the same reason S3 recorded P-29 rather than patching it after
 * review: scoping a shipped claim is a decision, and adding one post-approval
 * is the mid-flight widening the S2 -> S2.1 split exists to prevent.
 *
 * These tests pin CURRENT behaviour. They are not a demand that it change.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SoaParticleEngine, LANE_MAX } from '../SoaParticleEngine.js';

describe('P-32 -- the collapse law is falsifiable (pinned as current behaviour)', () => {
    test('(a) rng.next() destroying the engine mid-burst returns fewer than count', () => {
        const e = new SoaParticleEngine(8);
        let k = 0;
        // Honours .next() -> [0, 1) exactly. The contract violation is not here.
        const rng = { next() { if (++k === 4) e.destroy(); return 0.5; } };

        const ret = e.emitBurst(0, 0, 5, {}, rng);

        assert.equal(ret, 1, 'stores land only until destroy() takes effect');
        assert.notEqual(ret, 5, 'the collapse law would require exactly count');
        assert.equal(e._destroyed, true);
        assert.equal(e.life, null, 'destroy() nulled the lanes mid-burst');
    });

    test('(a) it does not throw -- the burst reports the shortfall only in its return', () => {
        const e = new SoaParticleEngine(8);
        let k = 0;
        const rng = { next() { if (++k === 4) e.destroy(); return 0.5; } };
        assert.doesNotThrow(() => e.emitBurst(0, 0, 5, {}, rng));
    });

    test('(b) an rng returning a number outside [0,1) breaks the envelope proof', () => {
        const spec = { speed: 1e38, speedVar: 2e38, life: 1, lifeVar: 0 };
        // |speed| + |speedVar| = 3e38 <= LANE_MAX, so the envelope ACCEPTS the
        // burst -- its bound assumes a multiplier in [-1, 1).
        assert.ok(Math.abs(spec.speed) + Math.abs(spec.speedVar) <= LANE_MAX);

        const at = v => new SoaParticleEngine(16).emitBurst(0, 0, 4, spec, { next: () => v });

        assert.equal(at(0.5), 4, 'in contract: the law holds');
        assert.equal(at(1.0), 4, 'at the excluded upper bound: still holds');
        assert.equal(at(2), 0, 'multiplier 3 pushes s past LANE_MAX; every store rejected');
        assert.equal(at(-1), 0, 'multiplier -3 does the same on the negative side');
        assert.equal(at(NaN), 0, 'NaN fails every band');
    });

    test('(b) a next() returning a plain object reaches the NaN path by coercion', () => {
        const e = new SoaParticleEngine(16);
        // {} coerces to NaN at the `next() * 2` site -- no throw, no diagnostic.
        const ret = e.emitBurst(0, 0, 4, { speed: 100, speedVar: 10 }, { next: () => ({}) });
        assert.equal(ret, 0);
        assert.equal(e._head, 0, 'nothing was stored, and the cursor never moved');
    });

    test('the law DOES hold for every in-contract rng, which is what makes the wording the defect', () => {
        const spec = { speed: 1e38, speedVar: 2e38, life: 1, lifeVar: 0 };
        for (const v of [0, 0.25, 0.5, 0.75, 0.999999]) {
            assert.equal(
                new SoaParticleEngine(16).emitBurst(0, 0, 4, spec, { next: () => v }), 4,
                'in-contract draw ' + v + ' must store exactly count');
        }
    });
});

describe('S3.1 -- claims that DO hold, verified rather than assumed', () => {
    test('replay parity holds across all seven lanes, data (Int32Array) included', () => {
        const L = ['x', 'y', 'vx', 'vy', 'life', 'invLife', 'data'];
        const snap = e => L.map(k => Buffer.from(e[k].buffer.slice(0)).toString('hex')).join('|');
        // A local deterministic PRNG: the parity claim is about seed parity, not
        // about any particular generator, and node:test must not need a devDep.
        const mk = seed => { let s = seed >>> 0;
            return { next() { s = (s + 0x6D2B79F5) >>> 0;
                let t = s; t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296; } }; };
        const script = rng => { const e = new SoaParticleEngine(16, { maxDt: Infinity });
            e.onTick(() => {});
            for (let f = 0; f < 12; f++) {
                e.emitBurst(f, f, 4, { speed: 80, speedVar: 40, life: 2, lifeVar: 0.5, data: f }, rng);
                e.tick(1 / 60);
            }
            return snap(e); };

        assert.equal(script(mk(12345)), script(mk(12345)), 'same seed, two instances -> identical');

        const shared = mk(999);
        assert.notEqual(script(shared), script(shared), 'ONE shared instance -> divergence (D6 bound 2)');
    });

    test('P-30: a cleared engine replayed short is NOT a fresh engine', () => {
        const build = () => { const e = new SoaParticleEngine(8, { maxDt: Infinity });
            e.onTick(() => {}); return e; };
        const a = build();
        for (let i = 0; i < 8; i++) a.emit(500 + i, 600 + i, 7, 8, 3, 42);
        a.tick(1 / 60);
        a.clear();
        a.emit(0, 0, 1, -1, 0.5, 0);

        const b = build();
        b.emit(0, 0, 1, -1, 0.5, 0);

        assert.equal(a.x[7], 507, 'the previous scene survives clear() in an untouched slot');
        assert.equal(a.data[7], 42);
        assert.equal(b.x[7], 0);
        assert.equal(b.data[7], 0);
    });
});
