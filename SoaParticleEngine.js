/**
 * @zakkster/lite-soa-particle-engine — Zero-GC Canvas Particle System
 *
 * Uses Structure of Arrays (SoA) to maintain particles in flat TypedArrays.
 * CPU cache-friendly: iterating a Float32Array is ~10x faster than iterating
 * an array of objects because the data is contiguous in memory.
 *
 * Ring buffer design: when the pool is full, new particles overwrite the oldest.
 * This is intentional — graceful visual degradation without crashes or GC spikes.
 *
 * The engine owns the RAF loop and exposes raw arrays to the onTick callback
 * for maximum rendering flexibility.
 */

export class SoaParticleEngine {
    /**
     * @param {number} maxParticles Maximum particles. Memory is allocated once.
     */
    constructor(maxParticles = 1000) {
        this.max = maxParticles;

        // Allocate all memory once — zero allocations during gameplay
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
     * Ring buffer: if the pool is full, the oldest particle is overwritten.
     * This is intentional — visual degradation without crashes.
     *
     * @param {number} x        X position
     * @param {number} y        Y position
     * @param {number} vx       X velocity
     * @param {number} vy       Y velocity
     * @param {number} life     Lifetime in seconds (must be > 0)
     * @param {number} [dataFlag=0] Recipe ID or custom integer flag
     */
    emit(x, y, vx, vy, life, dataFlag = 0) {
        if (this._destroyed) return;

        // Prevent NaN poisoning in TypedArrays
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (!Number.isFinite(vx) || !Number.isFinite(vy)) return;
        if (!Number.isFinite(life) || life <= 0) return;

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
     *   x..data: the raw TypedArrays — mutate them directly
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

    /** Kill all particles. */
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

        // Cap dt on lag spikes / tab switches
        if (dt > 0.1) dt = 0.016;

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
