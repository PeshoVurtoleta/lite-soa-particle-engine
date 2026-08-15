import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SoaParticleEngine } from '../SoaParticleEngine.js';

describe('⚡ SoaParticleEngine', () => {
    let engine;

    beforeEach(() => {
        vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
        vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
        vi.spyOn(performance, 'now').mockReturnValue(0);
        engine = new SoaParticleEngine(100);
    });

    afterEach(() => {
        engine?.destroy();
        vi.restoreAllMocks();
    });

    describe('constructor', () => {
        it('allocates Float32Arrays', () => {
            expect(engine.x).toBeInstanceOf(Float32Array);
            expect(engine.y).toBeInstanceOf(Float32Array);
            expect(engine.life).toBeInstanceOf(Float32Array);
            expect(engine.x.length).toBe(100);
        });

        it('allocates Int32Array for data', () => {
            expect(engine.data).toBeInstanceOf(Int32Array);
        });

        it('defaults to 1000 particles', () => {
            const e = new SoaParticleEngine();
            expect(e.max).toBe(1000);
            e.destroy();
        });
    });

    describe('emit()', () => {
        it('writes particle data to current head position', () => {
            engine.emit(10, 20, 30, 40, 1.5, 7);
            expect(engine.x[0]).toBe(10);
            expect(engine.y[0]).toBe(20);
            expect(engine.vx[0]).toBe(30);
            expect(engine.vy[0]).toBe(40);
            expect(engine.life[0]).toBe(1.5);
            expect(engine.data[0]).toBe(7);
        });

        it('computes invLife', () => {
            engine.emit(0, 0, 0, 0, 2.0);
            expect(engine.invLife[0]).toBeCloseTo(0.5);
        });

        it('advances head (ring buffer)', () => {
            engine.emit(0, 0, 0, 0, 1);
            engine.emit(0, 0, 0, 0, 1);
            expect(engine._head).toBe(2);
        });

        it('wraps around at max', () => {
            const e = new SoaParticleEngine(3);
            e.emit(1, 0, 0, 0, 1);
            e.emit(2, 0, 0, 0, 1);
            e.emit(3, 0, 0, 0, 1);
            e.emit(4, 0, 0, 0, 1); // overwrites slot 0
            expect(e.x[0]).toBe(4);
            expect(e._head).toBe(1);
            e.destroy();
        });

        it('rejects NaN values', () => {
            engine.emit(NaN, 0, 0, 0, 1);
            expect(engine.life[0]).toBe(0); // unchanged
        });

        it('rejects non-finite values', () => {
            engine.emit(Infinity, 0, 0, 0, 1);
            expect(engine.life[0]).toBe(0);
        });

        it('rejects life <= 0', () => {
            engine.emit(0, 0, 0, 0, 0);
            expect(engine.life[0]).toBe(0);
            engine.emit(0, 0, 0, 0, -1);
            expect(engine.life[0]).toBe(0);
        });

        it('is no-op after destroy', () => {
            engine.destroy();
            expect(() => engine.emit(0, 0, 0, 0, 1)).not.toThrow();
        });
    });

    describe('start/stop', () => {
        it('start() requests animation frame', () => {
            engine.start();
            expect(requestAnimationFrame).toHaveBeenCalled();
            expect(engine._isRunning).toBe(true);
        });

        it('start() is idempotent', () => {
            engine.start();
            const calls = requestAnimationFrame.mock.calls.length;
            engine.start();
            expect(requestAnimationFrame.mock.calls.length).toBe(calls);
        });

        it('stop() cancels animation frame', () => {
            engine.start();
            engine.stop();
            expect(engine._isRunning).toBe(false);
        });

        it('pause() is alias for stop()', () => {
            engine.start();
            engine.pause();
            expect(engine._isRunning).toBe(false);
        });

        it('start() is no-op after destroy', () => {
            engine.destroy();
            engine.start();
            expect(engine._isRunning).toBe(false);
        });
    });

    describe('onTick()', () => {
        it('registers callback', () => {
            const fn = vi.fn();
            engine.onTick(fn);
            expect(engine._onTick).toBe(fn);
        });
    });

    describe('_loop()', () => {
        it('calls onTick with raw arrays', () => {
            const fn = vi.fn();
            engine.onTick(fn);
            engine.start();
            engine._loop(16.66);
            expect(fn).toHaveBeenCalledWith(
                expect.any(Number),
                engine.x, engine.y, engine.vx, engine.vy,
                engine.life, engine.invLife, engine.data,
                engine.max
            );
        });

        it('caps dt on lag spikes', () => {
            const fn = vi.fn();
            engine.onTick(fn);
            engine._lastTime = 0;
            engine._isRunning = true;
            engine._loop(5000); // 5 second gap
            const dt = fn.mock.calls[0][0];
            expect(dt).toBeCloseTo(0.016);
        });
    });

    describe('clear()', () => {
        it('zeros all life values', () => {
            engine.emit(0, 0, 0, 0, 1);
            engine.emit(0, 0, 0, 0, 2);
            engine.clear();
            expect(engine.life[0]).toBe(0);
            expect(engine.life[1]).toBe(0);
        });

        it('resets head', () => {
            engine.emit(0, 0, 0, 0, 1);
            engine.clear();
            expect(engine._head).toBe(0);
        });
    });

    describe('destroy()', () => {
        it('nulls all arrays', () => {
            engine.destroy();
            expect(engine.x).toBeNull();
            expect(engine.life).toBeNull();
            expect(engine.data).toBeNull();
        });

        it('is idempotent', () => {
            engine.destroy();
            expect(() => engine.destroy()).not.toThrow();
        });
    });
});
