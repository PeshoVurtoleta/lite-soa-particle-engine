/**
 * QA S3 (v1.1.0) -- boundary coverage the planner/reviewer/coder rounds did not
 * exercise, found by executing `tick(dt)`, `onTick()` and `_loop()` the way
 * S2.1's QA went after `emit()`'s dataFlag. `SoaParticleEngine.js` is frozen
 * for this stage; this file only adds tests, it never edits production code.
 *
 * QA found P-29 here: D8's clock guard (`typeof time === 'number' && time >=
 * this._lastTime`) self-heals from a NaN or backwards clock reading (both are
 * rejected before `_lastTime` is touched) but does NOT self-heal from a single
 * anomalously LARGE forward reading. A large-but-finite `time` (e.g. a
 * corrupted timestamp, or a RAF polyfill/environment briefly handing back a
 * different clock basis such as `Date.now()`, which is ~1.7e12 while
 * `performance.now()` is small) is accepted as a normal forward frame,
 * because it satisfies `time >= this._lastTime`. `_lastTime` then jumps to
 * that huge value. Every SUBSEQUENT frame on the real (small) clock timeline
 * permanently fails `time >= this._lastTime` -- the engine goes silently and
 * permanently dead while still burning a RAF slot per frame, the EXACT
 * failure shape D8's own rationale names ("a transient bad sample self-heals
 * ... instead of poisoning _lastTime ... and killing the engine silently and
 * permanently") -- just reached from the opposite (too-large) direction
 * instead of NaN/backwards. This is pinned as CURRENT (unfixed) behaviour.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SoaParticleEngine } from '../SoaParticleEngine.js';

describe('QA S3: P-29 -- D8 clock guard does not self-heal from an oversized forward reading', () => {
    let engine;
    let savedRaf, savedCaf;
    beforeEach(() => {
        // _loop()'s re-arm at the tail calls requestAnimationFrame directly; stub
        // it so driving _loop() manually (with _isRunning forced true, exactly
        // as t4-handles.mjs's D8 pins already do) does not throw on the re-arm.
        savedRaf = globalThis.requestAnimationFrame;
        savedCaf = globalThis.cancelAnimationFrame;
        globalThis.requestAnimationFrame = () => 999;
        globalThis.cancelAnimationFrame = () => {};
        engine = new SoaParticleEngine(4);
    });
    afterEach(() => {
        if (!engine._destroyed) engine.destroy();
        globalThis.requestAnimationFrame = savedRaf;
        globalThis.cancelAnimationFrame = savedCaf;
    });

    it('a single anomalously large (finite, forward) time is ACCEPTED and poisons _lastTime', () => {
        let calls = 0;
        engine.onTick(() => { calls++; });
        engine._isRunning = true;
        engine._lastTime = 0;

        engine._loop(1e15); // a plausible glitch magnitude; still typeof === 'number'
        assert.equal(calls, 1, 'the glitch frame itself must run (it IS a valid forward reading)');
        assert.equal(engine._lastTime, 1e15, '_lastTime jumps to the glitch value');
        engine._isRunning = false;
    });

    it('CURRENT (unfixed) behaviour: every subsequent frame on a realistic (small) clock timeline is silently and permanently rejected -- P-29, the exact P-28/D8 failure shape reached from the opposite direction', () => {
        let calls = 0;
        engine.onTick(() => { calls++; });
        engine._isRunning = true;
        engine._lastTime = 0;

        engine._loop(1e15); // the one-off glitch
        assert.equal(calls, 1);

        // A realistic page timeline resumes -- small, monotonically increasing
        // values near a normal performance.now() domain. None of these can ever
        // satisfy `time >= this._lastTime` again once _lastTime is 1e15.
        let now = 5000;
        for (let i = 0; i < 50; i++) {
            engine._loop(now);
            now += 16;
        }
        assert.equal(calls, 1, 'P-29: the engine never ticks again on the real timeline -- permanently dead, silently, exactly the shape D8 exists to prevent');
        assert.equal(engine._lastTime, 1e15, 'P-29: _lastTime stays poisoned at the glitch value forever');
        engine._isRunning = false;
    });

    it('by contrast, D8 DOES self-heal from NaN and from a merely-backwards reading (the two cases D8 was written for)', () => {
        let calls = 0;
        engine.onTick(() => { calls++; });
        engine._isRunning = true;
        engine._lastTime = 100;

        engine._loop(NaN);
        assert.equal(engine._lastTime, 100, 'a NaN reading must not advance _lastTime');
        engine._loop(50); // backwards
        assert.equal(engine._lastTime, 100, 'a backwards reading must not advance _lastTime');
        engine._loop(200); // a normal forward reading heals it
        assert.equal(calls, 1, 'the engine resumes ticking once a normal forward reading arrives');
        assert.equal(engine._lastTime, 200);
        engine._isRunning = false;
    });
});
