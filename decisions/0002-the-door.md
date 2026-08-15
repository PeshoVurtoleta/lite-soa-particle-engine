# 0002 -- the door: what this engine refuses to accept

- **Status:** accepted
- **Date:** 2026-08-15
- **Session:** S2 (v1.0.4)
- **Findings:** P-02, P-03, P-04, P-05, P-06, P-13, P-14, P-17, P-18.

## Context

v1.0.3 validates nothing at any entry point. Seven of the roadmap findings are the
same bug in seven costumes: a value that cannot possibly be correct is accepted,
written into a lane, and surfaces much later as an invisible particle, a NaN
alpha, or an engine that accepts emits forever and stores nothing.

```
new SoaParticleEngine(2.5)      -> max 2.5, lanes of length 2
new SoaParticleEngine(0).emit() -> _head becomes NaN, permanently
emit(..., life = 1e-46)         -> life 0, invLife Infinity, alpha NaN
a 101 ms frame                  -> reported to the caller as a 16 ms frame
```

Fixing these one at a time means writing the same "is this a usable number"
predicate seven times and shipping five patch releases whose combined diff is
thirty lines. They share one policy question, decided here.

Everything downstream waits on this. S4's managed mode removes the per-slot life
gate; removing a gate from a lane that accepts NaN is how a silent bug becomes a
permanent one.

## Options considered

- **A. Throw at the door (chosen).** The constructor throws a named library error
  for every argument that is not a valid positive integer within a documented
  ceiling. `emit()` keeps returning silently for bad numbers -- it is per-frame
  and per-particle, and a throw there is a crash in a render loop -- but the
  definition of "bad" widens to the measured f32 band. Cost: a constructor throw
  where v1.0.3 constructed, which is technically breaking for callers passing
  garbage, i.e. callers who are already broken and do not know it. Gain: P-03 and
  P-04 both die at once, because a validated `max` makes `(i + 1) % max` unable to
  produce NaN.
- **B. Clamp and continue.** Coerce `max` to a sane integer, coerce `life` up to
  the precision floor. Rejected on law 4 (fail closed): silently changing what the
  caller asked for is the exact failure mode this package already has.
- **C. Checked mode behind an option.** Validation only under
  `new SoaParticleEngine(n, { checked: true })`. Rejected: the default
  configuration keeps every bug, and the constructor is a cold path -- there is no
  performance argument for hiding its validation behind a flag.

## Decision

**Option A**, with the four sub-policies below.

### 1. Constructor -- throw, naming the argument and the constraint

`maxParticles` must satisfy `Number.isInteger(n) && n >= 1 && n <= MAX_PARTICLES`.
Anything else throws a library error whose message names the package, the
argument, the constraint, and the received value -- never the bare
`RangeError: Invalid typed array length` the allocator produces for `-1` and
`Infinity`.

```
TypeError  when the value is not of type number  ('10', null, {}, true)
RangeError when it is a number outside the legal set (NaN, 2.5, 0, -1, Infinity,
           anything > MAX_PARTICLES)
```

`maxDt` (new option, below) is validated the same way: a finite number > 0, or
throw.

Neither error is a new class. A subclassed error would be a public API surface
this package does not want to maintain; the message prefix is what makes it
identifiable.

### 2. `dataFlag` -- validate at the door, reject otherwise

The current state -- `3.7 -> 3`, `2**31 -> -2147483648`, `NaN -> 0`, `'x' -> 0`,
`null -> 0`, all silent -- is not a policy, it is whatever `Int32Array` happened
to do. The alternative considered was reserving a sentinel so "no recipe" is
distinguishable from recipe 0; rejected because it steals a legal recipe id to
solve a problem the caller can solve by not calling `emit` for a particle it has
no recipe for.

The predicate is one comparison:

```js
if ((dataFlag | 0) !== dataFlag) return;
```

`(d | 0) === d` is true only for numbers already exactly representable as int32,
so it subsumes `Number.isInteger` and rejects strings, `null`, `NaN`, fractions,
and out-of-int32-range values in a single test. `0` remains the default and is a
legal recipe id.

### 3. `clear()` -- stays life-only, and the contract says so in writing

`clear()` zeroes `life` and resets the write cursor. It does NOT touch
`x/y/vx/vy/data`. The alternative -- seven fills instead of one -- was rejected
because the six other lanes are meaningless for a dead slot: no correct consumer
reads them, since the documented liveness test is `life[i] <= 0`.

The contract therefore states: **for a slot with `life[i] <= 0`, the values in
`x, y, vx, vy, invLife, data` are undefined.** S4's managed mode is responsible
for its own slot hygiene and must not assume `clear()` did it.

This is recorded now, before S4 needs it, because S4 is where a wrong answer here
becomes visible rather than merely wasteful.

### 4. Lane reassignment -- documented, not frozen

`destroy()` reassigns every lane to `null`, so `Object.freeze(this)` would break
`destroy()`. The lanes stay mutable properties and the contract states they are
**reassigned only by `destroy()`, and never by any other method**. Sealing the
instance and reworking `destroy()` is deferred to S5, where P-11 revisits the
destroyed-state contract as a whole.

## MAX_PARTICLES = 2 ** 24 = 16777216

A policy number, not a probe of what happens to allocate, and proven by a
falsifiable gate rather than asserted: `npm run bench:ceiling`
(`test/bench-ceiling.mjs`), in the role `test/bench-soa.mjs` plays for
lite-particles `decisions/0010`. Measured 2026-08-15, Apple M4 Pro, node v26.3.1.

```
C1 constructs                            CONSTRUCTED
C2 all 7 lanes written AND read back     readbackOk = true
C3 RSS within 25% of analytic 448.0 MB   measured 456.4 MB
C4 construct + touch <= 5000 ms          229 ms
C5 >= 128x below the abort threshold     abort at 2**33, margin 512x
C6 no catchable-failure band             sizes go straight from constructing
                                         to aborting
C7 fits a 512 MB portability budget      2**25 would need 896 MB
C8 shipped ctor enforces this ceiling    MAX_PARTICLES == candidate, accepts
                                         n, rejects n+1 with a branded error
```

**C8 and the circularity it repairs, added after S2 landed.** The sweep
originally allocated through `new SoaParticleEngine(n)`. That was harmless while
the constructor validated nothing, and became circular the moment this session's
door shipped: every oversized row started "failing politely" because of the very
cap the sweep exists to justify. C6 inverted -- it reported a catchable-failure
band belonging to the library rather than to V8 -- and C5 stopped observing any
abort at all and passed vacuously, because `Infinity / CANDIDATE >= 128` is
trivially true. Both were fixed: the sweep now allocates the seven lanes RAW, so
C1..C7 measure the allocator as intended, C5 fails outright when no abort is
observed, and C8 is the single criterion that looks at the library -- so the
shipped cap cannot drift away from the evidence in this file without a run
turning red. Verified: `CEILING_CANDIDATE=2**25` and `2**20` both fail C8 with
`-- DRIFT`.

**C6 is the load-bearing criterion.** There is no size at which the allocator
fails politely: `2**33` does not throw, it kills the process with
`Check failed: change_in_bytes < kMaxReasonableBytes`, exit 133, uncatchable. A
`try/catch` around the constructor cannot save a caller. Validation is therefore
the only thing standing between a caller's typo and a dead process, which is what
makes the constructor throw non-negotiable rather than merely tidy.

**C7 is what picks between working sizes.** `2**25` and `2**26` are both entirely
usable on the 24 GB machine this was measured on. A ceiling that ships because the
developer's workstation could hold it is an accident of hardware, not a decision;
C7 forces the choice against a stated budget instead.

The gate rejects wrong candidates in BOTH directions -- verified, not assumed:

```
CEILING_CANDIDATE=2**25  -> FAIL C7 (896 MB, over budget)
CEILING_CANDIDATE=2**30  -> FAIL C2, C3, C5, C7
CEILING_CANDIDATE=2**33  -> FAIL C1 (aborts), C3, C4, C5
CEILING_CANDIDATE=2**20  -> FAIL C7 ("ALSO FITS -- ceiling is too low")
```

Also measured, and the reason a successful constructor proves nothing: `2**30`
constructs in 6.5 ms with an RSS delta of **1.0 MB** against an analytic 28672 MB.
The lanes are lazily faulted address space, not memory. A constructor that
returned is not evidence of an engine that works.

2**24 is 16.7M particles -- two orders of magnitude above this package's stated
10K-100K target -- at 470 MB across seven lanes.

## The legal `life` band (P-05 low end, P-17 high end)

Both ends measured, not derived. Every number below came out of an execution.

```
LIFE_MIN = 2.938735964636876e-39     smallest life whose f32 invLife is finite
                                     (its invLife is 3.4028234663852886e+38,
                                     exactly f32 max)
   below it: 2.9387359646368754e-39  -> invLife f32 = Infinity

LIFE_MAX = 3.4028235677973362e+38    largest life that stores as a finite f32
   above it: 3.4028235677973366e+38  -> life f32 = Infinity
```

**The trap, recorded so no future session "simplifies" it back:** the analytic
guess `1 / F32MAX` is `2.938736052218037e-39`, which is *larger* than the measured
`LIFE_MIN`. Using it as the threshold silently rejects the band
`[2.938735964636876e-39, 2.938736052218037e-39)` -- lifetimes that are perfectly
legal and produce a finite `invLife`. Do not write `1 / 3.4028234663852886e38`.
Paste the measured literal, or derive it by search at module load; either way it
is a module-level `const`, never a per-emit computation.

### The band replaces the old check -- it does not add to it

```js
if (!(life >= LIFE_MIN && life <= LIFE_MAX)) return;
```

Written with the negation outside, this single range test also rejects `NaN` (all
comparisons against NaN are false), both infinities, `0`, and every negative --
so it **replaces** `!Number.isFinite(life) || life <= 0` rather than sitting
beside it. Net branch count in `emit()` for P-05 + P-17: unchanged.

### alpha tolerance

Both `life` and `invLife` are f32 lanes, so `fround(life) * fround(1 / life)`
differs from 1 by up to one f32 ulp at birth. Measured worst case over 200k
log-uniform samples across the legal band:

```
worst |alpha - 1| = 2.310343916178681e-7  at life = 3.256154474696478e-39
bound to assert   = 2 ** -22 = 2.384185791015625e-7
```

`2 ** -23` (`1.1920928955078125e-7`) is BELOW the measured worst case and would
fail the suite on legal input. The worst case sits inside the subnormal region,
where f32 precision degrades.

## P-02 -- the dt clamp that was not a clamp

`if (dt > 0.1) dt = 0.016;` does not clamp, it *fabricates*. A 101 ms frame and a
5000 ms frame are both reported to the caller as 16 ms. Replaced with a real
clamp and a constructor option:

```js
if (dt > this.maxDt) dt = this.maxDt;     // maxDt default 0.1
```

**A clamped frame loses time by design.** That is the correct behaviour for a
render loop -- the alternative is a physics step so large that particles tunnel --
but it means this engine is not a fixed-step simulator and must not be described
as one. A caller who needs an accumulator drives `tick(dt)` themselves; that entry
point lands in S3.

Note the clamp deliberately does not touch negative or NaN `dt`. A NaN timestamp
still yields NaN dt (`NaN > maxDt` is false), which is the caller's clock being
broken, and is out of scope for this session.

## Hot path budget

`emit()` gains exactly **one** comparison net: the `dataFlag` int32 test. The
`life` band test replaces two checks with one. Everything else lands in the
constructor, which is cold and runs once.

Measured with `npm run bench:emit` (`test/bench-emit.mjs`), which reports its own
resolution limit R and refuses to publish a delta it cannot resolve. The
before/after numbers and that run's R are recorded in CHANGELOG.md. A delta is
quoted only when it exceeds R, and R is quoted beside it. Never a bare
percentage.

The benchmark's own resolution limit is R = 5-7%, unbiased across four seeds,
established by `npm run bench:emit:selftest` -- a control asserting the harness
finds no difference between two identical implementations. Three protocol flaws
produced confident wrong numbers before the controls caught them, and are burned
into that file's header: max-over-pairs as the limit (R = 84%), 15 pairs with a
JIT-cold baseline class (+48.1% "improvement" of `emit()` over a byte-identical
copy of itself), and a 90% band (+6.2% false positive on seed 12345).

## Consequences

- **Breaking for callers passing garbage to the constructor.** v1.0.3 accepted
  `2.5`, `'10'`, `null`, `NaN` and `0`; v1.0.4 throws on all five. Every one of
  those produced an engine that could not work. Shipped as a patch because the
  affected callers are already broken; called out in the CHANGELOG regardless.
- **`emit()` never throws.** Its contract stays "silently rejects what it cannot
  store", now with an accurate definition of what it cannot store.
- Torture T1's P-02..P-06 pins invert: they pinned the wrong behaviour by design
  and are the visible diff of this session.
- S4 inherits a validated `max`, an `invLife` lane that cannot hold Infinity, and
  a written statement that dead slots have undefined non-`life` lanes.

## References

- `SoaParticleEngine_ROADMAP.md` section 2, findings P-02..P-06, P-13, P-14,
  P-17, P-18; section 5, S2 brief.
- `test/bench-ceiling.mjs` -- the MAX_PARTICLES gate, C1..C7.
- `test/bench-emit.mjs` -- the emit throughput harness and its self-test control.
- `decisions/0001-positioning.md` -- why this package exists beside lite-particles.
