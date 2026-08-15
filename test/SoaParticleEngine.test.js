import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SoaParticleEngine } from '../SoaParticleEngine.js';
import { installFramePump } from './helpers/env.mjs';

describe('SoaParticleEngine', () => {
    let engine;
    let pump;

    beforeEach(() => {
        // Deterministic RAF + clock shims, driven by explicit timestamps only
        // (replacing the old spies on requestAnimationFrame / cancelAnimationFrame
        // / performance.now). See finding P-08; the loop-ownership fix is S3.
        pump = installFramePump();
        pump.setNow(0);
        engine = new SoaParticleEngine(100);
    });

    afterEach(() => {
        engine?.destroy();
        pump.uninstall();
    });

    describe('constructor', () => {
        it('allocates Float32Arrays', () => {
            assert.ok(engine.x instanceof Float32Array);
            assert.ok(engine.y instanceof Float32Array);
            assert.ok(engine.life instanceof Float32Array);
            assert.equal(engine.x.length, 100);
        });

        it('allocates Int32Array for data', () => {
            assert.ok(engine.data instanceof Int32Array);
        });

        it('defaults to 1000 particles', () => {
            const e = new SoaParticleEngine();
            assert.equal(e.max, 1000);
            e.destroy();
        });
    });

    describe('emit()', () => {
        it('writes particle data to current head position', () => {
            engine.emit(10, 20, 30, 40, 1.5, 7);
            assert.equal(engine.x[0], 10);
            assert.equal(engine.y[0], 20);
            assert.equal(engine.vx[0], 30);
            assert.equal(engine.vy[0], 40);
            assert.equal(engine.life[0], Math.fround(1.5));
            assert.equal(engine.data[0], 7);
        });

        it('computes invLife', () => {
            engine.emit(0, 0, 0, 0, 2.0);
            assert.ok(Math.abs(engine.invLife[0] - 0.5) < 1e-6);
        });

        it('advances head (ring buffer)', () => {
            engine.emit(0, 0, 0, 0, 1);
            engine.emit(0, 0, 0, 0, 1);
            assert.equal(engine._head, 2);
        });

        it('wraps around at max', () => {
            const e = new SoaParticleEngine(3);
            e.emit(1, 0, 0, 0, 1);
            e.emit(2, 0, 0, 0, 1);
            e.emit(3, 0, 0, 0, 1);
            e.emit(4, 0, 0, 0, 1); // overwrites slot at the write cursor (slot 0)
            assert.equal(e.x[0], 4);
            assert.equal(e._head, 1);
            e.destroy();
        });

        it('rejects NaN values', () => {
            engine.emit(NaN, 0, 0, 0, 1);
            assert.equal(engine.life[0], 0); // unchanged
        });

        it('rejects non-finite values', () => {
            engine.emit(Infinity, 0, 0, 0, 1);
            assert.equal(engine.life[0], 0);
        });

        it('rejects life <= 0', () => {
            engine.emit(0, 0, 0, 0, 0);
            assert.equal(engine.life[0], 0);
            engine.emit(0, 0, 0, 0, -1);
            assert.equal(engine.life[0], 0);
        });

        it('is no-op after destroy', () => {
            engine.destroy();
            assert.doesNotThrow(() => engine.emit(0, 0, 0, 0, 1));
        });
    });

    describe('start/stop', () => {
        it('start() requests animation frame', () => {
            engine.start();
            assert.ok(pump.rafCalls > 0);
            assert.equal(engine._isRunning, true);
        });

        it('start() is idempotent', () => {
            engine.start();
            const calls = pump.rafCalls;
            engine.start();
            assert.equal(pump.rafCalls, calls);
        });

        it('stop() cancels animation frame', () => {
            engine.start();
            engine.stop();
            assert.equal(engine._isRunning, false);
        });

        it('pause() is alias for stop()', () => {
            engine.start();
            engine.pause();
            assert.equal(engine._isRunning, false);
        });

        it('start() is no-op after destroy', () => {
            engine.destroy();
            engine.start();
            assert.equal(engine._isRunning, false);
        });
    });

    describe('onTick()', () => {
        it('registers callback', () => {
            const fn = () => {};
            engine.onTick(fn);
            assert.equal(engine._onTick, fn);
        });
    });

    describe('_loop()', () => {
        it('calls onTick with raw arrays', () => {
            const calls = [];
            engine.onTick((...args) => calls.push(args));
            engine.start();
            engine._loop(16.66);
            assert.equal(calls.length, 1);
            const a = calls[0];
            assert.equal(typeof a[0], 'number');
            assert.equal(a[1], engine.x);
            assert.equal(a[2], engine.y);
            assert.equal(a[3], engine.vx);
            assert.equal(a[4], engine.vy);
            assert.equal(a[5], engine.life);
            assert.equal(a[6], engine.invLife);
            assert.equal(a[7], engine.data);
            assert.equal(a[8], engine.max);
        });

        it('caps dt on lag spikes', () => {
            let dt;
            engine.onTick((d) => { dt = d; });
            engine._lastTime = 0;
            engine._isRunning = true;
            engine._loop(5000); // 5 second gap
            // Pinned: the current cap fabricates a 60Hz frame instead of clamping
            // (finding P-02). It reports 0.016 for ANY gap > 100ms. S2 changes this
            // to a real maxDt clamp; until then this is the documented behaviour.
            assert.ok(Math.abs(dt - 0.016) < 1e-6);
        });
    });

    describe('clear()', () => {
        it('zeros all life values', () => {
            engine.emit(0, 0, 0, 0, 1);
            engine.emit(0, 0, 0, 0, 2);
            engine.clear();
            assert.equal(engine.life[0], 0);
            assert.equal(engine.life[1], 0);
        });

        it('resets head', () => {
            engine.emit(0, 0, 0, 0, 1);
            engine.clear();
            assert.equal(engine._head, 0);
        });
    });

    describe('destroy()', () => {
        it('nulls all arrays', () => {
            engine.destroy();
            assert.equal(engine.x, null);
            assert.equal(engine.life, null);
            assert.equal(engine.data, null);
        });

        it('is idempotent', () => {
            engine.destroy();
            assert.doesNotThrow(() => engine.destroy());
        });
    });
});
