/**
 * T8 -- cross-package integration (S3.1). Two ecosystem packages, both added as
 * devDependencies and proven to install:
 *
 *   - @zakkster/lite-random -- SEED PARITY. emitBurst takes its randomness as an
 *     argument, so two fresh engines fed two Random instances at the SAME seed
 *     land on byte-identical lanes (all seven), and two engines SHARING one
 *     instance diverge (D6 bound 2: parity is seed parity, not instance sharing).
 *   - @zakkster/lite-scheduler -- a TICK SOURCE. A scheduler-dispatched callback
 *     calls tick(dt) with a caller-computed dt, with NO requestAnimationFrame and
 *     NO DOM global installed. R6 bounds what may be asserted: lite-scheduler has
 *     no frame clock and no dt, so the ONLY claim is that a dispatched callback
 *     can drive tick(dt) to completion off the DOM -- not that it supplies dt, nor
 *     anything about frame ordering or budgetMs.
 *
 * This tier is ASYNC: lite-scheduler dispatches through a MessageChannel
 * (macrotask), so run() returns a Promise and test/torture.mjs awaits it. Every
 * other tier stays synchronous. Non-vacuity is enforced: the scheduler test
 * asserts the callback ACTUALLY ran (after destroy(), schedule() silently
 * no-ops, so a careless T8 would pass while doing nothing).
 *
 * @license MIT
 */

import { SoaParticleEngine } from '../../SoaParticleEngine.js';
import { Random } from '@zakkster/lite-random';
import { createScheduler } from '@zakkster/lite-scheduler';
import { check } from './harness.mjs';

const LANES = ['x', 'y', 'vx', 'vy', 'life', 'invLife', 'data'];

/** Run an identical burst/tick script against an engine using the given rng. */
function script(engine, rng) {
    engine.emitBurst(100, 200, 12, { speed: 180, speedVar: 60, angle: 0.4, angleVar: 1.1, life: 2, lifeVar: 0.5, data: 9 }, rng);
    engine.emitBurst(-50, 30, 8, { speed: 90, speedVar: 20, angle: 3.0, angleVar: 0.8, life: 1.2, lifeVar: 0.3, data: 4 }, rng);
}

/** First lane that differs between two engines, or null if all seven match. */
function firstLaneDiff(a, b) {
    for (let li = 0; li < LANES.length; li++) {
        const lane = LANES[li];
        const la = a[lane], lb = b[lane];
        for (let s = 0; s < la.length; s++) {
            if (la[s] !== lb[s]) return lane + '[' + s + '] ' + la[s] + ' != ' + lb[s];
        }
    }
    return null;
}

export async function run() {
    // --- lite-random seed parity (D6). Two fresh engines, two Random(12345),
    // identical script -> all seven lanes byte-identical.
    {
        const a = new SoaParticleEngine(64);
        const b = new SoaParticleEngine(64);
        script(a, new Random(12345));
        script(b, new Random(12345));
        const diff = firstLaneDiff(a, b);
        check(diff === null,
            () => 'T8.parity: two Random(12345) instances must replay byte-identically, first diff ' + diff);
        a.destroy();
        b.destroy();
    }

    // --- D6 bound 2 non-vacuity: two engines SHARING one Random interleave their
    // draws, so at least one lane MUST differ. If they matched, seed parity would
    // be a property of the seed value alone and the bound would be decorative.
    {
        const shared = new Random(12345);
        const a = new SoaParticleEngine(64);
        const b = new SoaParticleEngine(64);
        script(a, shared); // consumes the first stretch of the stream
        script(b, shared); // consumes the CONTINUATION -> different draws
        const diff = firstLaneDiff(a, b);
        check(diff !== null,
            () => 'T8.parity: two engines SHARING one Random must diverge on at least one lane (D6 bound 2)');
        a.destroy();
        b.destroy();
    }

    // --- lite-scheduler as a tick source (R6). Remove requestAnimationFrame /
    // cancelAnimationFrame for the duration so the claim "no RAF, no DOM" is real,
    // not merely true because the shared PUMP happens to be installed. The
    // scheduler dispatches through a MessageChannel, never a frame clock.
    {
        const savedRaf = globalThis.requestAnimationFrame;
        const savedCaf = globalThis.cancelAnimationFrame;
        const hadRaf = 'requestAnimationFrame' in globalThis;
        const hadCaf = 'cancelAnimationFrame' in globalThis;
        delete globalThis.requestAnimationFrame;
        delete globalThis.cancelAnimationFrame;

        const scheduler = createScheduler();
        const engine = new SoaParticleEngine(64);
        engine.emitBurst(10, 10, 16, { speed: 120, life: 3 }, new Random(7));

        let ran = false;
        let tickRet = null;
        let sawMax = -1;
        let sawDt = NaN;
        engine.onTick(function (dt, x, y, vx, vy, life, invLife, data, max) {
            sawDt = dt;
            sawMax = max;
            // Integrate one step so the callback does real work off the DOM.
            for (let s = 0; s < max; s++) {
                if (life[s] <= 0) continue;
                life[s] -= dt;
                x[s] += vx[s] * dt;
                y[s] += vy[s] * dt;
            }
        });

        try {
            // The scheduler dispatches the callback asynchronously; await its run.
            await new Promise(function (resolve) {
                scheduler.schedule(function () {
                    ran = true;
                    // The caller computes dt; lite-scheduler does not supply one.
                    tickRet = engine.tick(1 / 60);
                    resolve();
                });
            });

            check(ran === true,
                () => 'T8.scheduler: the scheduled callback never ran (schedule() no-op? after destroy it silently no-ops)');
            check(tickRet === true,
                () => 'T8.scheduler: tick(dt) driven by the scheduler must return true, got ' + String(tickRet));
            check(sawMax === engine.max,
                () => 'T8.scheduler: the onTick callback must have run with max=' + engine.max + ', saw ' + sawMax);
            check(sawDt === 1 / 60,
                () => 'T8.scheduler: the callback must receive the caller-computed dt, saw ' + sawDt);
            check(typeof globalThis.requestAnimationFrame === 'undefined',
                () => 'T8.scheduler: RAF must be absent for this claim -- it was defined');
        } finally {
            scheduler.destroy();
            engine.destroy();
            if (hadRaf) globalThis.requestAnimationFrame = savedRaf;
            if (hadCaf) globalThis.cancelAnimationFrame = savedCaf;
        }
    }
}
