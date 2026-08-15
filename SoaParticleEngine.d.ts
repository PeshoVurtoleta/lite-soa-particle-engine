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
     * the excess time is dropped by design. Must be a finite number > 0.
     * Default 0.1.
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
     * @param options Optional configuration; `maxDt` must be a finite number > 0
     *   or the constructor throws.
     */
    constructor(maxParticles?: number, options?: SoaParticleEngineOptions);
    /**
     * Emit a particle. Never throws. `life` outside [LIFE_MIN, LIFE_MAX] (NaN,
     * infinities, 0, negatives, sub-floor lifetimes) is silently rejected, as is a
     * `dataFlag` that is not an exact int32. A rejected emit is a no-op.
     */
    emit(x: number, y: number, vx: number, vy: number, life: number, dataFlag?: number): void;
    onTick(callback: TickCallback): void;
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

export default SoaParticleEngine;
