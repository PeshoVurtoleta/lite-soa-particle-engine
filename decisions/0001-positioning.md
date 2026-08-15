# 0001 -- positioning vs @zakkster/lite-particles: two packages, two contracts

- **Status:** accepted
- **Date:** 2026-08-15
- **Session:** S1 (v1.0.3)
- **Findings:** P-META (packaging honesty); informs P-01 and P-10.

## Context

The ecosystem already ships @zakkster/lite-particles@1.5.0, a mature object-core
particle engine: pooled, Object.seal'd particles, emission zones, baked easing
curves, onDeath sub-emitter cascades, seeded determinism via @zakkster/lite-random,
0 B/call update()/draw(), and GPU handoff via packTo() streaming into lite-gl
LAYOUT.POINT instances. This package -- @zakkster/lite-soa-particle-engine -- is a
Structure-of-Arrays throughput core: there is no per-particle object at all, the
caller writes the physics loop directly over seven raw TypedArray lanes, and the
target population is 10K-100K particles.

Before deciding whether one should consume, fold into, or sit beside the other, the
question was settled by measurement that already exists on disk.

## The evidence: lite-particles decisions/0010-soa-perf-gate.md

lite-particles PROTOTYPED an SoA column store behind a falsifiable perf gate whose
pass condition and fail-action were written BEFORE the code (its
`decisions/0010-soa-perf-gate.md`, harness `test/bench-soa.mjs`). The gate fired.
Measured on Apple M4 Pro, node 26.3.1, reps=5, median opsPerSec, SoA-over-object
throughput ratio for `update()`:

```
   N        ratio (SoA / object)
    100     0.604
    500     0.658
   1000     0.856
  10000     0.760
 100000     0.755
```

SoA regressed `update()` at EVERY particle count, small and large, because
lite-particles' physics touches most per-particle fields per frame -- the exact
access pattern that favours an array-of-structs. Its only SoA edge, streaming
`packTo`, merely tied the object core once a hand-written AoS pack was added. Per
the pre-committed fail-action, SoA was shelved (kept as reproducible evidence in
`test/baseline/EmitterSoA.mjs`, never shipped) and `packTo` landed on the object
core instead.

That measurement is the decisive fact here: the two cores want different data
layouts. lite-particles' workload (rich per-particle physics on hundreds of
objects) is fastest as arrays-of-structs; this package's workload (a caller-owned
tight loop over 10K-100K uniform particles) is fastest as columns.

## Options

- **A. Two packages, two contracts (chosen).** lite-particles stays the ergonomic
  object core; this package stays the throughput column core. Neither consumes the
  other. Cost: two particle packages to keep straight, mitigated by one crossover
  paragraph in each `llms.txt` naming the other and stating when to reach for it.
  Gain: no refactor, and the measured evidence above already says the two cores
  want different layouts.
- **B. lite-particles consumes this as its core.** Directly contradicted by
  decisions/0010: it re-introduces the 14-40% `update()` regression that gate
  rejected, and it hands lite-particles a runtime dependency it deliberately does
  not have (its only one is lite-random). Rejected -- evidence against.
- **C. Fold one into the other.** Deletes either the object ergonomics or the
  throughput ceiling and forces a breaking change on a published package to solve a
  problem nobody reported. Rejected.

## Decision

**Option A.** Two cores, separate packages, neither depending on the other, each
`llms.txt` naming the sibling with a stated crossover.

Plus one concrete alignment: **this package adopts lite-particles' LAYOUT.POINT
stride/offset contract for its future GPU handoff (S6).** lite-particles exports
`LAYOUT_VERSION` (1), `POINT_STRIDE` (8) and `POINT_OFFSETS`
(`{ x:0, y:1, size:2, r:3, g:4, b:5, a:6, _pad:7 }`) as the packTo/lite-gl
LAYOUT.POINT contract. When S6 gives this package a `packTo`, it emits the same
8-float POINT instance layout so both cores feed the same lite-gl POINT sink.
Shared output format, separate cores.

## The crossover sentence (verbatim in both llms.txt files)

> When to reach for the sibling: @zakkster/lite-particles is the ergonomic object
> core (pooled particles, zones, curves, onDeath cascades, seeded determinism, GPU
> handoff via packTo) for a few hundred to a few thousand particles;
> @zakkster/lite-soa-particle-engine is the throughput core (no per-particle
> object, the caller writes the physics loop over raw TypedArray lanes) for
> 10K-100K particles -- neither consumes the other. lite-particles feeds
> lite-gl's LAYOUT.POINT contract today via packTo; lite-soa-particle-engine
> adopts the same output contract in S6.

## References

- `@zakkster/lite-particles` `decisions/0010-soa-perf-gate.md` -- the gate that
  fired, with the measured ratios above.
- `@zakkster/lite-particles` `decisions/0011-*` -- the follow-on packTo-on-object
  decision.
- This package's roadmap section 2 (P-01, P-10) and section 5 (S1, S6 briefs).
