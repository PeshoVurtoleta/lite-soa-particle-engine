/**
 * @zakkster/lite-soa-particle-engine -- Zero-GC Canvas Particle System
 *
 * Uses Structure of Arrays (SoA) to maintain particles in flat TypedArrays.
 * CPU cache-friendly: iterating a Float32Array keeps the data contiguous in
 * memory, so the prefetcher streams it -- unlike an array of objects, whose
 * fields are scattered across the heap.
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

export const VERSION = '1.2.0';

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
 * The symmetric f32 lane band for x/y/vx/vy: an emit is rejected unless each of
 * those four values lies in [-LANE_MAX, LANE_MAX]. LANE_MAX is the largest f64
 * that Math.fround maps to a finite f32; the next value up,
 * 3.4028235677973366e+38, stores as f32 Infinity. MEASURED by bisection on
 * Number.isFinite(Math.fround(m)); the negative side is exactly symmetric.
 *
 * The bound comes from Float32Array, not from any physical quantity, so it is
 * identical for all four lanes -- one LANE_MAX, not a POS_MAX/VEL_MAX pair. It is
 * numerically EQUAL to LIFE_MAX by coincidence of the storage type, not by shared
 * contract, and is declared independently so widening one never silently widens
 * the other. Unlike the `life` band this one is symmetric and has NO floor: 0,
 * -0, negatives and subnormals are all legal coordinates. See the S2.1 amendment
 * in decisions/0002-the-door.md.
 */
export const LANE_MAX = 3.4028235677973362e+38;

/**
 * The default RNG for emitBurst: a frozen module singleton created ONCE at load,
 * so the hot path never builds it and never branches on a default parameter that
 * re-evaluates (decisions/0004-the-spawn-path.md D1). It is the ONLY site in this
 * file that reads the platform pseudo-random source; every hot path takes `rng`
 * as an argument. `rng === undefined ? DEFAULT_RNG : rng` resolves once, above
 * emitBurst's loop, into a local. The one-method `.next()` contract is exactly
 * lite-random's `Random.prototype.next`, so a Random instance is passed directly.
 */
const DEFAULT_RNG = Object.freeze({ next: Math.random });

/**
 * Read once, above emitBurst's loop, for a spec of null/undefined/a primitive:
 * property reads off it yield undefined, so every field takes its default without
 * throwing (decisions/0004-the-spawn-path.md D3). Frozen; never mutated.
 */
const EMPTY_SPEC = Object.freeze({});

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
 *     and for any options.maxDt that is not a number > 0 (Infinity IS admitted,
 *     to disable clamping for a fixed-step caller -- S3 amendment to 0002). It
 *     validates before allocating, so "Invalid typed array length" never escapes.
 *   - emit() NEVER throws (it is per-frame, per-particle; a throw is a render-loop
 *     crash). It silently rejects, before touching any lane, any emit whose
 *     x/y/vx/vy fall outside the symmetric f32 band [-LANE_MAX, LANE_MAX]
 *     (which also rejects NaN and both infinities), whose `life` is outside
 *     [LIFE_MIN, LIFE_MAX] (which also rejects NaN, both infinities, 0 and
 *     negatives), or whose dataFlag is not an exact int32. A rejected emit
 *     leaves the engine byte-identical and does not advance _head.
 *   - emitBurst() is emit()'s never-throws-for-a-bad-value door over a whole
 *     cone (S3.1, decisions/0004-the-spawn-path.md): x/y/count/spec are
 *     typeof-first validated ONCE per burst, and a once-per-burst envelope bounds
 *     every drawn value into the lane/life bands. Every particle draws EXACTLY 3
 *     rng values in the ORDER angle, speed, life. Returns -1 on a door rejection
 *     (zero drawn, zero written) or exactly `count` on an accepted burst. It
 *     throws only on caller CODE, which propagates: a throwing rng.next(), a
 *     throwing accessor getter on a spec field, or a throwing accessor getter on
 *     rng.next.
 *   - A frame gap larger than maxDt is CLAMPED to maxDt: a clamped frame LOSES
 *     time by design (the alternative is particles tunnelling). This engine is
 *     therefore NOT a fixed-step simulator. A caller needing a fixed-step
 *     accumulator drives tick(dt) themselves and sets maxDt: Infinity to
 *     disable the clamp (S3).
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
     *   be a number > 0 or the constructor throws; Infinity is admitted and
     *   disables the clamp (for a fixed-step caller driving tick(dt) directly).
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
            // typeof m === 'number' already established above. `m > 0` rejects
            // NaN (NaN > 0 is false), 0 and every negative, and ADMITS Infinity
            // (S3 amendment to decisions/0002-the-door.md): a fixed-step caller
            // sets maxDt: Infinity to disable clamping, and `dt > Infinity` is
            // never true, so the tick() clamp becomes a documented no-op.
            if (!(m > 0)) {
                throw new RangeError(
                    'SoaParticleEngine: options.maxDt must be a number > 0, got ' + m);
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
     * @param {number} x        X position. Must lie in the symmetric f32 band
     *   [-LANE_MAX, LANE_MAX]; out-of-band (including NaN and both infinities) is
     *   silently rejected. 0, -0, negatives and subnormals are all accepted.
     * @param {number} y        Y position. Same band as x.
     * @param {number} vx       X velocity. Same band as x.
     * @param {number} vy       Y velocity. Same band as x.
     * @param {number} life     Lifetime in seconds. Must lie in the legal band
     *   [LIFE_MIN, LIFE_MAX]; out-of-band life (including NaN, both infinities, 0
     *   and negatives, and lifetimes so small their invLife would overflow to
     *   Infinity) is silently rejected.
     * @param {number} [dataFlag=0] Recipe ID or custom flag. Must be a number that
     *   is an exact int32 (typeof number and (dataFlag | 0) === dataFlag); a
     *   fractional, out-of-range, non-numeric, or NaN flag is rejected. A hostile
     *   BigInt, Symbol, or object with a throwing valueOf / Symbol.toPrimitive is
     *   also rejected WITHOUT throwing, because the guard leads with typeof (P-24).
     *   0 is the default and a legal id.
     * @returns {number} The slot index written, in [0, max), on success; -1 on
     *   every rejection path (any lane out of band, a non-int32 dataFlag, or a
     *   destroyed engine). The index is a RECEIPT, not an identity (D4): it is
     *   valid until that slot is reused, and after S4 until the next compaction.
     */
    emit(x, y, vx, vy, life, dataFlag = 0) {
        if (this._destroyed) return -1;

        // x/y/vx/vy share the symmetric f32 lane band [-LANE_MAX, LANE_MAX]. Each
        // guard has TWO non-optional halves inside ONE negation: the range half
        // (>= -LANE_MAX && <= LANE_MAX) rejects NaN and both infinities on its own
        // (every comparison against them is false), and the typeof half rejects
        // non-numbers. Both are required -- relational operators COERCE (null -> 0,
        // "5" -> 5, [7] -> 7, true -> 1), so without typeof a string or boolean is
        // laundered into a coordinate, the P-06/P-23 class this door exists to
        // close. typeof is a call-free V8 type check, cheaper than Number.isFinite
        // and not a builtin call. The band has NO floor: 0, -0, negatives and
        // subnormals are all legal coordinates.
        if (!(typeof x  === 'number' && x  >= -LANE_MAX && x  <= LANE_MAX)) return -1;
        if (!(typeof y  === 'number' && y  >= -LANE_MAX && y  <= LANE_MAX)) return -1;
        if (!(typeof vx === 'number' && vx >= -LANE_MAX && vx <= LANE_MAX)) return -1;
        if (!(typeof vy === 'number' && vy >= -LANE_MAX && vy <= LANE_MAX)) return -1;
        // The life band, same two-half predicate: the range half also rejects NaN,
        // both infinities, 0 and negatives; the typeof half rejects coerced
        // non-numbers ("1", true, [1]) that v1.0.4 laundered into life (P-23).
        if (!(typeof life === 'number' && life >= LIFE_MIN && life <= LIFE_MAX)) return -1;
        // dataFlag, same typeof-first predicate (P-24). `|` invokes ToNumeric,
        // which THROWS for BigInt/Symbol and RUNS caller code (valueOf,
        // Symbol.toPrimitive) for objects -- so `(dataFlag | 0)` on an unvalidated
        // argument makes emit() throw, breaking its never-throws contract. typeof
        // never calls user code and never throws, so `|` is reached only once
        // dataFlag is known to be a primitive number. (d | 0) === d is then the
        // exact-int32 test: it rejects fractions and out-of-int32-range values.
        if (!(typeof dataFlag === 'number' && (dataFlag | 0) === dataFlag)) return -1;

        const i = this._head;

        this.x[i]       = x;
        this.y[i]       = y;
        this.vx[i]      = vx;
        this.vy[i]      = vy;
        this.life[i]    = life;
        this.invLife[i]  = 1.0 / life;
        this.data[i]    = dataFlag;

        this._head = (i + 1) % this.max;

        // Receipt, not identity (D4): the slot just written. Valid until that
        // slot is reused (and after S4 until the next compaction). -1 is the one
        // rejection value, returned on every early-return above.
        return i;
    }

    /**
     * Emit a cone of `count` particles from (x, y), the randomness supplied as an
     * argument so the spawn is replayable (decisions/0004-the-spawn-path.md).
     *
     * HOT path. Never throws for a bad-VALUE argument: x, y, count and every spec
     * field pass the same typeof-first door as emit(), validated ONCE per burst
     * (D4). typeof-first defends against coercion (a Symbol, BigInt or throwing
     * valueOf spec field is rejected with -1), but it cannot precede a property
     * READ, so caller CODE propagates: a throwing rng.next(), or a throwing
     * accessor getter on a spec field or on rng.next. Swallowing any of these
     * would turn a caller bug into a silently half-written burst; particles
     * stored before the throw remain and _head has
     * advanced by exactly that many.
     *
     * Draw law (D2, NORMATIVE): every particle in an accepted burst consumes
     * EXACTLY 3 rng.next() draws in the ORDER angle, speed, life, unconditionally
     * -- not conditionally on the matching *Var, not on the store being accepted.
     * The stream is independent of ring occupancy, which is what makes a replay
     * survive a full pool. A door-rejected burst draws ZERO.
     *
     * Return (D4 as amended by R4): -1 when the burst is rejected at the door
     * (nothing drawn, nothing written); otherwise the count of particles stored,
     * which for an accepted burst is EXACTLY `count`. The once-per-burst envelope
     * check below bounds every drawn value into the lane/life bands, so every
     * individual store succeeds and there is no 0..count range.
     *
     * @param {number} x     Burst origin X. Same band as emit(): [-LANE_MAX, LANE_MAX].
     * @param {number} y     Burst origin Y. Same band as x.
     * @param {number} count Positive integer count of particles. 0, negatives,
     *   fractions, NaN, Infinity and non-numbers are door rejections (R5).
     * @param {object} [spec] Cone spec, read once per field (D3):
     *   { speed=100, speedVar=0, angle=0, angleVar=Math.PI, life=1, lifeVar=0,
     *     data=0 }. A missing field takes its default; null/undefined/a primitive
     *     read as all-defaults. Each field is typeof-validated; the whole burst is
     *     rejected unless |speed|+|speedVar| <= LANE_MAX, angle/angleVar are in the
     *     lane band, and life +/- lifeVar lie in [LIFE_MIN, LIFE_MAX].
     * @param {{ next: () => number }} [rng] RNG with a single .next() -> [0,1)
     *   method (lite-random's Random satisfies it directly). Defaults to the
     *   module singleton. A bare function is rejected (D1).
     * @returns {number} -1 on a door rejection; otherwise the count stored
     *   (exactly `count` for an accepted burst).
     */
    emitBurst(x, y, count, spec, rng) {
        if (this._destroyed) return -1;

        // Resolve the RNG once, above the loop -- no default parameter that
        // re-evaluates, no branch inside the loop (D1). undefined -> the singleton.
        const r = rng === undefined ? DEFAULT_RNG : rng;

        // Door, validated ONCE per burst before any draw (D4/R11). x/y reuse the
        // position lane band; count is a positive integer; rng is an object with a
        // .next() function (a bare function fails the object half and is rejected).
        if (!(typeof x === 'number' && x >= -LANE_MAX && x <= LANE_MAX)) return -1;
        if (!(typeof y === 'number' && y >= -LANE_MAX && y <= LANE_MAX)) return -1;
        if (!(typeof count === 'number' && count >= 1 && (count | 0) === count)) return -1;
        if (!(r !== null && typeof r === 'object' && typeof r.next === 'function')) return -1;

        // spec -> locals, each raw field read EXACTLY ONCE (D3), then defaulted.
        // A null/undefined/primitive spec reads as all-defaults via EMPTY_SPEC.
        const useSpec = (spec === null || spec === undefined) ? EMPTY_SPEC : spec;
        const rSpeed = useSpec.speed, rSpeedVar = useSpec.speedVar,
              rAngle = useSpec.angle, rAngleVar = useSpec.angleVar,
              rLife = useSpec.life, rLifeVar = useSpec.lifeVar, rData = useSpec.data;
        const speed    = rSpeed    === undefined ? 100     : rSpeed;
        const speedVar = rSpeedVar === undefined ? 0       : rSpeedVar;
        const angle    = rAngle    === undefined ? 0       : rAngle;
        const angleVar = rAngleVar === undefined ? Math.PI : rAngleVar;
        const life     = rLife     === undefined ? 1       : rLife;
        const lifeVar  = rLifeVar  === undefined ? 0       : rLifeVar;
        const data     = rData     === undefined ? 0       : rData;

        // typeof-first (D4): reject any non-number spec field WITHOUT throwing, so
        // a Symbol / BigInt / hostile valueOf never reaches Math.abs below. data
        // must also be an exact int32, emit()'s dataFlag contract.
        if (!(typeof speed === 'number' && typeof speedVar === 'number' &&
              typeof angle === 'number' && typeof angleVar === 'number' &&
              typeof life  === 'number' && typeof lifeVar  === 'number' &&
              typeof data  === 'number' && (data | 0) === data)) return -1;

        // Envelope, checked ONCE (R4). It bounds every value the loop can draw
        // into the lane/life bands, so every per-particle store SUCCEEDS and the
        // return collapses to exactly `count`. angle/angleVar in band keep every
        // drawn `a` finite; |speed|+|speedVar| bounds |s|; life +/- lifeVar keeps
        // every drawn life in its band. Each predicate also rejects NaN for free.
        if (!(angle    >= -LANE_MAX && angle    <= LANE_MAX)) return -1;
        if (!(angleVar >= -LANE_MAX && angleVar <= LANE_MAX)) return -1;
        if (!(Math.abs(speed) + Math.abs(speedVar) <= LANE_MAX)) return -1;
        const loLife = life - lifeVar, hiLife = life + lifeVar;
        if (!(loLife >= LIFE_MIN && loLife <= LIFE_MAX &&
              hiLife >= LIFE_MIN && hiLife <= LIFE_MAX)) return -1;

        // Hot loop. Draw angle, speed, life (D2 order), then store through the
        // guarded emit(). Zero allocation: primitives only, no object literals, no
        // bind, no spread. n counts actual stores -- honest, and it collapses to
        // count under the envelope above; without the envelope it drops below and
        // the R4 collapse law bites.
        let n = 0;
        for (let k = 0; k < count; k++) {
            const a = angle + (r.next() * 2 - 1) * angleVar;
            const s = speed + (r.next() * 2 - 1) * speedVar;
            const l = life  + (r.next() * 2 - 1) * lifeVar;
            if (this.emit(x, y, Math.cos(a) * s, Math.sin(a) * s, l, data) !== -1) n++;
        }
        return n;
    }

    /**
     * Register the tick callback. Called every frame (or every tick()) with raw
     * arrays. COLD path: called once at setup, so it throws at the door (D6),
     * unlike the per-frame emit()/tick() which silently reject.
     *
     * @param {Function|null|undefined} callback (dt, x, y, vx, vy, life, invLife,
     *   data, max) -- a function registers; null or undefined UNREGISTER and
     *   return normally. Anything else throws a named TypeError (P-27): a
     *   non-callable stored here would crash the frame path the next time the
     *   loop invokes it, the exact failure emit()'s never-throws contract exists
     *   to prevent. `null` is stored (never `undefined`) so tick()/_loop test
     *   `=== null` rather than truthiness -- truthiness is what let `42` through.
     *   dt: seconds since last frame; x..data: the raw TypedArrays -- mutate them
     *   directly; max: array length.
     */
    onTick(callback) {
        if (callback === null || callback === undefined) {
            this._onTick = null;
            return;
        }
        if (typeof callback !== 'function') {
            throw new TypeError(
                'SoaParticleEngine: onTick(callback) requires a function, null or ' +
                'undefined, got ' + typeof callback + ' ' + _showArg(callback));
        }
        this._onTick = callback;
    }

    /**
     * Advance the simulation by `dt` seconds, invoking the registered callback
     * once. This is the PRIMARY stepping API (S3): a host game loop, a fixed-step
     * accumulator, lite-scheduler or a worker calls tick(dt) directly, with no
     * DOM required. start()/stop() are thin RAF wrappers that call it.
     *
     * HOT path. Never throws (like emit(), it runs per frame; a throw is a
     * render-loop crash). Type before value, one negation: the `dt >= 0` half
     * rejects NaN for free -- exactly as the lane bands do -- and the typeof half
     * rejects coerced non-numbers ('0.05', null, [7], true) and the throwing
     * P-24 corpus (BigInt/Symbol/hostile valueOf) that a bare relational operator
     * on `dt` would launder or throw on. -0 passes and is harmless.
     *
     * dt is CLAMPED to maxDt on the high side (the shipped S2 contract; a clamped
     * frame loses time by design) but REJECTED, never clamped, on the low side:
     * clamping -1 to 0 would silently change what the caller asked for.
     *
     * @param {number} dt Seconds to advance. Must be a number >= 0; anything else
     *   (negative, NaN, non-number) is silently rejected.
     * @returns {boolean} true iff the callback ran; false on a rejected dt, no
     *   registered callback, or a destroyed engine.
     */
    tick(dt) {
        if (this._destroyed) return false;
        if (!(typeof dt === 'number' && dt >= 0)) return false;
        if (dt > this.maxDt) dt = this.maxDt;
        if (this._onTick === null) return false;
        this._onTick(
            dt,
            this.x, this.y, this.vx, this.vy,
            this.life, this.invLife, this.data,
            this.max
        );
        return true;
    }

    /**
     * Start the RAF loop. COLD path. Validates the environment BEFORE mutating
     * any state (D2): with no `requestAnimationFrame` global it throws a named
     * library error and leaves _isRunning and _lastTime UNTOUCHED, so a caller
     * who installs a polyfill and retries gets a working engine. Detection is
     * `typeof requestAnimationFrame !== 'function'` -- typeof on an undeclared
     * identifier does not throw, which is why it is the test and not a
     * try/catch around the call. P-28: today that retry is a silent no-op
     * forever, because start() set _isRunning = true before the ReferenceError.
     */
    start() {
        if (this._isRunning || this._destroyed) return;
        if (typeof requestAnimationFrame !== 'function') {
            throw new TypeError(
                'SoaParticleEngine: start() requires requestAnimationFrame; none ' +
                'is defined in this environment. Drive tick(dt) directly instead, ' +
                'or install a requestAnimationFrame polyfill before calling start().');
        }
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

    /**
     * @private
     * The RAF driver: read the clock, compute dt, delegate the clamp + callback
     * to tick(). It does NOT clamp or invoke the callback itself -- maxDt lives
     * in exactly one place (tick), and this method lives in zero of them.
     */
    _loop(time) {
        if (!this._isRunning || this._destroyed) return;

        // The clock is environment input, not the engine's (D8). `time >=
        // _lastTime` rejects NaN and a backwards clock in one comparison, and it
        // guarantees dt >= 0, so tick()'s own low-side guard can never reject a
        // value _loop produced -- the two guards compose instead of duplicating.
        // Crucially _lastTime is NOT advanced on a bad reading: a transient bad
        // sample self-heals on the next good one, instead of poisoning _lastTime
        // to NaN and killing the engine silently and permanently (P-28's shape
        // through the clock door).
        if (typeof time === 'number' && time >= this._lastTime) {
            const dt = (time - this._lastTime) / 1000;
            this._lastTime = time;
            this.tick(dt);
        }

        // Re-arm only while still running and not destroyed (D7, P-26): a
        // callback that called destroy()/stop() must not leave an orphaned frame
        // pending on a torn-down engine.
        if (this._isRunning && !this._destroyed) {
            this._rafId = requestAnimationFrame(this._loop);
        }
    }
}

export default SoaParticleEngine;
