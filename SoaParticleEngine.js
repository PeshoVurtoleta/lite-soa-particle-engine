/**
 * @zakkster/lite-soa-particle-engine -- Zero-GC Canvas Particle System
 *
 * Uses Structure of Arrays (SoA) to maintain particles in flat TypedArrays.
 * CPU cache-friendly: iterating a Float32Array is ~10x faster than iterating
 * an array of objects because the data is contiguous in memory.
 *
 * Ring buffer design: when the pool is full, emit() overwrites the slot at the
 * write cursor whether or not it is still alive. With mixed lifetimes that slot
 * is frequently NOT the oldest particle, so a long-lived particle can be stomped
 * while dead slots sit free (finding P-01; a liveness-aware policy lands in S4).
 * Graceful visual degradation without crashes or GC spikes.
 *
 * The engine owns the RAF loop and exposes raw arrays to the onTick callback
 * for maximum rendering flexibility.
 */

export const VERSION = '1.0.4';

/**
 * Upper bound on maxParticles, a policy number (not a probe of what happens to
 * allocate). 2**24 = 16.7M particles x 7 lanes x 4 bytes = 470 MB, far under any
 * V8 abort and two orders of magnitude above the 10K-100K target. Proven by
 * test/bench-ceiling.mjs, criteria C1..C7. See decisions/0002-the-door.md.
 *
 * There is NO size at which the lane allocator fails politely -- 2**33 kills the
 * process (exit 133, uncatchable), it does not throw -- so constructor validation
 * against this ceiling is the only thing between a caller's typo and a dead
 * process.
 */
export const MAX_PARTICLES = 2 ** 24; // 16777216

/**
 * Low end of the legal `life` band: the smallest lifetime whose f32 `invLife`
 * (1/life) is still finite. Its invLife is 3.4028234663852886e+38, exactly f32
 * max. The next value DOWN, 2.9387359646368754e-39, yields an f32 invLife of
 * Infinity and a NaN alpha, so it is rejected.
 *
 * MEASURED, not derived. The analytic guess 1/F32MAX is 2.938736052218037e-39,
 * which is LARGER than this boundary and would silently reject a band of legal
 * lifetimes. See decisions/0002-the-door.md; do not "simplify" this to 1/F32MAX.
 */
export const LIFE_MIN = 2.938735964636876e-39;

/**
 * High end of the legal `life` band: the largest lifetime that stores as a finite
 * f32. The next value UP, 3.4028235677973366e+38, stores as f32 Infinity, so it
 * is rejected. MEASURED, not derived. See decisions/0002-the-door.md.
 */
export const LIFE_MAX = 3.4028235677973362e+38;

/**
 * COLD-path helper: render a rejected constructor argument into an error message
 * without EVER throwing itself, so this library's named error can never be
 * replaced by a foreign one on the way to a throw -- a door with a gap. Strings
 * are JSON-quoted so "10" is visibly a string, not the number 10.
 *
 * The catch exists because neither branch is total: `JSON.stringify` throws on a
 * BigInt, `String(v)` throws on a null-prototype object or one with a hostile
 * `toString` / `valueOf` / `Symbol.toPrimitive`, and both throw on a throwing or
 * revoked Proxy. Any of those falls back to a type-tagged placeholder rather than
 * escaping.
 */
function _showArg(v) {
    try {
        return typeof v === 'string' ? JSON.stringify(v) : String(v);
    } catch {
        return '[unstringifiable ' + typeof v + ']';
    }
}

/**
 * Zero-GC Structure-of-Arrays particle pool.
 *
 * The door contract (decisions/0002-the-door.md):
 *   - The constructor THROWS a named library error (TypeError / RangeError, no
 *     subclass) for any maxParticles that is not an integer in [1, MAX_PARTICLES],
 *     and for any options.maxDt that is not a finite number > 0. It validates
 *     before allocating, so the bare "Invalid typed array length" never escapes.
 *   - emit() NEVER throws (it is per-frame, per-particle; a throw is a render-loop
 *     crash). It silently rejects, before touching any lane, any emit whose
 *     x/y/vx/vy are non-finite, whose `life` is outside [LIFE_MIN, LIFE_MAX]
 *     (which also rejects NaN, both infinities, 0 and negatives), or whose
 *     dataFlag is not an exact int32. A rejected emit leaves the engine
 *     byte-identical and does not advance _head.
 *   - A frame gap larger than maxDt is CLAMPED to maxDt: a clamped frame LOSES
 *     time by design (the alternative is particles tunnelling). This engine is
 *     therefore NOT a fixed-step simulator. A caller needing a fixed-step
 *     accumulator drives tick(dt) themselves (lands in S3).
 *   - clear() is life-only: for a dead slot (life[i] <= 0) the values in
 *     x/y/vx/vy/invLife/data are UNDEFINED. No correct consumer reads them.
 *   - The seven lanes are reassigned (to null) ONLY by destroy(), never by any
 *     other method.
 */
export class SoaParticleEngine {
    /**
     * @param {number} [maxParticles=1000] Maximum particles. Must be an integer in
     *   [1, MAX_PARTICLES]; anything else throws a named library error. Memory is
     *   allocated once.
     * @param {{ maxDt?: number }} [options] Optional configuration. `maxDt`
     *   (default 0.1) is the largest frame delta the loop will pass to onTick; a
     *   larger gap is clamped to it and the excess time is dropped by design. Must
     *   be a finite number > 0 or the constructor throws.
     */
    constructor(maxParticles = 1000, options) {
        // COLD path: validate before allocating so the allocator's bare
        // "RangeError: Invalid typed array length" can never escape as this
        // library's error. Every message names the package, the argument, the
        // constraint, and the received value.
        if (typeof maxParticles !== 'number') {
            throw new TypeError(
                'SoaParticleEngine: maxParticles must be a number, got ' +
                typeof maxParticles + ' ' + _showArg(maxParticles));
        }
        if (!(Number.isInteger(maxParticles) && maxParticles >= 1 && maxParticles <= MAX_PARTICLES)) {
            throw new RangeError(
                'SoaParticleEngine: maxParticles must be an integer in [1, 16777216], got ' + maxParticles);
        }

        let maxDt = 0.1;
        // Read options.maxDt exactly once: a side-effecting getter must fire at
        // most once even on this cold path.
        const m = (options !== undefined && options !== null) ? options.maxDt : undefined;
        if (m !== undefined) {
            if (typeof m !== 'number') {
                throw new TypeError(
                    'SoaParticleEngine: options.maxDt must be a number, got ' +
                    typeof m + ' ' + _showArg(m));
            }
            if (!(Number.isFinite(m) && m > 0)) {
                throw new RangeError(
                    'SoaParticleEngine: options.maxDt must be a finite number > 0, got ' + m);
            }
            maxDt = m;
        }
        this.maxDt = maxDt;

        this.max = maxParticles;

        // Allocate all memory once -- zero allocations during gameplay
        this.x       = new Float32Array(this.max);
        this.y       = new Float32Array(this.max);
        this.vx      = new Float32Array(this.max);
        this.vy      = new Float32Array(this.max);
        this.life    = new Float32Array(this.max);
        this.invLife = new Float32Array(this.max);
        this.data    = new Int32Array(this.max); // Recipe ID or custom flag

        this._head      = 0;
        this._isRunning = false;
        this._destroyed = false;
        this._lastTime  = 0;
        this._onTick    = null;
        this._rafId     = null;

        this._loop = this._loop.bind(this);
    }

    /**
     * Emit a single particle.
     *
     * Ring buffer: when the pool is full, emit() overwrites the slot at the write
     * cursor whether or not it is alive; with mixed lifetimes that is frequently
     * not the oldest particle (finding P-01, fixed in S4). Visual degradation
     * without crashes.
     *
     * HOT path. Never throws: every degenerate input is rejected BEFORE any lane
     * write, so a rejected emit leaves the engine byte-identical and does not
     * advance _head.
     *
     * @param {number} x        X position
     * @param {number} y        Y position
     * @param {number} vx       X velocity
     * @param {number} vy       Y velocity
     * @param {number} life     Lifetime in seconds. Must lie in the legal band
     *   [LIFE_MIN, LIFE_MAX]; out-of-band life (including NaN, both infinities, 0
     *   and negatives, and lifetimes so small their invLife would overflow to
     *   Infinity) is silently rejected.
     * @param {number} [dataFlag=0] Recipe ID or custom flag. Must be an exact
     *   int32 ((dataFlag | 0) === dataFlag); a fractional, out-of-range,
     *   non-numeric, or NaN flag is rejected. 0 is the default and a legal id.
     */
    emit(x, y, vx, vy, life, dataFlag = 0) {
        if (this._destroyed) return;

        // Prevent NaN poisoning in TypedArrays. The life band test also rejects
        // NaN, both infinities, 0 and negatives -- two checks folded into one.
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (!Number.isFinite(vx) || !Number.isFinite(vy)) return;
        if (!(life >= LIFE_MIN && life <= LIFE_MAX)) return;
        if ((dataFlag | 0) !== dataFlag) return;

        const i = this._head;

        this.x[i]       = x;
        this.y[i]       = y;
        this.vx[i]      = vx;
        this.vy[i]      = vy;
        this.life[i]    = life;
        this.invLife[i]  = 1.0 / life;
        this.data[i]    = dataFlag;

        this._head = (i + 1) % this.max;
    }

    /**
     * Register the tick callback. Called every frame with raw arrays.
     *
     * @param {Function} callback (dt, x, y, vx, vy, life, invLife, data, max)
     *   dt: seconds since last frame
     *   x..data: the raw TypedArrays -- mutate them directly
     *   max: array length
     */
    onTick(callback) {
        this._onTick = callback;
    }

    /** Start the RAF loop. */
    start() {
        if (this._isRunning || this._destroyed) return;
        this._isRunning = true;
        this._lastTime = performance.now();
        this._rafId = requestAnimationFrame(this._loop);
    }

    /** Stop the RAF loop. */
    stop() {
        this._isRunning = false;
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    /** Alias for stop(). */
    pause() {
        this.stop();
    }

    /**
     * Kill all particles. Life-only by contract: this zeroes the `life` lane and
     * resets the write cursor but does NOT touch x/y/vx/vy/invLife/data, which are
     * undefined for a dead slot (life[i] <= 0) and must not be read.
     */
    clear() {
        if (this._destroyed) return;
        this.life.fill(0);
        this._head = 0;
    }

    /**
     * Stop the loop and release all TypedArray references.
     * Idempotent.
     */
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.stop();

        this.x = null;
        this.y = null;
        this.vx = null;
        this.vy = null;
        this.life = null;
        this.invLife = null;
        this.data = null;
        this._onTick = null;
    }

    /** @private */
    _loop(time) {
        if (!this._isRunning) return;

        let dt = (time - this._lastTime) / 1000;
        this._lastTime = time;

        // Clamp dt on lag spikes / tab switches. A clamped frame LOSES the excess
        // time by design (the alternative is a physics step so large particles
        // tunnel). Negative and NaN dt are deliberately untouched -- a broken
        // clock is the caller's problem, out of scope for this engine.
        if (dt > this.maxDt) dt = this.maxDt;

        if (this._onTick) {
            this._onTick(
                dt,
                this.x, this.y, this.vx, this.vy,
                this.life, this.invLife, this.data,
                this.max
            );
        }

        this._rafId = requestAnimationFrame(this._loop);
    }
}

export default SoaParticleEngine;
