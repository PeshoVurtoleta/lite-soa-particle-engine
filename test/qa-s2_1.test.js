/**
 * QA S2.1 (v1.0.5) -- boundary coverage the planner/reviewer/coder rounds did not
 * exercise: BigInt, Symbol, Proxy (throwing traps, revoked), boxed-Number,
 * hostile valueOf/Symbol.toPrimitive, the double-read/TOCTOU question, and the
 * `Number.MAX_VALUE` adversarial case. `SoaParticleEngine.js` is frozen for this
 * stage; this file only adds tests, it never edits production code.
 *
 * QA found P-24 here: dataFlag was the one guard without a leading `typeof`, so
 * `(dataFlag | 0)` invoked ToNumeric on an unvalidated argument -- throwing for
 * BigInt/Symbol and running caller code (valueOf / Symbol.toPrimitive) for
 * objects -- breaking emit()'s "never throws" contract. It was shipped in v1.0.4.
 * The three dataFlag cases below were originally BLOCKER pins asserting the throw;
 * once the P-24 fix landed (dataFlag now leads with `typeof`, like the five lanes)
 * they were INVERTED to assert the shipped contract, exactly as S2 inverted the
 * T1 pins: emit() does not throw, the emit is rejected, head is unmoved, and all
 * seven lanes are byte-identical. Each keeps its P-24 reference so the history
 * stays legible.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SoaParticleEngine, LANE_MAX, LIFE_MIN, LIFE_MAX } from '../SoaParticleEngine.js';

describe('QA S2.1: boundary matrix for BigInt / Symbol / Proxy / hostile coercion', () => {
    let engine;
    beforeEach(() => { engine = new SoaParticleEngine(4); });
    afterEach(() => { engine.destroy(); });

    const snap = (e) => ({
        x: Array.from(e.x), y: Array.from(e.y), vx: Array.from(e.vx), vy: Array.from(e.vy),
        life: Array.from(e.life), invLife: Array.from(e.invLife), data: Array.from(e.data),
        head: e._head,
    });
    const assertUntouched = (e, before) => {
        assert.equal(e._head, before.head, 'head must not advance on a rejected emit');
        for (const l of ['x', 'y', 'vx', 'vy', 'life', 'invLife', 'data']) {
            assert.deepEqual(Array.from(e[l]), before[l], 'lane ' + l + ' must be byte-identical');
        }
    };

    // -----------------------------------------------------------------------
    // BigInt into each of x/y/vx/vy/life. Premise: relational comparison of a
    // BigInt against a Number does NOT throw (unlike arithmetic mixing); the
    // brief asks which of the two guard halves is actually doing the
    // rejecting here. Answer, proven below: `typeof 10n === 'bigint'`, so the
    // `typeof === 'number'` half short-circuits the `&&` chain and the
    // relational compare is never reached at all for this input.
    // -----------------------------------------------------------------------
    describe('BigInt(10n)', () => {
        it('premise: relational comparison of a BigInt against a Number does not throw', () => {
            assert.doesNotThrow(() => { 10n >= -1e5; });
            assert.doesNotThrow(() => { 10n <= 1e5; });
        });

        for (const lane of ['x', 'y', 'vx', 'vy']) {
            it('rejects BigInt(10n) in lane ' + lane + ' without throwing (typeof gate, not the range half)', () => {
                const before = snap(engine);
                const args = { x: 0, y: 0, vx: 0, vy: 0, life: 1, dataFlag: 9 };
                args[lane] = 10n;
                assert.doesNotThrow(() => engine.emit(args.x, args.y, args.vx, args.vy, args.life, args.dataFlag));
                assertUntouched(engine, before);
            });
        }

        it('rejects BigInt(10n) as life without throwing', () => {
            const before = snap(engine);
            assert.doesNotThrow(() => engine.emit(0, 0, 0, 0, 10n));
            assertUntouched(engine, before);
        });

        it('P-24: BigInt(10n) as dataFlag is rejected WITHOUT throwing (typeof gate leads the dataFlag guard)', () => {
            // v1.0.4's dataFlag guard `(dataFlag | 0) !== dataFlag` threw here:
            // `|` invokes ToNumeric, which for a BigInt raises "Cannot mix BigInt
            // and other types", propagating out of emit() and breaking its
            // documented never-throws contract. The P-24 fix leads the guard with
            // `typeof dataFlag === 'number'`, so `|` is reached only for numbers;
            // a BigInt short-circuits and is rejected, head unmoved, lanes intact.
            // Repro (throws on v1.0.4): `new SoaParticleEngine(4).emit(0,0,0,0,1, 10n)`.
            const before = snap(engine);
            assert.doesNotThrow(() => engine.emit(0, 0, 0, 0, 1, 10n));
            assertUntouched(engine, before);
        });
    });

    // -----------------------------------------------------------------------
    // Symbol. Premise: relational comparison of a Symbol DOES throw a
    // TypeError (ToNumeric on a Symbol always throws). Does emit() leak that
    // throw for x/y/vx/vy/life? Answer, proven below: no -- because typeof is
    // evaluated FIRST in the `&&` chain and short-circuits before the
    // relational operator ever runs on the Symbol.
    // -----------------------------------------------------------------------
    describe('Symbol()', () => {
        it('premise: a bare relational comparison of a Symbol against a Number throws TypeError', () => {
            assert.throws(() => { Symbol('s') >= 5; }, TypeError);
        });

        for (const lane of ['x', 'y', 'vx', 'vy']) {
            it('rejects Symbol() in lane ' + lane + ' WITHOUT throwing (typeof gate runs before the throwing relational compare)', () => {
                const before = snap(engine);
                const args = { x: 0, y: 0, vx: 0, vy: 0, life: 1, dataFlag: 9 };
                args[lane] = Symbol('s');
                assert.doesNotThrow(() => engine.emit(args.x, args.y, args.vx, args.vy, args.life, args.dataFlag));
                assertUntouched(engine, before);
            });
        }

        it('rejects Symbol() as life without throwing', () => {
            const before = snap(engine);
            assert.doesNotThrow(() => engine.emit(0, 0, 0, 0, Symbol('l')));
            assertUntouched(engine, before);
        });

        it('P-24: Symbol() as dataFlag is rejected WITHOUT throwing (typeof gate runs before the throwing ToNumeric)', () => {
            // v1.0.4 threw here: `dataFlag | 0` performs ToNumeric(dataFlag), which
            // for a Symbol raises "Cannot convert a Symbol value to a number". The
            // P-24 typeof-first guard rejects the Symbol before `|` runs.
            // Repro (throws on v1.0.4): `new SoaParticleEngine(4).emit(0,0,0,0,1, Symbol())`.
            const before = snap(engine);
            assert.doesNotThrow(() => engine.emit(0, 0, 0, 0, 1, Symbol('df')));
            assertUntouched(engine, before);
        });
    });

    // -----------------------------------------------------------------------
    // Proxy with a throwing has/get trap, and a revoked Proxy. Premise:
    // `typeof` on ANY Proxy (including a revoked one) never invokes a trap and
    // never throws -- it is decided purely by whether the target is callable,
    // which is fixed at Proxy construction. So the typeof gate rejects every
    // Proxy used as x/y/vx/vy/life without ever touching a trap.
    // -----------------------------------------------------------------------
    describe('Proxy with throwing traps / revoked Proxy', () => {
        function throwingProxy() {
            return new Proxy({}, {
                get() { throw new Error('get trap fired'); },
                has() { throw new Error('has trap fired'); },
            });
        }

        it('premise: typeof does not invoke get/has and does not throw, even on a throwing-trap Proxy', () => {
            const p = throwingProxy();
            assert.doesNotThrow(() => { void (typeof p); });
            assert.equal(typeof p, 'object');
        });

        it('premise: typeof does not throw on a revoked Proxy', () => {
            const { proxy, revoke } = Proxy.revocable({}, {});
            revoke();
            assert.doesNotThrow(() => { void (typeof proxy); });
        });

        for (const lane of ['x', 'y', 'vx', 'vy']) {
            it('rejects a throwing-trap Proxy in lane ' + lane + ' without invoking any trap and without throwing', () => {
                const before = snap(engine);
                const p = throwingProxy();
                const args = { x: 0, y: 0, vx: 0, vy: 0, life: 1, dataFlag: 9 };
                args[lane] = p;
                assert.doesNotThrow(() => engine.emit(args.x, args.y, args.vx, args.vy, args.life, args.dataFlag));
                assertUntouched(engine, before);
            });
        }

        it('rejects a revoked Proxy in the x lane without throwing', () => {
            const before = snap(engine);
            const { proxy, revoke } = Proxy.revocable({}, {});
            revoke();
            assert.doesNotThrow(() => engine.emit(proxy, 0, 0, 0, 1, 9));
            assertUntouched(engine, before);
        });

        it('rejects a throwing-trap Proxy as life without throwing', () => {
            const before = snap(engine);
            assert.doesNotThrow(() => engine.emit(0, 0, 0, 0, throwingProxy()));
            assertUntouched(engine, before);
        });

        it('P-24: a throwing-trap Proxy as dataFlag is rejected WITHOUT throwing (typeof gates every argument, including dataFlag)', () => {
            // v1.0.4 threw here: with no typeof gate on dataFlag, `dataFlag | 0`
            // coerced via ToPrimitive, which consulted the get trap, and a Proxy
            // whose get trap throws propagated that throw out of emit(). The P-24
            // fix gives dataFlag the same typeof gate as the five lanes: `typeof`
            // on a Proxy never invokes a trap, so the object is rejected before
            // any coercion is attempted.
            const before = snap(engine);
            const p = throwingProxy();
            assert.doesNotThrow(() => engine.emit(0, 0, 0, 0, 1, p));
            assertUntouched(engine, before);
        });
    });

    // -----------------------------------------------------------------------
    // Hostile valueOf / Symbol.toPrimitive: throws, or returns a DIFFERENT
    // value on each call (the double-read / TOCTOU hazard the brief asks
    // about). Proven below: for x/y/vx/vy/life the typeof gate rejects the
    // object BEFORE any coercion is attempted, so valueOf/toPrimitive is
    // called ZERO times -- there is no "read during validation, different
    // value during write" window on those five lanes, because there is no
    // read at all.
    // -----------------------------------------------------------------------
    describe('hostile valueOf / Symbol.toPrimitive (double-read / TOCTOU)', () => {
        function hostileFlipFlop() {
            let calls = 0;
            const obj = {
                valueOf() { calls++; return calls === 1 ? 1 : 1e300; },
            };
            return { obj, getCalls: () => calls };
        }
        function hostileThrowing() {
            return { valueOf() { throw new Error('hostile valueOf'); } };
        }
        function hostileToPrimitiveFlipFlop() {
            let calls = 0;
            const obj = {
                [Symbol.toPrimitive](hint) { calls++; return calls === 1 ? 1 : 1e300; },
            };
            return { obj, getCalls: () => calls };
        }

        for (const lane of ['x', 'y', 'vx', 'vy']) {
            it('lane ' + lane + ': a flip-flopping valueOf is never invoked (0 calls) -- rejected by typeof before any read', () => {
                const before = snap(engine);
                const { obj, getCalls } = hostileFlipFlop();
                const args = { x: 0, y: 0, vx: 0, vy: 0, life: 1, dataFlag: 9 };
                args[lane] = obj;
                assert.doesNotThrow(() => engine.emit(args.x, args.y, args.vx, args.vy, args.life, args.dataFlag));
                assertUntouched(engine, before);
                assert.equal(getCalls(), 0, 'guard chain must not call valueOf at all for a non-number lane value (proves no double-read: nothing is read once, let alone twice)');
            });

            it('lane ' + lane + ': a throwing valueOf is never invoked and does not throw (typeof gate blocks it)', () => {
                const before = snap(engine);
                const args = { x: 0, y: 0, vx: 0, vy: 0, life: 1, dataFlag: 9 };
                args[lane] = hostileThrowing();
                assert.doesNotThrow(() => engine.emit(args.x, args.y, args.vx, args.vy, args.life, args.dataFlag));
                assertUntouched(engine, before);
            });

            it('lane ' + lane + ': a flip-flopping Symbol.toPrimitive is never invoked (0 calls)', () => {
                const before = snap(engine);
                const { obj, getCalls } = hostileToPrimitiveFlipFlop();
                const args = { x: 0, y: 0, vx: 0, vy: 0, life: 1, dataFlag: 9 };
                args[lane] = obj;
                assert.doesNotThrow(() => engine.emit(args.x, args.y, args.vx, args.vy, args.life, args.dataFlag));
                assertUntouched(engine, before);
                assert.equal(getCalls(), 0, 'guard chain must not call Symbol.toPrimitive at all');
            });
        }

        it('life: a flip-flopping valueOf is never invoked (0 calls)', () => {
            const before = snap(engine);
            const { obj, getCalls } = hostileFlipFlop();
            assert.doesNotThrow(() => engine.emit(0, 0, 0, 0, obj));
            assertUntouched(engine, before);
            assert.equal(getCalls(), 0);
        });

        it('life: a throwing valueOf is never invoked and does not throw', () => {
            const before = snap(engine);
            assert.doesNotThrow(() => engine.emit(0, 0, 0, 0, hostileThrowing()));
            assertUntouched(engine, before);
        });

        // Since P-24, dataFlag leads with the SAME typeof gate as the five lanes,
        // so it is no longer the one place a hostile object is read. The guarantee
        // is now uniform and stronger than QA expected: emit() does NOT call caller
        // code (valueOf / Symbol.toPrimitive) on ANY argument, because typeof
        // rejects every non-number before the coercing `|` (or a relational
        // operator) is ever reached. Zero reads means there is no double-read /
        // TOCTOU window to smuggle anything through -- the hazard is not mitigated,
        // it is structurally absent.
        it('dataFlag: a well-behaved valueOf is called ZERO times and the emit is rejected -- emit() invokes no caller code (P-24)', () => {
            const before = snap(engine);
            let calls = 0;
            const obj = { valueOf() { calls++; return 7; } }; // legal int32 value, still rejected: it is an object, not a number
            assert.doesNotThrow(() => engine.emit(0, 0, 0, 0, 1, obj));
            assertUntouched(engine, before);
            assert.equal(calls, 0, 'the dataFlag typeof gate rejects the object before `|` runs, so valueOf is never read');
        });

        it('dataFlag: a flip-flopping valueOf is never read (0 calls), so there is no double-read hazard to smuggle through (P-24)', () => {
            // The typeof gate rejects the object before `dataFlag | 0` runs, so
            // valueOf is never invoked -- not once, not twice. With zero reads the
            // TOCTOU question is moot: whatever the object would have returned on a
            // first or second read is never observed by emit() at all.
            const before = snap(engine);
            let calls = 0;
            const obj = { valueOf() { calls++; return calls === 1 ? 5 : -0x7fffffff; } };
            assert.doesNotThrow(() => engine.emit(0, 0, 0, 0, 1, obj));
            assertUntouched(engine, before);
            assert.equal(calls, 0, 'emit() reads no caller code on dataFlag; the strict guard never coerces the object');
        });
    });

    // -----------------------------------------------------------------------
    // Boxed Number (`new Number(5)`) -- a classic typeof gotcha distinct from
    // the coercion corpus already covered (numeric strings/booleans/arrays):
    // `new Number(5) == 5` but `typeof new Number(5) === 'object'`.
    // -----------------------------------------------------------------------
    describe('boxed Number (new Number(5))', () => {
        for (const lane of ['x', 'y', 'vx', 'vy']) {
            it('rejects a boxed Number in lane ' + lane + ' (typeof is "object", not "number")', () => {
                const before = snap(engine);
                assert.equal(typeof new Number(5), 'object', 'premise: boxed Number is typeof object');
                const args = { x: 0, y: 0, vx: 0, vy: 0, life: 1, dataFlag: 9 };
                args[lane] = new Number(5);
                assert.doesNotThrow(() => engine.emit(args.x, args.y, args.vx, args.vy, args.life, args.dataFlag));
                assertUntouched(engine, before);
            });
        }

        it('rejects a boxed Number as life', () => {
            const before = snap(engine);
            assert.doesNotThrow(() => engine.emit(0, 0, 0, 0, new Number(1)));
            assertUntouched(engine, before);
        });
    });

    // -----------------------------------------------------------------------
    // document.all-style falsy exotic object: not reachable in this package's
    // runtime target (Node, no DOM), recorded as N/A with the check that
    // proves it, rather than silently skipped.
    // -----------------------------------------------------------------------
    describe('document.all-style falsy exotic', () => {
        it('N/A: `document` is not defined in this Node runtime, so the exotic is unreachable', () => {
            assert.equal(typeof globalThis.document, 'undefined',
                'this package targets Node; document.all is a DOM/browser-only exotic and cannot reach emit() here');
        });
    });

    // -----------------------------------------------------------------------
    // Adversarial case the planner brief did not enumerate: Number.MAX_VALUE
    // (1.7976931348623157e+308), the actual f64 ceiling -- not merely "a big
    // round literal" like 1e300, and its negative. Also -Number.MIN_VALUE
    // (the most extreme legal SUBNORMAL, -5e-324) as a companion no-floor
    // check at the opposite extreme from MAX_VALUE.
    // -----------------------------------------------------------------------
    describe('adversarial: Number.MAX_VALUE / Number.MIN_VALUE (not in the planner brief)', () => {
        it('premise: Number.MAX_VALUE frounds to Infinity (genuinely unstorable in an f32 lane)', () => {
            assert.ok(!Number.isFinite(Math.fround(Number.MAX_VALUE)));
            assert.ok(!Number.isFinite(Math.fround(-Number.MAX_VALUE)));
        });

        for (const lane of ['x', 'y', 'vx', 'vy']) {
            it('rejects Number.MAX_VALUE in lane ' + lane, () => {
                const before = snap(engine);
                const args = { x: 0, y: 0, vx: 0, vy: 0, life: 1, dataFlag: 9 };
                args[lane] = Number.MAX_VALUE;
                engine.emit(args.x, args.y, args.vx, args.vy, args.life, args.dataFlag);
                assertUntouched(engine, before);
            });

            it('rejects -Number.MAX_VALUE in lane ' + lane, () => {
                const before = snap(engine);
                const args = { x: 0, y: 0, vx: 0, vy: 0, life: 1, dataFlag: 9 };
                args[lane] = -Number.MAX_VALUE;
                engine.emit(args.x, args.y, args.vx, args.vy, args.life, args.dataFlag);
                assertUntouched(engine, before);
            });

            it('accepts -Number.MIN_VALUE (smallest negative subnormal) in lane ' + lane + ' -- the band has no floor', () => {
                const e = new SoaParticleEngine(4);
                const args = { x: 0, y: 0, vx: 0, vy: 0, life: 1, dataFlag: 9 };
                args[lane] = -Number.MIN_VALUE;
                e.emit(args.x, args.y, args.vx, args.vy, args.life, args.dataFlag);
                assert.equal(e._head, 1, '-Number.MIN_VALUE must be accepted');
                e.destroy();
            });
        }
    });
});

describe('QA S2.1: t9 torture controls cannot leak into node --test', () => {
    it('this file never imports test/torture/*.mjs, so SoaParticleEngine.prototype.emit cannot be reassigned by SOA_TORTURE_* controls during `npm test`', () => {
        // Structural guarantee, not a runtime one: the whole torture/ directory
        // (including t9-controls.mjs, which is the only file that reassigns
        // the prototype) is reachable only from test/torture.mjs, which `npm
        // test` (`node --test test/*.test.js`) never imports (the glob matches
        // only test/*.test.js, not test/torture.mjs or test/torture/*.mjs).
        const before = SoaParticleEngine.prototype.emit;
        const e = new SoaParticleEngine(2);
        e.emit(1, 1, 1, 1, 1);
        assert.equal(SoaParticleEngine.prototype.emit, before, 'prototype.emit must be the shipped implementation throughout node --test');
        e.destroy();
    });
});
