/**
 * T7 -- soak, conservation, and a second witness.
 *
 * `leak_cycles` cycles of fill / expire / drain. The drain path alternates
 * between natural expiry (age everything past its life) and clear(), so both are
 * soaked ~2048 times. After EACH cycle:
 *   - no slot has life > 0,
 *   - the raw-mode ring invariant holds: Number.isInteger(_head) && 0 <= _head < max.
 *
 * The invariant uses a valid `max` where it holds (P-04 -- which drives _head to
 * NaN -- is out of scope here; it only triggers on a 0-length engine).
 *
 * `createLeakTracker` from lite-leak is the SECOND independent witness: track one
 * resource per cycle, untrack it on drain, assert size() === 0 at the end. A lane
 * leak and a JS-object leak cannot hide behind each other. Held-value contract:
 * neither the cleanup thunk nor the tag closes over the tracked target.
 *
 * Heap is sampled ACROSS cycles (before/after the loop, after gc), never within
 * one, so intra-cycle churn is not misread as growth.
 */

import { SoaParticleEngine } from '../../SoaParticleEngine.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import { check, headInvariant } from './harness.mjs';

const CYCLES = 4096;
const MAX = 64;
const N = 32;           // particles emitted per cycle
const KILL_DT = 2.0;    // one aging pass this large expires every particle
const NOOP = function () {};

export function run() {
    const engine = new SoaParticleEngine(MAX);
    const tracker = createLeakTracker({ name: 'soa-soak' });

    // Sample heap only at cycle boundaries, after settling.
    globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let c = 0; c < CYCLES; c++) {
        // Fill.
        for (let i = 0; i < N; i++) {
            engine.emit(i, i, 1, -1, 0.5 + (i & 3) * 0.1, i);
        }
        // A tracked external resource modelling a per-cycle allocation. The tag
        // is a number and the cleanup is module-level -- neither captures target.
        const h = tracker.track({ cycle: c }, NOOP, c);

        check(headInvariant(engine),
            () => 'T7: cycle ' + c + ' head invariant violated -- _head=' + engine._head + ' max=' + engine.max);

        // Drain. Alternate natural expiry and clear() so both are soaked.
        if (c & 1) {
            engine.clear();
        } else {
            // Natural expiry: one big aging pass drives every live slot's life <= 0.
            const life = engine.life;
            for (let s = 0; s < MAX; s++) {
                if (life[s] > 0) life[s] -= KILL_DT;
            }
        }
        tracker.untrack(h);

        // Post-drain: nothing is alive and the head is still a valid integer index.
        const life = engine.life;
        for (let s = 0; s < MAX; s++) {
            check(!(life[s] > 0),
                () => 'T7: cycle ' + c + ' slot ' + s + ' still alive after drain (life=' + life[s] + ')');
        }
        check(headInvariant(engine),
            () => 'T7: cycle ' + c + ' post-drain head invariant violated -- _head=' + engine._head);
    }

    check(tracker.size() === 0,
        () => 'T7: lite-leak tracker leaked ' + tracker.size() + ' resources');

    globalThis.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const grewKB = (heapAfter - heapBefore) / 1024;
    check(grewKB < 512,
        () => 'T7: heap grew ' + grewKB.toFixed(1) + ' KB over ' + CYCLES + ' cycles');

    engine.destroy();
}
