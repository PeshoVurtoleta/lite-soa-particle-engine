/**
 * FROZEN BASELINE -- @zakkster/lite-soa-particle-engine v1.0.3 emit path.
 *
 * A byte-faithful copy of the v1.0.3 hot path, kept ONLY so bench-emit.mjs can
 * A/B the shipping engine against the version it replaced inside a single
 * process. It is never imported by the package, never shipped (test/ is not in
 * package.json files[]), and must never be "fixed" -- its whole value is that
 * it does not change when SoaParticleEngine.js does.
 *
 * Same role as @zakkster/lite-particles test/baseline/EmitterSoA.mjs.
 *
 * Only the constructor and emit() are reproduced; the RAF loop is not part of
 * any measurement and would drag a DOM shim into the harness.
 */

export class SoaParticleEngineV103 {
    constructor(maxParticles = 1000) {
        this.max = maxParticles;

        this.x       = new Float32Array(this.max);
        this.y       = new Float32Array(this.max);
        this.vx      = new Float32Array(this.max);
        this.vy      = new Float32Array(this.max);
        this.life    = new Float32Array(this.max);
        this.invLife = new Float32Array(this.max);
        this.data    = new Int32Array(this.max);

        this._head      = 0;
        this._destroyed = false;
    }

    emit(x, y, vx, vy, life, dataFlag = 0) {
        if (this._destroyed) return;

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

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.x = null;
        this.y = null;
        this.vx = null;
        this.vy = null;
        this.life = null;
        this.invLife = null;
        this.data = null;
    }
}
