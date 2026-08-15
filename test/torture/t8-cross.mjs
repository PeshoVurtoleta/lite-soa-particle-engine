/**
 * T8 -- cross-package integration. RESERVED, registered empty.
 *
 * Filled from S3 onward: lite-random determinism, lite-r3f-bridge lane feed,
 * lite-worker SAB, lite-scheduler as a tick source. None of those surfaces exist
 * on the package yet, so asserting them now would assert behaviour the package
 * does not have. Registered now (no-op run) so a later session extends a slot
 * instead of renumbering the suite.
 */
export function run() {}
