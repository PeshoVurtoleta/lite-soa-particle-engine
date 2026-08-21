/**
 * @zakkster/lite-soa-particle-engine -- torture gate.
 *
 * The DONE-WHEN of every session is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * Ten tiers share one shape (roadmap section 3). S1 stands up the harness and
 * wires the tiers this session needs now:
 *
 *     T0  emit/tick algebra (metamorphic laws)
 *     T1  degenerate values (constructor / life / dataFlag / dt), current behaviour pinned
 *     T6  the zero-alloc gate (+ per-lane byteLength pins)
 *     T7  soak + raw-mode head invariant + lite-leak second witness
 *     T9  controls (every gate must be provably able to fail)
 *
 * T2, T3, T4, T5, T8 are REGISTERED EMPTY (no-op run) so a later session fills a
 * slot instead of renumbering the suite -- exactly as lite-bvh registers a
 * reserved tier empty.
 *
 * S1 fixes NO behaviour: findings P-01..P-16 are recorded, not repaired. Where a
 * tier would naturally cover a known bug it PINS the current (wrong) behaviour
 * with the finding ID and the session that changes it (see T1 especially).
 *
 * lite-gc-profiler is one-measurement-at-a-time, so tiers run STRICTLY
 * SEQUENTIALLY -- never nested, never concurrent.
 *
 * Control: `SOA_TORTURE_BREAK=1 node --expose-gc test/torture.mjs` injects
 * retained allocations into the T6 hot loop and must exit non-zero. A gate that
 * cannot fail is decorative.
 *
 * Peers (lite-gc-profiler, lite-leak) are devDependencies only. The runtime has
 * zero dependencies.
 *
 * @license MIT
 */

import { SEED, BREAK } from './torture/harness.mjs';
import { run as t0 } from './torture/t0-laws.mjs';
import { run as t1 } from './torture/t1-degenerate.mjs';
import { run as t2 } from './torture/t2-views.mjs';
import { run as t3 } from './torture/t3-adversarial.mjs';
import { run as t4 } from './torture/t4-handles.mjs';
import { run as t5 } from './torture/t5-fuzz.mjs';
import { run as t6 } from './torture/t6-alloc.mjs';
import { run as t7 } from './torture/t7-soak.mjs';
import { run as t8 } from './torture/t8-cross.mjs';
import { run as t9 } from './torture/t9-controls.mjs';

const TIERS = [
    ['T0 laws', t0],
    ['T1 degenerate', t1],
    ['T2 views', t2],
    ['T3 adversarial', t3],
    ['T4 handles', t4],
    ['T5 fuzz', t5],
    ['T6 alloc', t6],
    ['T7 soak', t7],
    ['T8 cross', t8],
    ['T9 controls', t9],
];

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc:  node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }

    for (const [name, run] of TIERS) {
        try {
            // T8 is async (lite-scheduler dispatches through a MessageChannel);
            // every other tier is sync. `await` on a sync tier's undefined is a
            // harmless no-op, so one loop drives both (S3.1, R6).
            await run();
        } catch (err) {
            // Tiers normally fail via die() (which exits). A thrown error is an
            // unexpected fault -- surface it with the replay seed and stop.
            process.stderr.write(
                'torture: FAIL -- ' + name + ' threw: ' + (err && err.stack || err) +
                '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
            process.exit(1);
        }
    }

    // Reaching here in BREAK mode means T6's control did not trip -- a fault.
    if (BREAK) {
        process.stderr.write('torture: FAIL -- SOA_TORTURE_BREAK set but the gate still passed\n');
        process.exit(1);
    }

    process.stdout.write('ok\n');
    process.exit(0);
}

main();
