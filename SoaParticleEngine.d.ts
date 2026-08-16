export type TickCallback = (
    dt: number,
    x: Float32Array, y: Float32Array,
    vx: Float32Array, vy: Float32Array,
    life: Float32Array, invLife: Float32Array,
    data: Int32Array, max: number
) => void;

export interface SoaParticleEngineOptions {
    /**
     * Largest frame delta passed to onTick. A larger gap is clamped to this and
     * the excess time is dropped by design. Must be a number > 0; `Infinity` is
     * admitted and disables the clamp (for a fixed-step caller driving tick(dt)
     * directly). Default 0.1.
     */
    maxDt?: number;
}

export class SoaParticleEngine {
    readonly max: number;
    readonly maxDt: number;
    x: Float32Array | null;
    y: Float32Array | null;
    vx: Float32Array | null;
    vy: Float32Array | null;
    life: Float32Array | null;
    invLife: Float32Array | null;
    data: Int32Array | null;

    /**
     * @param maxParticles Integer in [1, MAX_PARTICLES]; anything else throws a
     *   named library error (TypeError / RangeError). Default 1000.
     * @param options Optional configuration; `maxDt` must be a number > 0
     *   (`Infinity` admitted, disables the clamp) or the constructor throws.
     */
    constructor(maxParticles?: number, options?: SoaParticleEngineOptions);
    /**
     * Emit a particle. Never throws. Any of `x/y/vx/vy` outside the symmetric f32
     * band [-LANE_MAX, LANE_MAX] (NaN, both infinities) is silently rejected;
     * `life` outside [LIFE_MIN, LIFE_MAX] (NaN, infinities, 0, negatives, sub-floor
     * lifetimes) is silently rejected, as is a `dataFlag` that is not an exact
     * int32.
     * @returns The slot index written, in [0, max), on success; -1 on every
     *   rejection path. The index is a receipt, not an identity: valid until that
     *   slot is reused.
     */
    emit(x: number, y: number, vx: number, vy: number, life: number, dataFlag?: number): number;
    /**
     * Register the per-frame callback. A function registers; `null` or
     * `undefined` unregister. Anything else throws a named TypeError at the door.
     */
    onTick(callback: TickCallback | null | undefined): void;
    /**
     * Advance the simulation by `dt` seconds, invoking the callback once. The
     * primary stepping API -- no DOM required. Never throws: a `dt` that is not a
     * number >= 0 is silently rejected. `dt` is clamped to `maxDt` on the high
     * side, rejected on the low side.
     * @returns true iff the callback ran; false on a rejected `dt`, no registered
     *   callback, or a destroyed engine.
     */
    tick(dt: number): boolean;
    /**
     * Start the RAF loop. Throws a named TypeError if `requestAnimationFrame` is
     * not defined in this environment, leaving the engine untouched and
     * retryable. Drive `tick(dt)` directly where there is no DOM.
     */
    start(): void;
    stop(): void;
    pause(): void;
    clear(): void;
    destroy(): void;
}

export const VERSION: string;

/** Upper bound on maxParticles: 2 ** 24 = 16777216. */
export const MAX_PARTICLES: number;

/** Smallest legal life whose f32 invLife is finite: 2.938735964636876e-39. */
export const LIFE_MIN: number;

/** Largest life storable as a finite f32: 3.4028235677973362e+38. */
export const LIFE_MAX: number;

/**
 * Symmetric f32 band bound for x/y/vx/vy: 3.4028235677973362e+38, the largest
 * f64 that stores as a finite f32. Equal to LIFE_MAX by coincidence of the
 * storage type, declared independently.
 */
export const LANE_MAX: number;

export default SoaParticleEngine;
