# 0004 -- the spawn path: emit a cone from an injected RNG

- **Status:** accepted
- **Date:** 2026-08-21
- **Session:** S3.1 (v1.2.0)
- **Findings:** P-09 (closed -- the spawn half), P-30 (documented as a bound),
  P-31 (fixed, both sites).
- **Amends:** `decisions/0002-the-door.md` -- the door family gains three
  arguments it did not bound (`count`, `spec`, `rng`). See the amendment note in
  0002.

## Context

S3 (`decisions/0003-loop-ownership.md`) gave the FRAME back to the application:
`tick(dt)` steps the engine and `emit()` returns a receipt. What S3 did NOT give
back is the SPAWN. Every recipe still reaches for the platform PRNG inside the
caller's own loop, so two runs of the same script diverge on the first particle
and nothing in the package can be replayed.

This session adds ONE hot method, `emitBurst(x, y, count, spec, rng)`, whose
entire reason to exist is that the randomness is an argument. It is built in the
door family's shadow: the door law from 0002/0003 is already written -- type
before value, one negation, no coercion, no caller code on the reject path -- and
the failure this session must not produce is a new hot entry point built to a
weaker standard than `emit()` and `tick()`.

`emitBurst` writes through the EXISTING guarded store (`emit()`), unchanged. It
inherits P-01 exactly: a full ring overwrites the slot at the cursor whether or
not it is alive. It gets no smarter overflow policy than `emit()` has; that is
S4.

## D1 -- the RNG contract is `.next()` and nothing else

`emitBurst` requires exactly one method on `rng`: `.next()` returning a float in
`[0, 1)`. That is lite-random's native shape (`Random.prototype.next`), so a
`Random` instance is passed directly -- no adapter, no wrapper, no `.bind()`
allocation at the call site.

The default is a module-level frozen singleton created once at module load:
`{ next: <platform PRNG> }`. It is NOT a branch inside the loop and NOT a default
parameter that re-evaluates. `rng === undefined ? DEFAULT_RNG : rng` resolves
ONCE, above the loop, into a local. It is the ONE permitted platform-PRNG read
site in the whole file; every hot path takes `rng` as an argument.

- **Rejected: accept a bare function (`rng()`).** It reads more naturally and it
  is wrong. The platform PRNG passed bare is indistinguishable from a caller's
  seeded closure, so nothing can be validated, and a lite-random user would write
  `r.next.bind(r)` and allocate a function per burst. A bare function fails the
  `typeof rng === 'object'` half of the door and is REJECTED (`-1`).
- **Rejected: consume lite-random's richer surface (`.range`, `.unitVectorArray`).**
  Every method used becomes a required shape. The point of a one-method contract
  is that a caller's own eight-line xorshift satisfies it.

## D2 -- draw-before-store: the RNG stream is independent of ring state (NORMATIVE)

**Every particle in an accepted burst consumes exactly 3 draws -- angle, speed,
life -- in that order, unconditionally.** Not conditionally on the matching
`*Var` being non-zero. Not conditionally on the individual store being accepted.

This is the decision the whole session rests on. If a store that stomped a full
ring consumed fewer draws, the RNG stream would depend on ring occupancy, and
replay would desync the first time the pool filled -- silently, on frame 4000, on
one machine and not another. Draw first into locals, then call the guarded store.

The cost is real and accepted: a burst into a full ring still burns `3 * count`
draws. That is the price of a stream a caller can reason about.

**The draw ORDER is contract, not incident (R3).** A counting RNG proves the
count law and NOTHING about order; an implementation that drew `speed` before
`angle` would pass every count assertion and silently desync any oracle that
consumes the same stream. The order is `angle, speed, life`, in that sequence,
and a sequencing RNG over three distinguishable values pins it: the resulting
`vx/vy` come from `angle` then `speed`, and `life` from the third draw. T0 asserts
this with a sequencing RNG; the T5 oracle consumes the SAME stream in the SAME
order so the two implementations cannot drift.

## D3 -- `spec` is read into locals ONCE, before the loop

`speed, speedVar, angle, angleVar, life, lifeVar, data` are read field-by-field
into locals before the first iteration -- each raw property read exactly once.
Never spread, never cloned, never re-read inside the loop. A `spec` whose fields
are getters fires each getter exactly once per burst, not once per particle, and
cannot observe or steer the loop. A missing field (`undefined`) takes its
documented default; the object is READ, not required to be complete, and a `spec`
of `null`/`undefined`/a primitive reads as all-defaults without throwing.

## D4 -- `emitBurst` does not throw for a bad-VALUE argument; caller code propagates

`emitBurst` is per-frame, so it inherits `emit()`'s contract for the values it is
handed: no degenerate NUMBER, string, boolean, array, `null` or `undefined` in
`x`, `y`, `count` or a `spec` field can make it throw. `x`, `y`, `count` and every
`spec` field pass the same two-half `typeof`-first door as `emit()`, validated
ONCE per burst at the top. `typeof` leads every guard, which defends against
COERCION-time caller code: a hostile `spec` field that is a `Symbol`, a `BigInt`,
or an object with a throwing `valueOf` / `Symbol.toPrimitive` is REJECTED with
`-1` without ever reaching an operator that would invoke its coercion, because
`typeof` runs before any such operator.

**What `typeof`-first cannot defend against, and why.** An ACCESSOR getter runs
when the property is READ, and the read is what supplies the value the guard is
about to check -- so a getter on a `spec` field, or a getter on `rng.next`, runs
its body before any guard can look at what it returned. No guard can precede its
own input: `typeof` orders the check before COERCION, but a property read has no
earlier position to occupy. Such a getter throwing therefore PROPAGATES, exactly
as `rng.next()` throwing does, and for the same reason -- it is the caller's code,
not an argument of ours, and swallowing it would convert a caller bug into a
silently half-written burst (D4's own principle). The next door built in this
family will meet the same boundary; it is a property of property reads, not of
this method. Concretely, three throw paths exist and all three are caller code
that propagates: `rng.next()` throwing, a throwing accessor getter on a `spec`
field, and a throwing accessor getter on `rng.next`. A throwing `valueOf` is NOT
among them -- it is a coercion path, and `typeof`-first rejects it with `-1`.

This enumeration is SCOPED to an `rng` that honours its stated `.next() -> [0, 1)`
number return. A `next()` that returns a `BigInt`, or an object with a throwing
`valueOf` / `Symbol.toPrimitive`, throws at the `r.next() * 2` coercion in the hot
loop; one returning a plain object coerces to `NaN` (which the store then
rejects). Validating the return per draw is a hot-path cost this session has not
decided on and does not guard -- a caller that breaks the return contract owns the
consequence, exactly as one that hands a throwing getter does.

`rng` is validated once as
`!(rng !== null && typeof rng === 'object' && typeof rng.next === 'function')`.
`count` must be a number that is an integer `>= 1`. A failed door rejects the
WHOLE burst before any draw and before any write.

But caller CODE that throws PROPAGATES -- `rng.next()` throwing, a throwing
accessor getter on a `spec` field, or a throwing accessor getter on `rng.next`.
It is not ours to swallow, and swallowing it would convert a caller's bug into a
silently half-written burst. These are the documented ways `emitBurst` can throw
(all of them caller code, none of them a bad-value argument of ours), and they
are stated in llms.txt, the README and the d.ts. On any of those paths the
particles drawn and stored before the throw remain, and `_head` has advanced by
exactly the
number stored -- the store is committed per particle, not batched.

**Return value (amended by R4, superseding the brief's `0..count`).** `-1` when
the burst is rejected at the door -- nothing drawn, nothing written. Otherwise the
COUNT of particles actually stored, which for an accepted burst is EXACTLY
`count` (see R4). There is no `0..count` range: the door either rejects the whole
burst or admits a burst every one of whose stores succeeds.

## D5 -- the spec is a cone, and that is all

```
{ speed, speedVar, angle, angleVar, life, lifeVar, data }
```

Defaults: `speed 100, speedVar 0, angle 0, angleVar Math.PI (2 * PI is a full
disc), life 1, lifeVar 0, data 0`. Per particle, in the D2 draw order:

```
a = angle + (draw1 * 2 - 1) * angleVar   // draw1 -- angle
s = speed + (draw2 * 2 - 1) * speedVar   // draw2 -- speed
l = life  + (draw3 * 2 - 1) * lifeVar    // draw3 -- life
store(x, y, cos(a) * s, sin(a) * s, l, data)
```

Symmetric variance, because an asymmetric one needs two fields per axis and this
is a burst helper, not an emitter DSL. `cos`/`sin` are the accepted cost of a
cone; they allocate nothing and T6 proves it rather than assuming it. Anything
richer -- rings, boxes, curves, zones, sub-emitters -- is lite-particles'
surface; `decisions/0001-positioning.md` says so.

## R4 (BLOCKER-3) -- the envelope is checked ONCE, and the return type collapses

The cone can, in principle, produce a value the per-particle store rejects (a
speed so large `cos(a) * s` leaves the lane band, a `life` outside its band). If
that were left to the per-particle store, an accepted burst could store fewer
than `count` and the return type would be a `0..count` range whose value depends
on ring and band state.

**It is not left to the store. The envelope is door-checked ONCE per burst, above
the loop**, cold, in a handful of comparisons, with zero hot-body bytes:

- `angle` and `angleVar` each lie in `[-LANE_MAX, LANE_MAX]`, so every drawn
  `a = angle + t * angleVar` (`t` in `[-1, 1)`) is finite and `cos(a)`/`sin(a)`
  lie in `[-1, 1]`.
- `Math.abs(speed) + Math.abs(speedVar) <= LANE_MAX`, so every drawn `s` has
  `|s| <= LANE_MAX`.
- both `life - lifeVar` and `life + lifeVar` lie in `[LIFE_MIN, LIFE_MAX]`, so
  every drawn `l` lies in that band.

With the envelope bounded, every individual store SUCCEEDS: `x`/`y` are
door-validated; `|vx| = |cos(a) * s| <= |s| <= LANE_MAX` and likewise `vy`,
because multiplying by a magnitude `<= 1` cannot round a double past `|s|`; every
drawn `life` lies between the two checked endpoints; `data` is door-validated.
**So an accepted burst stores EXACTLY `count`.**

Correcting a cited ambiguity: **a full ring never reduces the count.** `emit()`
has no fullness test -- past its guards it writes at `_head` unconditionally and
returns an index, so an overflow STOMPS (P-01) but still stores. The
partial-burst class does not survive this envelope at all.

This is the strongest claim the session makes. It is pinned as its own assertion
(T0 the collapse law, T4 the envelope rejections) and a T9 control
(`SOA_TORTURE_BURST_NO_ENVELOPE`) removes the envelope and MUST make the collapse
law bite. `emitBurst` still counts actual stores rather than assuming `count`, so
the return is honest: with the envelope it equals `count`; without it, it drops
below and the law fails, which is exactly the signal.

## R5 -- `count === 0` is a DOOR REJECTION

`count === 0` returns `-1` and draws nothing. It is surprising -- a reviewer will
read it as a bug -- so the reason is recorded here: an accepted zero-count burst
would consume 0 draws, and a draw count that depends on an argument's VALUE is
the state-dependent stream D2 exists to forbid. `count` must be an integer `>= 1`;
`0`, negatives, fractions, `NaN`, `Infinity` and every non-number are rejected at
the door with zero draws.

## R10 -- reuse `emit()` unchanged; do not write a private store

`emitBurst` calls the shipped `emit()` per particle. Re-validating the
burst-invariant `x`/`y` per particle costs `2 * count` monomorphic `typeof`s,
which is measurable but small; a private `_store` would duplicate four guard
predicates that must then stay in sync FOREVER, which is the exact drift that
produced P-23 and P-24. The duplication hazard outweighs the per-particle
re-validation. If anyone wants the other answer it is a measurement question for
S6, not a design decision here.

## R11 -- a destroyed engine consumes nothing

`if (this._destroyed) return -1;` is the FIRST line of `emitBurst`, before every
value guard and before any draw, matching `emit()`'s precedent. A destroyed
engine must NEVER consume a caller's RNG stream -- a burst that drew before
checking `_destroyed` would desync a replay that happened to tear an engine down
mid-script.

## D6 -- P-30: the replay contract is scoped to a FRESH engine

The claim this session is permitted to write, in exactly this shape:

> Given a fresh engine, an identical emit/tick script, and an RNG replaying the
> same seed, every lane is byte-identical across runs and across machines.

Three bounds ship WITH it, in the same paragraph, never in a footnote:

1. **`clear()` is not a replay reset (P-30).** It zeroes `life` and the cursor;
   `x/y/vx/vy/data` keep the previous scene. A replay after `clear()` matches a
   fresh engine only where the shorter replay happens to overwrite. Construct a
   new engine. MEASURED: after 8 emits at `x = 500..507, data = 42`, then
   `clear()`, then a 2-emit replay, `x[7] === 507` and `data[7] === 42` where a
   fresh engine reads `0` and `0`; an ungated `sum(x[i])` reads `3028` against the
   fresh engine's `1`.
2. **Parity comes from seed parity, not from sharing one `Random`.** Two engines
   sharing one instance interleave draws and both diverge; two instances at the
   same seed replay byte-identically.
3. **f32 storage is the equality domain (R9).** Lanes are compared AS STORED --
   f32 for the six float lanes, i32 for `data` -- not as the f64 the caller
   passed.

- **Rejected: fix `clear()` here so the bound is unnecessary.** Zeroing seven
  lanes instead of one is a hot-path cost decision that belongs with the liveness
  architecture (S4/S5) that needs it. Widening scope mid-session is what the
  S2 -> S2.1 split exists to prevent. This session DOCUMENTS the bound; it does
  not change what `clear()` writes.

## D7 -- P-31: delete the number, do not stamp it

`README.md:28` loses "10x fewer cache misses" and keeps the mechanism, which is
true and needs no measurement: sequential lanes let the prefetcher work, object
graphs do not. R1 widened this to the whole shipped set: `SoaParticleEngine.js`
carried a second, older unstamped number ("~10x faster") in its header comment,
which ships in `files[]`. Both numbers go; both mechanisms stay. S6 owns every
stamped number in this package, and a README that forbids numeric claims two
paragraphs above one is worse than either policy alone.

## Consequences

- `emitBurst(x, y, count, spec, rng)` is the documented spawn path; P-09 closes.
- The RNG is an argument; the package is replayable within D6's bounds.
- `DEFAULT_RNG` is the only platform-PRNG read site in the file.
- T8 is filled against lite-random (seed parity) and lite-scheduler (a callback
  driving `tick(dt)` with no RAF and no DOM), both added as devDependencies.
- Five T9 controls revert one burst decision each and must make the matching pin
  bite: lazy draw (D2), spec-in-loop (D3), bare-fn rng (D1), swallowed throw (D4),
  no envelope (R4).
- P-30 is documented as a bound on the replay claim; `clear()` is unchanged.
- P-31 is fixed at both sites.

## References

- `S3_1_BRIEF.md` -- the session brief, decisions D1..D7.
- `S3_1_PLAN.md` -- the atomic task decomposition; resolutions R1..R11 amend the
  brief on D4's return type, D7's scope and assertion 10.
- `decisions/0002-the-door.md` -- the door law and the `count`/`spec`/`rng`
  amendment.
- `decisions/0003-loop-ownership.md` -- `tick(dt)` and the `emit()` receipt this
  method builds on.
- `SoaParticleEngine_ROADMAP.md` -- findings P-09, P-30, P-31.
