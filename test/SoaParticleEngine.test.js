import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SoaParticleEngine, MAX_PARTICLES, LIFE_MIN, LIFE_MAX, LANE_MAX } from '../SoaParticleEngine.js';
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
            // P-02: the loop now CLAMPS to maxDt instead of fabricating a fixed
            // 60Hz frame. A 5000ms gap must yield exactly engine.maxDt (0.1), not
            // the old 0.016 substitution -- v1.0.3 reported 0.016 for ANY gap
            // over 100ms, silently lying to the caller about how much time
            // actually passed.
            assert.equal(dt, engine.maxDt);
            assert.equal(engine.maxDt, 0.1);
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

    // =========================================================================
    // S2 door policy (decisions/0002-the-door.md): P-02, P-03, P-04, P-05, P-06,
    // P-13, P-14, P-17, P-18. Every finding gets a named failing-before /
    // passing-after test, per S2_BRIEF.md ASSERTIONS.
    // =========================================================================

    describe('constructor validation (P-03/P-18)', () => {
        // Table straight out of decisions/0002-the-door.md section 1: TypeError
        // for "not a number", RangeError for "a number outside the legal set".
        // Against v1.0.3 every one of these constructed a broken engine instead
        // of throwing (max=2.5 -> lanes of length 2, max=0 -> the P-04 NaN-head
        // trap, max=-1/Infinity -> the allocator's bare
        // "RangeError: Invalid typed array length"), so each case here fails
        // against v1.0.3 behaviour and passes only against the v1.0.4 door.
        const cases = [
            [0, RangeError],
            [2.5, RangeError],
            [NaN, RangeError],
            ['10', TypeError],
            [null, TypeError],
            [-1, RangeError],
            [Infinity, RangeError],
            [-0, RangeError], // boundary: -0 is an integer but fails >= 1
        ];
        for (const [bad, ErrCtor] of cases) {
            it('throws a ' + ErrCtor.name + ' for maxParticles = ' + String(bad), () => {
                assert.throws(() => new SoaParticleEngine(bad), (err) => {
                    assert.ok(err instanceof ErrCtor, 'expected ' + ErrCtor.name + ', got ' + err.constructor.name);
                    assert.ok(err.message.startsWith('SoaParticleEngine:'), 'message must start with SoaParticleEngine:, got: ' + err.message);
                    assert.ok(err.message.indexOf('maxParticles') !== -1, 'message must name maxParticles, got: ' + err.message);
                    return true;
                });
            });
        }

        // P-18 ceiling: MAX_PARTICLES + 1 throws a RangeError naming the argument.
        // The positive case (constructing MAX_PARTICLES lanes, 470 MB) is proven
        // by test/bench-ceiling.mjs, not allocated here.
        it('throws a RangeError for maxParticles = MAX_PARTICLES + 1', () => {
            assert.throws(() => new SoaParticleEngine(MAX_PARTICLES + 1), (err) => {
                assert.ok(err instanceof RangeError);
                assert.ok(err.message.startsWith('SoaParticleEngine:'));
                assert.ok(err.message.indexOf('maxParticles') !== -1);
                return true;
            });
        });

        // Boundary matrix: 1 (N-1-of-nothing / smallest legal), MAX_PARTICLES
        // itself is NOT constructed (470 MB, gated by bench-ceiling.mjs instead),
        // and undefined (the documented default) both still work.
        it('accepts maxParticles = 1', () => {
            const e = new SoaParticleEngine(1);
            assert.equal(e.max, 1);
            assert.equal(e.x.length, 1);
            e.destroy();
        });

        it('accepts maxParticles = undefined (default 1000)', () => {
            const e = new SoaParticleEngine(undefined);
            assert.equal(e.max, 1000);
            e.destroy();
        });

        it('rejects maxParticles = "10" as TypeError, not a string-coercion accept', () => {
            // v1.0.3 coerced '10' through the typed-array constructor path,
            // yielding a length-NaN or throwing the allocator's foreign error
            // rather than this library's own. This pins the coercion is now a
            // door-level TypeError, not a construction-time surprise.
            assert.throws(() => new SoaParticleEngine('10'), TypeError);
        });
    });

    describe('options.maxDt validation (P-02 door)', () => {
        // Infinity is DELIBERATELY absent from this bad-value loop: the S3
        // amendment to decisions/0002-the-door.md admits it (it disables the
        // clamp for a fixed-step caller). Its acceptance is asserted below.
        for (const bad of ['5', NaN, 0, -1]) {
            it('throws a branded error for maxDt = ' + String(bad), () => {
                assert.throws(() => new SoaParticleEngine(4, { maxDt: bad }), (err) => {
                    assert.ok(err instanceof TypeError || err instanceof RangeError);
                    assert.ok(err.message.startsWith('SoaParticleEngine:'), 'message must start with SoaParticleEngine:, got: ' + err.message);
                    assert.ok(err.message.indexOf('maxDt') !== -1, 'message must name maxDt, got: ' + err.message);
                    return true;
                });
            });
        }

        it('typeof-classifies maxDt errors correctly (TypeError vs RangeError)', () => {
            assert.throws(() => new SoaParticleEngine(4, { maxDt: '5' }), TypeError);
            assert.throws(() => new SoaParticleEngine(4, { maxDt: NaN }), RangeError);
            assert.throws(() => new SoaParticleEngine(4, { maxDt: 0 }), RangeError);
            assert.throws(() => new SoaParticleEngine(4, { maxDt: -1 }), RangeError);
        });

        it('ADMITS maxDt = Infinity and disables the clamp (S3 amendment to 0002, inverts the v1.0.5 throw)', () => {
            // v1.0.5 threw a RangeError here (Number.isFinite(Infinity) is false).
            // S3 relaxes the predicate to `typeof m === 'number' && m > 0`, which
            // admits Infinity (Infinity > 0) and still rejects NaN/0/negatives.
            const e = new SoaParticleEngine(4, { maxDt: Infinity });
            assert.equal(e.maxDt, Infinity);
            // A fixed-step caller: a large dt passes through UNCLAMPED because
            // `dt > Infinity` is never true.
            let seen = NaN;
            e.onTick((d) => { seen = d; });
            assert.equal(e.tick(1e9), true);
            assert.equal(seen, 1e9);
            e.destroy();
        });

        it('accepts a custom maxDt and stores it verbatim', () => {
            const e = new SoaParticleEngine(4, { maxDt: 0.25 });
            assert.equal(e.maxDt, 0.25);
            e.destroy();
        });

        it('a non-object options argument (new SoaParticleEngine(10, 5)) is accepted and yields the default maxDt', () => {
            // Reviewer-classified accepted limit, not a defect (S2_BRIEF.md section
            // 3c): `options.maxDt` is read via optional chaining semantics that
            // tolerate a primitive; `(5).maxDt` is `undefined`, so the default
            // applies. Pinned so a future change to this behaviour is visible.
            const e = new SoaParticleEngine(10, 5);
            assert.equal(e.max, 10);
            assert.equal(e.maxDt, 0.1);
            e.destroy();
        });

        it('a null options argument is accepted and yields the default maxDt', () => {
            const e = new SoaParticleEngine(10, null);
            assert.equal(e.maxDt, 0.1);
            e.destroy();
        });
    });

    describe('constructor error-message rendering (B1 gap: exotic values must not escape as a foreign error)', () => {
        // A revert of the internal _showArg helper to a bare JSON.stringify would
        // sail through every other gate (JSON.stringify throws on BigInt and on a
        // revoked Proxy get-trap) -- this is the exact gap the reviewer flagged.
        // Every case below must throw THIS library's branded TypeError, never a
        // foreign "Do not know how to serialize a BigInt" / "Cannot convert a
        // Symbol value" / "Cannot convert object to primitive value".
        const FOREIGN_SNIPPETS = [
            'Do not know how to serialize',
            'Cannot convert a Symbol',
            'Cannot convert object to primitive value',
            'Cannot perform',
        ];

        function assertBranded(v, label) {
            let err = null;
            try { new SoaParticleEngine(v); } catch (e) { err = e; }
            assert.ok(err instanceof TypeError, label + ': expected a TypeError, got ' + (err && err.constructor.name));
            assert.ok(err.message.startsWith('SoaParticleEngine:'), label + ': message must be branded, got: ' + err.message);
            for (const snippet of FOREIGN_SNIPPETS) {
                assert.ok(err.message.indexOf(snippet) === -1, label + ': message leaked a foreign engine error: ' + err.message);
            }
        }

        it('rejects a BigInt without leaking a foreign serialization error', () => {
            assertBranded(10n, 'BigInt');
        });

        it('rejects a Symbol without leaking a foreign conversion error', () => {
            assertBranded(Symbol('s'), 'Symbol');
        });

        it('rejects a circular object without invoking JSON.stringify', () => {
            const o = {};
            o.self = o;
            assertBranded(o, 'circular object');
        });

        it('rejects a null-prototype object, falling back to the unstringifiable placeholder', () => {
            assertBranded(Object.create(null), 'null-prototype object');
        });

        it('rejects a revoked Proxy, falling back to the unstringifiable placeholder', () => {
            const { proxy, revoke } = Proxy.revocable({}, {});
            revoke();
            assertBranded(proxy, 'revoked Proxy');
        });
    });

    describe('P-04: head invariant is unreachable-by-construction, not code', () => {
        it('new SoaParticleEngine(0) throws (the NaN-_head sequence is dead code)', () => {
            assert.throws(() => new SoaParticleEngine(0), RangeError);
        });

        it('_head stays an integer in [0, max) across a full wrap-around boundary matrix (0, 1, N-1, N, N+1 emits)', () => {
            const e = new SoaParticleEngine(4); // N = 4
            const heads = [];
            for (let i = 0; i <= 5; i++) { // 0..N+1 emits
                heads.push(e._head);
                e.emit(i, i, 0, 0, 1);
                assert.ok(Number.isInteger(e._head) && e._head >= 0 && e._head < e.max,
                    'after emit #' + i + ', _head=' + e._head + ' is not an integer in [0, ' + e.max + ')');
            }
            // 0, 1, 2, 3, 0, 1 -- the ring wrapped exactly once by emit #4 (N).
            assert.deepEqual(heads, [0, 1, 2, 3, 0, 1]);
            e.destroy();
        });
    });

    describe('life band (P-05 low end / P-17 high end)', () => {
        // Against v1.0.3 every one of these stored a corrupted lane: 1e-46 and
        // 1e-40 produced life=0/invLife=Infinity/alpha=NaN; 1e39 and 1e300 stored
        // life=Infinity. Each must now be rejected before any lane write.
        const rejected = [1e-46, 1e-40, 1e39, 1e300, NaN, Infinity, -Infinity, 0, -0, -1];
        for (const life of rejected) {
            it('rejects life = ' + life + ', lanes byte-identical', () => {
                const e = new SoaParticleEngine(4);
                const snapshot = {
                    x: Array.from(e.x), y: Array.from(e.y), vx: Array.from(e.vx), vy: Array.from(e.vy),
                    life: Array.from(e.life), invLife: Array.from(e.invLife), data: Array.from(e.data),
                    head: e._head,
                };
                e.emit(1, 2, 3, 4, life, 9);
                assert.equal(e._head, snapshot.head, 'head must not advance');
                assert.deepEqual(Array.from(e.x), snapshot.x);
                assert.deepEqual(Array.from(e.y), snapshot.y);
                assert.deepEqual(Array.from(e.vx), snapshot.vx);
                assert.deepEqual(Array.from(e.vy), snapshot.vy);
                assert.deepEqual(Array.from(e.life), snapshot.life);
                assert.deepEqual(Array.from(e.invLife), snapshot.invLife);
                assert.deepEqual(Array.from(e.data), snapshot.data);
                e.destroy();
            });
        }

        it('rejects an emit with life omitted (undefined)', () => {
            const e = new SoaParticleEngine(4);
            // life is a required positional argument; calling without it passes
            // `undefined`, which fails the `>= LIFE_MIN && <= LIFE_MAX` band test
            // (both comparisons against undefined/NaN are false) and is rejected.
            e.emit(1, 2, 3, 4, undefined);
            assert.equal(e._head, 0);
            assert.equal(e.life[0], 0);
            e.destroy();
        });

        it('LIFE_MIN is accepted with a finite positive invLife', () => {
            const e = new SoaParticleEngine(4);
            e.emit(0, 0, 0, 0, LIFE_MIN);
            assert.equal(e._head, 1);
            assert.ok(Number.isFinite(e.invLife[0]) && e.invLife[0] > 0);
            e.destroy();
        });

        it('the f32 step just below LIFE_MIN (2.9387359646368754e-39) is rejected', () => {
            const e = new SoaParticleEngine(4);
            e.emit(0, 0, 0, 0, 2.9387359646368754e-39);
            assert.equal(e._head, 0);
            assert.equal(e.life[0], 0);
            e.destroy();
        });

        it('LIFE_MAX is accepted with a finite stored life', () => {
            const e = new SoaParticleEngine(4);
            e.emit(0, 0, 0, 0, LIFE_MAX);
            assert.equal(e._head, 1);
            assert.ok(Number.isFinite(e.life[0]) && e.life[0] > 0);
            e.destroy();
        });

        it('the f32 step just above LIFE_MAX (3.4028235677973366e+38) is rejected', () => {
            const e = new SoaParticleEngine(4);
            e.emit(0, 0, 0, 0, 3.4028235677973366e+38);
            assert.equal(e._head, 0);
            assert.equal(e.life[0], 0);
            e.destroy();
        });
    });

    describe('position/velocity band (P-19)', () => {
        // v1.0.4 guarded x/y/vx/vy with Number.isFinite, which passes for any
        // finite f64 while the lanes are f32: emit(1e300, 0, 1e300, 0, 1) stored
        // Infinity into x and vx and the caller's own physics turned it into NaN
        // on the first frame. v1.0.5 rejects anything outside the SYMMETRIC f32
        // band [-LANE_MAX, LANE_MAX]. Numbers are the bisection-measured pair from
        // decisions/0002-the-door.md, not literals anyone typed.
        const LANES = ['x', 'y', 'vx', 'vy', 'life', 'invLife', 'data'];
        const OVER = 3.4028235677973366e+38; // one f32 step past LANE_MAX -> f32 Infinity

        // Emit with `value` placed in exactly one of the four position/velocity
        // slots; every other argument is legal. This exercises each lane
        // INDEPENDENTLY, so a guard that checks x but forgets vy is caught.
        const emitLaneValue = (laneIndex, value) => {
            const e = new SoaParticleEngine(4);
            const args = [0, 0, 0, 0, 1, 9];
            args[laneIndex] = value; // 0=x 1=y 2=vx 3=vy
            e.emit(args[0], args[1], args[2], args[3], args[4], args[5]);
            return e;
        };

        const snapOf = (e) => ({
            x: Array.from(e.x), y: Array.from(e.y), vx: Array.from(e.vx), vy: Array.from(e.vy),
            life: Array.from(e.life), invLife: Array.from(e.invLife), data: Array.from(e.data),
            head: e._head,
        });

        it('emit(1e300, 0, 1e300, 0, 1) is rejected; head unmoved; all seven lanes byte-identical (P-19 headline)', () => {
            const e = new SoaParticleEngine(4);
            const before = snapOf(e);
            e.emit(1e300, 0, 1e300, 0, 1);
            assert.equal(e._head, before.head, 'head must not advance on a rejected emit');
            for (const l of LANES) assert.deepEqual(Array.from(e[l]), before[l], 'lane ' + l + ' must be byte-identical');
            e.destroy();
        });

        // Reject NaN, both infinities, and the first value PAST the measured
        // endpoint -- on each of the four lanes independently.
        for (let laneIndex = 0; laneIndex < 4; laneIndex++) {
            const laneName = LANES[laneIndex];
            for (const value of [NaN, Infinity, -Infinity, OVER, -OVER, 1e300, -1e300]) {
                it('rejects ' + value + ' in lane ' + laneName + ' (head unmoved, lanes byte-identical)', () => {
                    const e = new SoaParticleEngine(4);
                    const before = snapOf(e);
                    // Re-emit the same lane value; every other arg legal.
                    const args = [0, 0, 0, 0, 1, 9];
                    args[laneIndex] = value;
                    e.emit(args[0], args[1], args[2], args[3], args[4], args[5]);
                    assert.equal(e._head, before.head, 'head must not advance');
                    for (const l of LANES) assert.deepEqual(Array.from(e[l]), before[l], 'lane ' + l + ' changed');
                    e.destroy();
                });
            }

            // The measured endpoint +/-LANE_MAX is ACCEPTED on every lane.
            for (const value of [LANE_MAX, -LANE_MAX]) {
                it('accepts the measured endpoint ' + value + ' in lane ' + laneName, () => {
                    const e = emitLaneValue(laneIndex, value);
                    assert.equal(e._head, 1, 'endpoint value must be accepted (head advances)');
                    assert.equal(e[laneName][0], Math.fround(value), 'endpoint stores as its f32 rounding, not Infinity');
                    assert.ok(Number.isFinite(e[laneName][0]), 'stored value must be finite');
                    e.destroy();
                });
            }

            // The band has NO floor: 0, -0, ordinary negatives and a subnormal are
            // all ACCEPTED. Copying the one-sided `life` test is the known-wrong
            // implementation, and this pin catches it.
            for (const value of [0, -0, -1, -12345.678, 1.4e-45 /* smallest positive f32 subnormal */, -1.4e-45]) {
                it('accepts no-floor value ' + value + ' in lane ' + laneName, () => {
                    const e = emitLaneValue(laneIndex, value);
                    assert.equal(e._head, 1, value + ' must be accepted (the band has no floor)');
                    assert.equal(e[laneName][0], Math.fround(value), 'value stores as its f32 rounding');
                    e.destroy();
                });
            }
        }

        it('LANE_MAX is the measured f32 boundary (bisection), equal to LIFE_MAX but declared independently', () => {
            assert.equal(LANE_MAX, 3.4028235677973362e+38, 'LANE_MAX is the measured largest finite-f32 f64');
            assert.ok(Number.isFinite(Math.fround(LANE_MAX)), 'fround(LANE_MAX) is finite');
            assert.ok(!Number.isFinite(Math.fround(OVER)), 'fround(one step past) is Infinity');
            assert.ok(Number.isFinite(Math.fround(-LANE_MAX)), 'negative side is symmetric and finite');
            assert.ok(!Number.isFinite(Math.fround(-OVER)), 'negative side one step past is Infinity');
            // Equal number, independent contract: verified equal here on purpose,
            // NOT aliased in source.
            assert.equal(LANE_MAX, LIFE_MAX);
        });

        it('the rejection set is a strict SUPERSET of v1.0.4 (full old corpus, per lane INCLUDING life; not narrowed to numbers)', () => {
            // Number.isFinite rejects far more than the non-finite numbers: null,
            // numeric strings, "", booleans, arrays, undefined and plain objects
            // too. The band uses relational operators, which COERCE (null -> 0,
            // "5" -> 5, [7] -> 7, true -> 1), so each of those must be caught by the
            // typeof half of the guard (P-23). The corpus is the FULL old-rejected
            // set -- narrowing it to numbers is exactly how the first S2.1 draft's
            // regression slipped every gate. Asserted per lane and life INCLUDED: a
            // door that rejects x = "1" while accepting life = "1" is not a policy.
            const oldRejected = [
                NaN, Infinity, -Infinity,
                null, '5', '', false, true, [], [7], undefined, {},
            ];
            // lanes 0=x 1=y 2=vx 3=vy 4=life (emitLaneValue's args[4] is life)
            for (let laneIndex = 0; laneIndex <= 4; laneIndex++) {
                for (const bad of oldRejected) {
                    // Premise: v1.0.4's Number.isFinite chain rejected every one.
                    assert.ok(!Number.isFinite(bad),
                        'premise: ' + String(bad) + ' was isFinite-rejected in v1.0.4');
                    const e = emitLaneValue(laneIndex, bad);
                    assert.equal(e._head, 0,
                        'superset: ' + String(bad) + ' in lane ' + LANES[laneIndex] + ' must still be rejected');
                    e.destroy();
                }
            }
            // STRICT for x/y/vx/vy: a finite value v1.0.4 ACCEPTED (isFinite true)
            // that the band now rejects, so the new set is strictly larger there.
            // life is excluded from this marker: v1.0.4 already rejected 1e300 as
            // life via the P-17 band, so it is not a new reject on that lane.
            assert.ok(Number.isFinite(1e300), 'premise: 1e300 is a finite f64, accepted by v1.0.4');
            for (let laneIndex = 0; laneIndex < 4; laneIndex++) {
                const strict = emitLaneValue(laneIndex, 1e300);
                assert.equal(strict._head, 0,
                    'strict: 1e300 in lane ' + LANES[laneIndex] + ' was accepted by v1.0.4 and must now be rejected');
                strict.destroy();
            }
        });
    });

    describe('emit() never throws on hostile inputs (P-24)', () => {
        // The load-bearing promise of the door: the constructor throws, emit()
        // NEVER does (it is per particle per frame; a throw there is a render-loop
        // crash). v1.0.4 broke it on dataFlag -- `(dataFlag | 0)` invokes ToNumeric,
        // which THROWS for BigInt/Symbol and RUNS caller code (valueOf,
        // Symbol.toPrimitive) for objects, propagating straight out of emit(). The
        // fix leads every guard with `typeof`, so the coercing operator is reached
        // only for primitive numbers. Pinned across ALL SIX arguments, not just
        // dataFlag: the five lanes are throw-safe today only because P-23 forced
        // them to lead with typeof, and nothing else pinned it -- which is exactly
        // how the dataFlag hole survived.
        const LANES = ['x', 'y', 'vx', 'vy', 'life', 'invLife', 'data'];
        const ARGN = ['x', 'y', 'vx', 'vy', 'life', 'dataFlag'];

        // Fresh hostile values per case (a revoked Proxy throws on every internal
        // method; the throwing objects run caller code on coercion).
        const hostiles = () => {
            const revocable = Proxy.revocable({}, {});
            revocable.revoke();
            return [
                ['BigInt', 10n],
                ['Symbol', Symbol('s')],
                ['throwing valueOf', { valueOf() { throw new Error('boom'); } }],
                ['throwing Symbol.toPrimitive', { [Symbol.toPrimitive]() { throw new Error('boom'); } }],
                ['revoked Proxy', revocable.proxy],
            ];
        };

        for (let arg = 0; arg < 6; arg++) {
            for (const [name] of hostiles()) {
                it('does not throw and rejects a ' + name + ' in ' + ARGN[arg] + ' (head unmoved, lanes byte-identical)', () => {
                    const e = new SoaParticleEngine(4);
                    const before = LANES.map((l) => Array.from(e[l]));
                    const head0 = e._head;
                    // Rebuild the hostile value inside the test so each `it` owns it.
                    const val = hostiles().find(([n]) => n === name)[1];
                    const a = [0, 0, 0, 0, 1, 0];
                    a[arg] = val;
                    assert.doesNotThrow(() => e.emit(a[0], a[1], a[2], a[3], a[4], a[5]),
                        'emit() must not throw on a hostile ' + ARGN[arg]);
                    assert.equal(e._head, head0, 'head must not advance on a rejected emit');
                    for (let i = 0; i < LANES.length; i++) {
                        assert.deepEqual(Array.from(e[LANES[i]]), before[i],
                            'lane ' + LANES[i] + ' must be byte-identical after a rejected hostile emit');
                    }
                    e.destroy();
                });
            }
        }
    });

    describe('llms.txt rejection contract matches the guard chain (P-20)', () => {
        // A documented rejection list that the code does not implement is the same
        // fail-open class as an unvalidated input: the caller reasons from the
        // wrong list. Assert the shipped llms.txt names each of the three
        // implemented emit() rejection causes, so the doc and the guard chain
        // cannot drift silently. This is a test, not a manual pass -- the same
        // shape as the ASCII guard.
        const llms = readFileSync(
            fileURLToPath(new URL('../llms.txt', import.meta.url)), 'utf8');
        const src = readFileSync(
            fileURLToPath(new URL('../SoaParticleEngine.js', import.meta.url)), 'utf8');
        const readme = readFileSync(
            fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

        it('does NOT still carry the stale v1.0.4 rejection wording', () => {
            // The exact P-20 drift string: "silently rejects non-finite x/y/vx/vy
            // or life <= 0". Both halves are wrong post-S2/S2.1.
            assert.ok(llms.indexOf('life <= 0') === -1,
                'llms.txt still documents "life <= 0", a rejection contract emit() does not implement');
            assert.ok(llms.indexOf('non-finite x/y/vx/vy') === -1,
                'llms.txt still documents "non-finite x/y/vx/vy", superseded by the [-LANE_MAX, LANE_MAX] band');
        });

        it('documents the x/y/vx/vy band rejection', () => {
            assert.ok(/x\/y\/vx\/vy[^\n]*\[-LANE_MAX, LANE_MAX\]/.test(llms),
                'llms.txt must document the x/y/vx/vy band [-LANE_MAX, LANE_MAX]');
            // The band is actually implemented against LANE_MAX in the source.
            assert.ok(src.indexOf('<= LANE_MAX)) return -1;') !== -1,
                'source emit() must guard the lanes against LANE_MAX');
        });

        it('documents the life band rejection', () => {
            assert.ok(/life[^\n]*\[LIFE_MIN, LIFE_MAX\]/.test(llms),
                'llms.txt must document the life band [LIFE_MIN, LIFE_MAX]');
            assert.ok(src.indexOf('life >= LIFE_MIN && life <= LIFE_MAX') !== -1,
                'source emit() must guard life against the band');
        });

        it('documents the dataFlag int32 rejection, and the source guard leads with typeof (P-24)', () => {
            assert.ok(/dataFlag[^\n]*int32/.test(llms),
                'llms.txt must document the dataFlag int32 rejection (added in S2, previously undocumented)');
            // The shipped guard is typeof-FIRST so a hostile BigInt/Symbol/object
            // is rejected without throwing (P-24): `|` invokes ToNumeric, which
            // throws or runs caller code, and is reached only once typeof narrows
            // dataFlag to a number. Assert both halves, so dropping either fails.
            assert.ok(src.indexOf("typeof dataFlag === 'number'") !== -1,
                'source emit() dataFlag guard must lead with typeof (P-24), so `|` never runs on a non-number');
            assert.ok(src.indexOf('(dataFlag | 0) === dataFlag') !== -1,
                'source emit() must keep the exact-int32 test after the typeof gate');
        });

        it('LANE_MAX is documented in the Exports block beside LIFE_MIN/LIFE_MAX', () => {
            assert.ok(/`LANE_MAX`/.test(llms), 'llms.txt Exports must list LANE_MAX');
        });

        it('documents the TYPE cause (typeof / not coerced), not only the range cause, for x/y/vx/vy AND life (P-23)', () => {
            // The band uses relational operators, which COERCE: null -> 0 is INSIDE
            // the band. A doc that gives the rejection reason as "outside the band"
            // alone tells a reader emit(null, 0, 0, 0, 1) is accepted -- it is not.
            // That is the P-20 fail-open class recurring. The doc must name the type
            // rejection and that coercion does NOT happen; the source must implement
            // it with typeof on the lanes AND on life. A drift guard that only checks
            // the range half -- the half that was already right -- is decorative.
            const src2 = src; // alias for readability in messages below

            // Both shipped docs must state the coercion is rejected, not silently
            // applied. "not coerced" is the exact sentence a reader needs.
            assert.ok(/not coerced/i.test(llms),
                'llms.txt must state a numeric string / boolean / array / null is REJECTED, not coerced');
            assert.ok(/not coerced/i.test(readme),
                'README.md Input Contract must state coerced non-numbers are rejected, not coerced');

            // Both docs must name the typeof / not-a-number type cause explicitly.
            assert.ok(/not a number/i.test(llms) || /typeof/.test(llms),
                'llms.txt must name the type (not-a-number / typeof) rejection cause for x/y/vx/vy and life');
            assert.ok(/not a number/i.test(readme) || /typeof/.test(readme),
                'README.md must name the type (not-a-number / typeof) rejection cause');

            // The source must actually implement the type half -- on a position lane
            // AND on life, since life carried the identical coercion hole (P-23).
            assert.ok(src2.indexOf("typeof vy === 'number'") !== -1,
                "source emit() must type-check a position lane with typeof (e.g. typeof vy === 'number')");
            assert.ok(src2.indexOf("typeof life === 'number'") !== -1,
                "source emit() must type-check life with typeof (typeof life === 'number')");
        });

        it('documents tick(dt)`s rejection set (typeof + >= 0), and the source guard leads with typeof (S3 D3)', () => {
            // tick(dt) is a NEW door: dt is a caller argument in the hot path, so
            // the same drift guard emit() has must cover it, or the doc describes
            // half the door. A reader must learn that a non-number OR a negative dt
            // is rejected -- and that coercion does NOT happen (the P-23 class one
            // entry point over). The source must lead with typeof so the P-24
            // corpus (BigInt/Symbol/throwing valueOf) is rejected WITHOUT throwing.
            assert.ok(/tick\(dt\)/.test(llms),
                'llms.txt must document the tick(dt) stepping API');
            assert.ok(/not a number/i.test(llms) && /< 0|>= 0|negative/i.test(llms),
                'llms.txt must name BOTH tick rejection causes: not-a-number AND the low-side (< 0 / negative)');
            // The shipped guard is typeof-FIRST, one negation, exactly emit()'s shape.
            assert.ok(src.indexOf("!(typeof dt === 'number' && dt >= 0)") !== -1,
                'source tick() must guard dt with the typeof-first, one-negation predicate !(typeof dt === \'number\' && dt >= 0)');
        });
    });

    describe('alpha tolerance at birth', () => {
        // MEASURED bound from decisions/0002-the-door.md: worst |alpha - 1| over
        // 200k log-uniform samples is 2.310343916178681e-7, between 2**-23 and
        // 2**-22. The assertion uses 2**-22 -- NOT 2**-23, which is below the
        // measured worst case and would false-fail on legal input.
        const BOUND = 2 ** -22;
        const samples = [LIFE_MIN, LIFE_MAX, 1, 0.016, 1000, 3.256154474696478e-39 /* measured worst case */];
        for (const life of samples) {
            it('|alpha - 1| <= 2**-22 at birth for life = ' + life, () => {
                const e = new SoaParticleEngine(4);
                e.emit(0, 0, 0, 0, life);
                const alpha = e.life[0] * e.invLife[0];
                assert.ok(Number.isFinite(alpha), 'alpha must be finite, got ' + alpha);
                assert.ok(Math.abs(alpha - 1) <= BOUND,
                    'life=' + life + ': |alpha-1|=' + Math.abs(alpha - 1) + ' exceeds bound ' + BOUND);
                e.destroy();
            });
        }

        it('alpha decreases monotonically to 0 as life decays (consumer-side aging via the documented alpha formula)', () => {
            // The engine does not age particles itself -- onTick hands the caller
            // raw arrays and the caller decrements life[i] each frame (see the
            // class doc comment). alpha = life[i] * invLife[i] is the documented
            // formula (llms.txt); this asserts the mathematical property the
            // formula promises: a strictly decreasing sequence ending at/near 0
            // as life is driven down to 0, never negative, never NaN mid-decay.
            const e = new SoaParticleEngine(4);
            const life0 = 2.0;
            e.emit(0, 0, 0, 0, life0);
            const steps = 50;
            let prevAlpha = Infinity;
            // Drive life[0] directly to fraction (1 - i/steps) of its birth value
            // -- exactly 0 on the final step -- rather than accumulating f32
            // subtraction error across 50 in-place decrements, which does not
            // land on exactly 0 (it is off by ~7e-7 at step 50, a rounding
            // artifact of repeated float32 truncation, not a monotonicity
            // violation). The property under test is monotonic decrease to 0,
            // not a particular decay integration scheme.
            for (let i = 1; i <= steps; i++) {
                e.life[0] = Math.fround(life0 * (1 - i / steps));
                const alpha = e.life[0] * e.invLife[0];
                assert.ok(Number.isFinite(alpha), 'alpha went non-finite mid-decay at step ' + i + ', got ' + alpha);
                assert.ok(alpha <= prevAlpha, 'alpha increased at step ' + i + ': ' + alpha + ' > previous ' + prevAlpha);
                assert.ok(alpha >= 0, 'alpha went negative at step ' + i + ': ' + alpha);
                prevAlpha = alpha;
            }
            assert.equal(e.life[0], 0, 'life must reach exactly 0 after fully decaying');
            assert.equal(prevAlpha, 0, 'alpha must reach exactly 0 once life reaches 0');
            e.destroy();
        });

        it('2**-23 would be too tight for the measured worst case (control, not a package assertion)', () => {
            // This proves the BOUND choice is load-bearing: the measured worst
            // case documented in decisions/0002-the-door.md (2.310343916178681e-7)
            // is ABOVE 2**-23, so asserting that tighter bound would fail on this
            // exact legal input. This test does not touch the engine's contract --
            // it protects the *test suite* from silently tightening the bound.
            const measuredWorst = 2.310343916178681e-7;
            assert.ok(measuredWorst > 2 ** -23);
            assert.ok(measuredWorst <= 2 ** -22);
        });
    });

    describe('P-02 dt clamp', () => {
        function dtFor(gapMs, options) {
            let dt = NaN;
            const e = new SoaParticleEngine(4, options);
            e.onTick((d) => { dt = d; });
            e._isRunning = true;
            e._lastTime = 0;
            e._loop(gapMs);
            e.destroy();
            return dt;
        }

        it('a 101ms gap yields exactly maxDt (0.1), not 0.016', () => {
            assert.equal(dtFor(101), 0.1);
        });

        it('a 200ms gap yields exactly maxDt (0.1), not 0.016', () => {
            assert.equal(dtFor(200), 0.1);
        });

        it('dt is never 0.016 unless the frame really was a 16ms frame', () => {
            // The negative control: a real 16ms frame DOES report ~0.016 (the
            // clamp does not touch legal frames), so the property being asserted
            // for 101/200/5000ms is discriminating, not a suite that always
            // expects != 0.016.
            assert.ok(Math.abs(dtFor(16) - 0.016) < 1e-9);
            for (const gap of [101, 200, 5000]) {
                assert.notEqual(dtFor(gap), 0.016);
            }
        });

        it('a custom { maxDt: 0.25 } option is honoured by the loop', () => {
            assert.equal(dtFor(300, { maxDt: 0.25 }), 0.25);
            assert.ok(Math.abs(dtFor(50, { maxDt: 0.25 }) - 0.05) < 1e-9);
        });
    });

    describe('P-06 dataFlag policy', () => {
        // Against v1.0.3 these were silent Int32Array coercions with no policy:
        // 3.7 -> 3, 2**31 -> -2147483648, NaN -> 0, 'x' -> 0, null -> 0, ALL
        // accepted and none distinguishable from a caller's intended data. Each
        // must now be rejected before any lane write.
        for (const flag of [3.7, 2 ** 31, NaN, 'x', null]) {
            it('rejects dataFlag = ' + String(flag) + ' (head unchanged, data[0] still 0)', () => {
                const e = new SoaParticleEngine(4);
                e.emit(0, 0, 0, 0, 1, flag);
                assert.equal(e._head, 0);
                assert.equal(e.data[0], 0);
                e.destroy();
            });
        }

        for (const flag of [-1, 0, 2 ** 31 - 1]) {
            it('accepts dataFlag = ' + flag, () => {
                const e = new SoaParticleEngine(4);
                e.emit(0, 0, 0, 0, 1, flag);
                assert.equal(e._head, 1);
                assert.equal(e.data[0], flag);
                e.destroy();
            });
        }

        it('accepts dataFlag = -0 (int32 identity, stores as 0)', () => {
            const e = new SoaParticleEngine(4);
            e.emit(0, 0, 0, 0, 1, -0);
            assert.equal(e._head, 1);
            assert.equal(e.data[0], 0);
            e.destroy();
        });

        it('omitted dataFlag defaults to 0 and is accepted', () => {
            const e = new SoaParticleEngine(4);
            e.emit(0, 0, 0, 0, 1);
            assert.equal(e._head, 1);
            assert.equal(e.data[0], 0);
            e.destroy();
        });
    });

    describe('P-13 clear() semantics (life-only, per decisions/0002)', () => {
        it('zeroes life and resets head but leaves x/vx/data untouched (explicit repro: 5, 7, ..., 42)', () => {
            const e = new SoaParticleEngine(4);
            e.emit(5, 6, 7, 8, 1, 42);
            e.clear();
            assert.equal(e.life[0], 0, 'life must be zeroed');
            assert.equal(e._head, 0, 'head must reset');
            // The recorded contract, not an accident: x/vx/data are stale, not
            // zeroed, because clear() is documented as life-only.
            assert.equal(e.x[0], 5, 'x must remain the stale pre-clear value');
            assert.equal(e.vx[0], 7, 'vx must remain the stale pre-clear value');
            assert.equal(e.data[0], 42, 'data must remain the stale pre-clear value');
            e.destroy();
        });
    });

    describe('P-14 lane identity (reassigned only by destroy())', () => {
        const LANES = ['x', 'y', 'vx', 'vy', 'life', 'invLife', 'data'];

        it('every lane keeps the same object identity across emit/clear/start/stop/pause/onTick', () => {
            const e = new SoaParticleEngine(4);
            const before = LANES.map((l) => e[l]);
            e.emit(1, 2, 3, 4, 1, 5);
            e.onTick(() => {});
            e.start();
            e.stop();
            e.pause();
            e.clear();
            e.emit(0, 0, 0, 0, 0); // rejected emit, also must not reassign lanes
            const after = LANES.map((l) => e[l]);
            for (let i = 0; i < LANES.length; i++) {
                assert.equal(after[i], before[i], 'lane ' + LANES[i] + ' identity changed without destroy()');
            }
            e.destroy();
        });

        it('destroy() sets all seven lanes to null, and only destroy() does', () => {
            const e = new SoaParticleEngine(4);
            const before = LANES.map((l) => e[l]);
            assert.ok(before.every((v) => v !== null));
            e.destroy();
            for (const l of LANES) {
                assert.equal(e[l], null, 'lane ' + l + ' must be null after destroy()');
            }
        });
    });

    describe('lifecycle abuse boundary matrix (post-destroy no-ops, duplicate dispose, reentrancy)', () => {
        it('duplicate dispose does not throw and leaves lanes null both times', () => {
            const e = new SoaParticleEngine(4);
            e.destroy();
            assert.equal(e.x, null);
            assert.doesNotThrow(() => e.destroy());
            assert.equal(e.x, null);
        });

        it('emit/clear/start/stop/pause/onTick/destroy after destroy are all no-ops that never throw', () => {
            const e = new SoaParticleEngine(4);
            e.destroy();
            assert.doesNotThrow(() => e.emit(0, 0, 0, 0, 1));
            assert.doesNotThrow(() => e.clear());
            assert.doesNotThrow(() => e.start());
            assert.doesNotThrow(() => e.stop());
            assert.doesNotThrow(() => e.pause());
            assert.doesNotThrow(() => e.onTick(() => {}));
            assert.doesNotThrow(() => e.destroy());
            assert.equal(e._isRunning, false);
            assert.equal(e.x, null); // emit() after destroy must not resurrect a lane
        });

        it('clear() before any emit does not throw and leaves head at 0', () => {
            const e = new SoaParticleEngine(4);
            assert.doesNotThrow(() => e.clear());
            assert.equal(e._head, 0);
            e.destroy();
        });

        it('stop() before start() does not throw', () => {
            const e = new SoaParticleEngine(4);
            assert.doesNotThrow(() => e.stop());
            assert.equal(e._isRunning, false);
            e.destroy();
        });

        it('re-entrant emit from within onTick writes to the current head without throwing', () => {
            const e = new SoaParticleEngine(4);
            e.onTick(() => { e.emit(9, 9, 0, 0, 1, 1); });
            e._isRunning = true;
            e._lastTime = 0;
            assert.doesNotThrow(() => e._loop(16));
            assert.equal(e.x[0], 9);
            assert.equal(e._head, 1);
            e.destroy();
        });

        it('destroy-during-iteration (destroy() called from within onTick) leaves NO pending frame (P-26 fixed in S3, D7)', () => {
            // Was an adversarial FINDING: _loop() used to re-arm requestAnimationFrame
            // AFTER invoking onTick unconditionally, even when onTick just called
            // destroy(), leaving one orphaned RAF callback on a torn-down engine.
            // S3 D7 guards the re-arm on `_isRunning && !_destroyed`, so no orphaned
            // frame is scheduled. This pin is flipped from pending()===true to
            // pending()===false -- the visible, deliberate diff of the P-26 fix.
            const e = new SoaParticleEngine(4);
            let ticks = 0;
            e.onTick(() => { ticks++; e.destroy(); });
            e.start();
            assert.doesNotThrow(() => pump.pump(16));
            assert.equal(e._destroyed, true);
            assert.equal(e._isRunning, false);
            assert.equal(ticks, 1);
            // The re-arm is guarded: after destroy() from inside onTick, no frame
            // is pending. A second pump has nothing to fire and re-invokes nothing.
            assert.equal(pump.pending(), false);
            assert.doesNotThrow(() => pump.pump(32));
            assert.equal(ticks, 1);
            assert.equal(pump.pending(), false);
        });
    });
});
