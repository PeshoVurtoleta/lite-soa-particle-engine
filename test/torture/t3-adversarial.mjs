/**
 * T3 -- adversarial emit/lifetime sequences. RESERVED, mostly empty.
 *
 * The full tier (scaled P-01 recipes at max=64/4096, kill-all-then-emit,
 * wrap-boundary sequences, 10000-frame churn, etc.) is filled by S4, when a
 * liveness-aware ring policy lands. Asserting the POST-S4 policy here would
 * assert a behaviour the package does not have yet.
 *
 * One exception ships now: the headline P-01 reproduction from the roadmap
 * (section 2) is pinned as CURRENT (buggy) behaviour, not the future policy --
 * exactly the same pin-the-present discipline T1 already applies to P-02..P-06.
 * Without this pin the package's own headline finding -- the one its README
 * explosion recipe triggers -- has no coverage anywhere in the repo, and S4
 * would have no failing-before/passing-after diff to point at. S4 changes
 * this assertion's expected values when it fixes the ring policy; until then
 * this is the documented (if bad) contract.
 */
import { SoaParticleEngine } from '../../SoaParticleEngine.js';
import { check } from './harness.mjs';

export function run() {
    // Exact roadmap repro: max=3, life 1.5/0.3/0.3, kill slots 1+2 (the two
    // dead, free slots), then emit a 4th particle. The write cursor has
    // wrapped to slot 0 -- the one LIVE slot -- so the stomp destroys the
    // long-lived particle at 90% of its life while two dead slots sit free.
    const e = new SoaParticleEngine(3);
    e.emit(1, 1, 0, 0, 1.5, 1); // slot 0 -- long-lived "debris"
    e.emit(2, 2, 0, 0, 0.3, 2); // slot 1 -- short-lived "flash"
    e.emit(3, 3, 0, 0, 0.3, 3); // slot 2 -- short-lived "flash"
    check(e._head === 0,
        () => 'T3.P-01 pin: expected head to have wrapped to 0 before the kill, got ' + e._head);

    e.life[1] = 0; // kill slot 1
    e.life[2] = 0; // kill slot 2 -- two dead slots now free

    e.emit(4, 4, 0, 0, 0.3, 4); // the stomp: writes slot 0, not a dead slot

    check(e._head === 1,
        () => 'T3.P-01 pin: expected head to advance to 1, got ' + e._head);
    check(e.x[0] === 4,
        () => 'T3.P-01 pin: expected the still-alive slot 0 to be overwritten (x=4), got x=' + e.x[0]);
    check(e.life[0] === 0.30000001192092896,
        () => 'T3.P-01 pin: expected life[0] === 0.30000001192092896 (the stomped-in value), got ' + e.life[0]);
    check(e.data[0] === 4,
        () => 'T3.P-01 pin: expected data[0] === 4 (the stomped-in flag), got ' + e.data[0]);
    // The two dead, free slots were never touched -- proof the ring had a
    // choice and stomped the live one anyway.
    check(e.x[1] === 2 && e.life[1] === 0,
        () => 'T3.P-01 pin: expected dead slot 1 untouched (x=2, life=0), got x=' + e.x[1] + ' life=' + e.life[1]);
    check(e.x[2] === 3 && e.life[2] === 0,
        () => 'T3.P-01 pin: expected dead slot 2 untouched (x=3, life=0), got x=' + e.x[2] + ' life=' + e.life[2]);

    e.destroy();
}
