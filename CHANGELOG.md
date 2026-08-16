# Changelog

All notable changes to `@zakkster/lite-soa-particle-engine` are documented here.
The format follows Keep a Changelog; this project uses semantic versioning.

## [1.1.0] - 2026-08-16

Loop ownership. The engine owned `requestAnimationFrame` and did not own the
physics -- exactly backwards. This release adds `tick(dt)` as the primary
stepping API so a host game loop, a fixed-step accumulator, lite-scheduler or a
worker can drive the engine with zero DOM, and it repairs three lifecycle
defects that live in the exact `_loop`/`start`/`onTick` code the new API
rebuilds. The policy is recorded in `decisions/0003-loop-ownership.md`, with the
`maxDt: Infinity` widening recorded as an amendment to
`decisions/0002-the-door.md`. This is a MINOR release: additive, non-breaking
for every existing consumer.

### Added
- **`tick(dt)` -- the primary stepping API.** Advance the simulation by `dt`
  seconds and invoke the onTick callback once, with no `requestAnimationFrame`
  required. `start()`/`stop()` are now thin RAF wrappers that pump it.
  `tick(dt)` is a NEW door: `dt` is a caller argument in the hot path, so it is
  guarded exactly as `emit()`'s arguments are (decision D3) --
  `!(typeof dt === 'number' && dt >= 0)`, type before value, one negation. The
  `>= 0` half rejects `NaN` for free; the `typeof` half makes it throw-safe on
  the P-24 corpus (`10n`, `Symbol()`, a throwing `valueOf`). `dt` is CLAMPED to
  `maxDt` on the high side and REJECTED (not clamped) on the low side: clamping
  `-1` to `0` would silently change what the caller asked for. Returns `true`
  iff the callback ran, `false` on a rejected `dt` / no callback / destroyed
  engine. Never throws.
- **`maxDt: Infinity` is now admitted** (S3 amendment to `decisions/0002`). A
  fixed-step caller sets it to disable the high-side clamp: `dt > Infinity` is
  never true, so the clamp becomes a documented no-op and the hot path is
  unchanged. The constructor predicate relaxes from `Number.isFinite(m) && m > 0`
  to `typeof m === 'number' && m > 0`, which still rejects `NaN`, `0` and every
  negative. The RangeError message drops the word "finite".

### Fixed
- **P-27 (S1) -- `onTick()` accepted any value and a non-callable crashed the
  render loop.** `onTick(cb)` stored `cb` unvalidated; `_loop` then did
  `if (this._onTick) this._onTick(...)`, so a truthy non-function threw a raw
  `TypeError` from INSIDE the frame callback -- the exact failure `emit()`'s
  never-throws contract exists to prevent. Repro: `e.onTick(42); e.start();
  raf[0](16)` -> `TypeError: this._onTick is not a function`. `onTick()` now
  throws a named library `TypeError` at the door (registration is cold, called
  once); a function registers, `null`/`undefined` unregister (stored as `null`,
  never `undefined`, so `tick()`/`_loop` test `=== null` rather than the
  truthiness that let `42` through), anything else throws.
- **P-28 (S1) -- a failed `start()` left the engine permanently unstartable.**
  `start()` set `this._isRunning = true` and `this._lastTime` BEFORE reaching
  `requestAnimationFrame`, so with no DOM the `ReferenceError` escaped with the
  engine flagged running and no frame pending; every later `start()` returned
  early on `if (this._isRunning) return;` and did nothing, forever -- even after
  a real RAF was installed. Repro: `new SoaParticleEngine(4).start()` under plain
  node -> throws with `e._isRunning === true`; install a counting
  `requestAnimationFrame` and call `start()` again -> **0** RAF calls. `start()`
  now validates `typeof requestAnimationFrame !== 'function'` BEFORE mutating any
  state and throws a NAMED library `TypeError`, leaving `_isRunning`/`_lastTime`
  untouched -- so the retry arms exactly one frame.
- **P-26 (S2) -- `_loop()` re-armed RAF unconditionally after the callback.**
  Even when the callback called `destroy()`/`stop()`, one orphaned frame was left
  pending on a torn-down engine. Repro: `onTick(() => e.destroy())`, pump one
  frame -> `e._destroyed === true` and `PUMP.pending() === true`. `_loop` now
  re-arms only when `this._isRunning && !this._destroyed`. The pinned torture
  assertion (`test/torture/t4-handles.mjs`) is flipped from `pending() === true`
  to `pending() === false`, and a T9 control reverts the guard and fails the
  flipped pin.
- **D8 -- the clock is environment input; a bad reading no longer kills the
  engine.** `_loop` wrote `_lastTime = time` BEFORE the callback ran, so a `NaN`
  or backwards `time` poisoned `_lastTime` permanently: every later frame
  computed `NaN`, `tick()` rejected it, and the engine went silently and
  permanently dead while still burning a RAF slot per frame -- P-28's fail-open
  shape through the other door. `_loop` now validates
  `typeof time === 'number' && time >= this._lastTime` and does NOT advance
  `_lastTime` on a bad reading, so a transient bad sample self-heals and a
  persistently broken clock is a visible no-op instead of a silent death. Repro:
  `_loop(NaN)` then `_loop(200)` -> `_lastTime` is 200 and dt is finite, not
  stuck at `NaN`.

### Changed
- **P-09 receipt half -- `emit()` returns the written slot index, or `-1`.**
  Previously `void`, so a caller could not learn which slot was written. All
  seven early-return paths return `-1` (one rejection value, no `undefined` in
  the return type) and the success path returns the index. The index is a
  RECEIPT, not an identity: valid until that slot is reused. Repro:
  `emit(0,0,0,0,1) === 0`, the next `=== 1`, `emit(NaN,0,0,0,1) === -1` with the
  cursor unmoved. **P-09's determinism half** (the README `Deterministic: Yes`
  claim and the injectable RNG that makes it true) is NOT in this release -- it
  ships with `emitBurst` in S3.1.

### Closed (declined)
- **P-12 -- no public `head` getter.** S1 already removed `._head` from
  `llms.txt`. The remaining "or promote it to a public getter" half is DECLINED
  (decision D5): the `emit()` receipt now tells a caller the slot it just wrote,
  which is what reading `head` approximated, and a getter is new public surface
  with a what-does-it-return-after-`destroy()` question and no consumer. If S4's
  managed mode needs an exposed cursor it will be `aliveCount`, a different
  number. P-12 is closed.

### Known issues (recorded, not repaired)
- **P-29 (S1, open) -- the D8 clock guard does not self-heal from a large
  FORWARD reading.** Found by S3 qa, after the reviewer had approved the diff,
  by attacking the one side of the predicate the decision record did not bound.
  `_loop` accepts any `time` satisfying `time >= this._lastTime`, so a single
  anomalous forward sample is taken as a legitimate frame and raises
  `_lastTime` permanently; every later real-clock sample is smaller, fails the
  guard forever, and the engine goes silently and permanently dead while still
  burning a RAF slot per frame. Realistic trigger: a RAF polyfill handing back
  a different clock basis for one frame (`Date.now()` ~1.7e12 against
  `performance.now()`'s small domain). Repro: `e._isRunning = true;
  e._lastTime = 0; e._loop(1e15);` then pump 50 frames from `now = 5000` -- the
  callback fires once and never again.

  **Not a regression.** The same input under 1.0.5's unconditional-advance
  `_loop` delivered `dt === -999999999995` to the callback on the very next
  frame -- a negative step of ~31,000 years that poisons every lane it touches
  -- before recovering. 1.1.0 trades lane corruption for a stopped loop, which
  is the better failure under law 4, but "better" is not "closed". Deliberately
  not patched here: a bound on a forward reading is new policy (what magnitude
  is anomalous, against which basis) and adding it after review is the
  mid-flight scope widening the S2 -> S2.1 split exists to prevent. Pinned as
  current behaviour in `test/qa-s3.test.js`; the D8 section of
  `decisions/0003-loop-ownership.md` carries the limit. Scheduled with S4.

### Testing
- **P-25 (test infrastructure only, no shipped code) -- `bench:ceiling` gained a
  third verdict.** It reported `FAIL` when it merely could not MEASURE: on macOS
  `os.freemem()` ignores reclaimable inactive/purgeable pages, so the candidate's
  touch was skipped and C2 failed spuriously (the identical tree failed and
  passed within minutes). Reclaimable memory is now counted in the touch budget
  (parsed from `vm_stat` on darwin), and a criterion that could not be measured
  reports `SKIP`; a run with any `SKIP` and no `FAIL` prints `INCONCLUSIVE` and
  exits non-zero -- never `PASS`. The rule this establishes outlives the bench: a
  criterion that did not run must never report PASS. S3.1's T8 (peers absent) is
  the next gate that needs this status to exist.
- Torture: three `t4-handles.mjs` pins flipped (P-08 ReferenceError -> named
  TypeError, P-09 `undefined` -> slot index, P-26 orphaned re-arm -> none), plus
  the new `onTick`/`tick`/`start()`-retry/poisoned-clock cases. T0 gained the
  `tick` false-return byte-identity + callback-counter law and the
  `tick(a);tick(b) == tick(a+b)` additivity law over a gravity-free
  constant-velocity body. T5 is filled: an AoS oracle differentially checks
  10,000 `tick(dt)` frames, with rejected emits and clamped/rejected dt inside
  the corpus. T6 routes its aging loop through `tick(dt)` so the new hot entry
  point is inside the zero-alloc window. T9 gained one control per new gate
  (bare-clamp `tick`, unvalidated `onTick`, mutate-before-validate `start()`,
  unguarded `_loop` re-arm, the D8 `_lastTime` revert, and a deliberately-wrong
  T5 oracle), each shown non-vacuous first and each exiting non-zero when armed.
- The `{ maxDt: Infinity }` node:test is inverted from throws-RangeError to
  constructs, and the `llms.txt` documented-rejection-contract test is extended
  to cover `tick`'s rejection set so the doc and the new door cannot drift.

### Performance
`tick(dt)` is a new hot entry -- one `typeof`, one `>=`, one clamp compare, one
`=== null`, one call, no closure/`arguments`/destructuring/default-object. It is
added to the T6 zero-alloc gate (`maxMajor: 0`, `maxPauseMs: 4`,
`maxArrayBuffersGrowth: 0`, all seven lane `buffer.byteLength` pinned, 0 B/op).
`emit()`'s added `return i` is an integer already in a register. `_loop` now
makes a real method call to `tick` where the body was inlined; V8 inlines it,
which is why `tick` is measured under T6 rather than assumed.

**Throughput this release is UNMEASURED, and no number is quoted because none
can be trusted.** `npm run bench:emit:selftest` is run first by protocol, and
it FAILED three times in a row on this host, resolving -6.2%, -7.2% and -7.6%
between two BYTE-IDENTICAL implementations. A gate that cannot stay silent on
identical code cannot be trusted to speak on different code, so every verdict
from the same run is void -- including that run's own
`RESOLVED. |-5.4%| > R=5.4%`, which claims a regression SMALLER than the noise
the selftest just demonstrated, and which an earlier draft of this section
mistakenly reported as "below R, no measurable change". It was not below R; the
R was understated. `test/bench-emit.mjs` is untouched by this session
(confirmed against `git status`), so the instability is ambient to the host --
the bimodal P/E-core behaviour recorded in `decisions/0002-the-door.md` -- and
not a property of this diff.

The claim that actually matters is unaffected and is proven independently:
**zero allocation on the hot path**, gated by T6 under `maxMajor: 0`,
`maxPauseMs: 4`, `maxArrayBuffersGrowth: 0` with `stabilize: 'deep'` and all
seven lane `buffer.byteLength` values pinned. That gate passes. Throughput
parity is a separate claim and this release does not make it.

## [1.0.5] - 2026-08-15

The last hinge. v1.0.4 closed the door on `life` and left the other four lanes
open: `emit()` still guarded `x/y/vx/vy` with `Number.isFinite`, which passes for
any finite f64 while those lanes are f32. A finite-but-huge coordinate or velocity
stored as `Infinity`, and unlike a bad `life` -- which expires -- `Infinity` in a
position lane is permanent and the caller's own physics turns it into `NaN` on the
first frame. This is P-05/P-17 one lane group over. The policy is recorded in the
S2.1 amendment to `decisions/0002-the-door.md`.

### Fixed
- **P-24 -- `emit()` THREW on a hostile `dataFlag`, and this shipped in v1.0.4.**
  This is the largest contract break in the release: the single load-bearing
  promise of the whole door is that **the constructor throws and `emit()` never
  does** -- `emit()` is per particle per frame, and a throw there is a render-loop
  crash. v1.0.4 broke it. The `dataFlag` guard `(dataFlag | 0) !== dataFlag` reads
  like a pure integer test, but `|` invokes `ToNumeric`, which throws for `BigInt`
  and `Symbol` and RUNS CALLER CODE (`valueOf`, `Symbol.toPrimitive`) for objects.
  Measured against published v1.0.4 and the S2.1 tree:

  ```
  emit(0,0,0,0,1,10n)                                       -> TypeError: Cannot mix BigInt and other types
  emit(0,0,0,0,1,Symbol('s'))                               -> TypeError: Cannot convert a Symbol value to a number
  emit(0,0,0,0,1,{valueOf(){throw new Error('boom');}})     -> Error: boom
  emit(0,0,0,0,1,{[Symbol.toPrimitive](){throw new Error('boom');}}) -> Error: boom
  ```

  The `dataFlag` guard was the ONLY one of the six that did not lead with `typeof`;
  the five lane guards are throw-safe precisely because P-23 forced them to. The
  fix is the same one-negation, two-half predicate:
  `!(typeof dataFlag === 'number' && (dataFlag | 0) === dataFlag)`. `typeof` never
  invokes user code and never throws, so `|` is reached only for primitive numbers
  -- and as a stronger consequence, `emit()` now invokes NO caller code on ANY
  argument, so there is no double-read / TOCTOU window on any of the six. The
  general rule, now recorded in `decisions/0002-the-door.md`: a guard in `emit()`
  may not invoke any operation that can call user code or throw (`|`, `+`, `<`,
  `>`, `==`, template interpolation), so every guard must lead with `typeof`.
  The "Never throws" claim in the README and `llms.txt` was FALSE when written; it
  is true now.
- **P-19 -- `x/y/vx/vy` overflowed f32 exactly as `life` did.**
  `new SoaParticleEngine(4).emit(1e300, 0, 1e300, 0, 1)` was ACCEPTED under
  v1.0.4: `head` advanced to 1, `x[0]` and `vx[0]` stored `Infinity`, and
  `x[0] - vx[0]` was `NaN`, so `x[i] += vx[i] * dt` poisoned the lane on the next
  frame. `emit()` now rejects any of the four lanes outside the SYMMETRIC f32 band
  `[-LANE_MAX, LANE_MAX]` before touching a lane. Each guard is
  `!(typeof v === 'number' && v >= -LANE_MAX && v <= LANE_MAX)`: the range half
  rejects `NaN` and both infinities on its own, the `typeof` half rejects
  non-numbers (see P-23), and both live inside ONE negation.
- **P-23 -- the band's relational operators COERCE, so the guard needs `typeof`.**
  Found in review of the first S2.1 draft, which wrote the band without a type
  check on the strength of a (wrong) claim that the range test "replaces"
  `Number.isFinite`. It does not: `Number.isFinite` never coerces, but `>=`/`<=`
  do, so through the `x` lane, published v1.0.4 rejected all seven values below
  while the draft ACCEPTED and stored every one --

  ```
  value    v1.0.4    draft
  null     rejected  ACCEPTED, x[0] = 0
  "5"      rejected  ACCEPTED, x[0] = 5
  ""       rejected  ACCEPTED, x[0] = 0
  false    rejected  ACCEPTED, x[0] = 0
  true     rejected  ACCEPTED, x[0] = 1
  []       rejected  ACCEPTED, x[0] = 0
  [7]      rejected  ACCEPTED, x[0] = 7
  ```

  A string laundered into a coordinate is the P-06 `dataFlag` class this door
  exists to close, so the draft was a regression against the version it fixed.
  The `life` band carried the identical hole since v1.0.4 (`emit(0,0,0,0,"1")`
  stored `life[0] === 1`; likewise `true` and `[1]`), so it is fixed in the same
  release with the same predicate: a door that rejects `x = "1"` while accepting
  `life = "1"` is not a policy. `typeof` -- not `Number.isFinite` -- because it is
  a call-free V8 type check and measured cheaper (both are far below
  `bench:emit`'s resolution R, so neither earns a number).
- **P-20 -- `llms.txt` documented a rejection contract `emit()` does not
  implement.** Line 36 read "NaN-safe (silently rejects non-finite x/y/vx/vy or
  life <= 0)", wrong in three ways after S2/S2.1: `life = 1e-46` is greater than
  zero and IS rejected (it is outside `[LIFE_MIN, LIFE_MAX]`); the `dataFlag`
  int32 rejection was never mentioned; and the `x/y/vx/vy` rejection is now a band,
  not a finiteness test. The line is rewritten against the shipped three-cause
  guard chain, and a test asserts the documented list and the implemented one
  cannot drift. README.md's Input Contract carried the same stale first bullet and
  is rewritten to match.

### Added
- `LANE_MAX` export (`3.4028235677973362e+38`), the symmetric f32 band bound for
  `x/y/vx/vy`: an emit is rejected unless each lies in `[-LANE_MAX, LANE_MAX]`.
  **Measured** by bisection on `Number.isFinite(Math.fround(m))` -- the largest
  f64 that stores as a finite f32; the next value up,
  `3.4028235677973366e+38`, stores as `Infinity`, and the negative side is exactly
  symmetric. It is numerically EQUAL to `LIFE_MAX` by coincidence of the f32
  storage type, and is declared INDEPENDENTLY, not aliased: the bound comes from
  `Float32Array`, not from a physical quantity, so it is identical for all four
  lanes and welding it to `LIFE_MAX` would let a future session widen one and
  silently widen the other. Unlike the one-sided `life` band, this band has NO
  floor -- `0`, `-0`, negatives and subnormals are all legal coordinates.

### Changed
- **Breaking for callers passing out-of-band coordinates.** v1.0.4 accepted a
  finite-but-huge `x/y/vx/vy` and stored `Infinity`; v1.0.5 rejects it. Every such
  caller was already storing `Infinity` into a lane and turning it to `NaN` on the
  next frame, so the affected callers are already broken and do not know it.
- **Breaking for callers passing coerced non-numbers (P-23).** v1.0.4 accepted a
  string, boolean or array in `x/y/vx/vy` or `life` and coerced it (`"5"` -> `5`,
  `true` -> `1`, `[7]` -> `7`); v1.0.5 rejects it. Those callers were laundering an
  untyped value into a lane, the exact class the door exists to close.
  Both are shipped as a patch for that reason, and called out here regardless.

### Performance
`emit()` trades the removed `Number.isFinite` calls for a `typeof` type check plus
two range comparisons per lane -- the one place this session can plausibly cost
something, so it is measured, not assumed. `npm run bench:emit` (Apple M4 Pro,
node v26.3.1, 51 interleaved pairs against the frozen v1.0.3 baseline): the delta
was **-5.5% against that run's own in-run resolution limit of R = 7.0%** (its
phase-1 control was clean, bias 2.1% within R). That is below resolution, so this
release makes **no throughput claim in either direction** -- a number smaller than
the noise that produced it is not a result. The separate `npm run
bench:emit:selftest` control is bimodal on this machine and resolves a spurious
difference between two byte-identical implementations in a minority of runs; that
is not selected away here, because it does not need to be -- a FAILING selftest
means R is UNDERSTATED, and a delta below a too-small R is below any larger one,
so "below resolution, no claim" is robust either way. `typeof` was chosen over
`Number.isFinite` because it is a call-free V8 type check rather than a builtin
call, but the difference sits far below R and earns no number here.

### Testing
98 -> 256 `node:test` cases. P-19 has a named position/velocity band group that
fails against v1.0.4 (the `emit(1e300, 0, 1e300, 0, 1)` headline, the two measured
endpoints accepted, the first value past each rejected, plus the no-floor cases,
each of the four lanes exercised independently). P-23 restores the strict-superset
test to the FULL old-rejected corpus -- `null`, `"5"`, `""`, `false`, `true`,
`[]`, `[7]`, `undefined`, `{}` alongside the non-finite numbers -- asserted per
lane, life INCLUDED, so a guard that drops `typeof` on any one lane fails it.
P-24 has a hostile-input group (`BigInt`, `Symbol`, throwing `valueOf`, throwing
`Symbol.toPrimitive`, revoked and throwing-trap `Proxy`) asserting `emit()` does
NOT throw and rejects the emit -- head unmoved, all seven lanes byte-identical --
across ALL SIX arguments, and a `qa-s2_1` matrix whose three former "BLOCKER"
throw-pins were inverted to the shipped contract once the fix landed. P-20 has an
`llms.txt`/README/source drift test that now also asserts the type cause.
Torture T1 gained the band matrix and the P-23 non-number matrix, T0 extended its
total-rejection corpus to the P-19 and P-23 rejects, and T9 gained in-process
controls plus three whole-tier reverts: `SOA_TORTURE_REVERT_BAND=1` swaps the band
back to `Number.isFinite` (observed to fail the T1 band pin),
`SOA_TORTURE_DROP_TYPEOF=1` drops the `typeof` half (observed to fail the T1 P-23
corpus pin), and `SOA_TORTURE_DROP_DATAFLAG_TYPEOF=1` reverts the `dataFlag` guard
to the v1.0.4 typeof-less form and is observed to make `emit()` throw on a `BigInt`
(P-24). Each reverted run exits non-zero.

## [1.0.4] - 2026-08-15

The door. Seven silent-corruption findings were one bug in seven costumes:
nothing was validated at any entry point, so a value that could not possibly be
correct was accepted, written into a lane, and surfaced much later as an
invisible particle, a `NaN` alpha, or an engine that accepted emits forever and
stored nothing. The policy is recorded in `decisions/0002-the-door.md`.

The split: **the constructor throws, `emit()` never does.** The constructor runs
once and a bad argument there is a programming error worth surfacing loudly;
`emit()` runs per particle per frame and a throw inside a render loop is a crash.

### Fixed
- **P-03 / P-18 -- the constructor accepted arguments that cannot make an
  engine.** `new SoaParticleEngine(2.5)` built lanes of length 2 with `max` 2.5;
  `'10'` produced a string `max`; `0`, `NaN` and `null` produced zero-length
  lanes. All now throw a named error (`TypeError` for non-numbers, `RangeError`
  for out-of-range numbers) that states the package, the argument, the
  constraint and the received value -- never the allocator's bare
  `RangeError: Invalid typed array length`.
- **P-04 -- `_head` could become `NaN` permanently.** One `emit()` into a
  zero-length engine set `_head = 0 % 0 = NaN`, after which every emit was a
  silent no-op forever. Dead by construction now: a validated `max` makes
  `(i + 1) % max` unable to produce `NaN`. No code of its own; the test proves it
  is unreachable.
- **P-05 / P-17 -- `life` was accepted at both ends of the f32 range where it
  corrupts.** `emit(..., life = 1e-46)` stored `life` 0 and `invLife`
  `Infinity`, making the documented `life[i] * invLife[i]` alpha `NaN`; above
  `LIFE_MAX`, `life` itself stored as `Infinity`. `emit()` now rejects any
  `life` outside `[LIFE_MIN, LIFE_MAX]`.
- **P-06 -- `dataFlag` was whatever `Int32Array` happened to do.** `3.7 -> 3`,
  `2**31 -> -2147483648`, `NaN -> 0`, `'x' -> 0`, `null -> 0`, all silent. That
  is not a policy. `emit()` now rejects any flag that is not an exact int32.
  `0` remains the default and is a legal recipe id.
- **P-02 -- the dt "cap" did not clamp, it fabricated.** `if (dt > 0.1) dt =
  0.016;` reported a 101 ms frame and a 5000 ms frame to the caller as identical
  16 ms frames. Replaced with a real clamp to `maxDt`.

### Added
- `MAX_PARTICLES` export (`2**24` = 16777216), the `maxParticles` ceiling.
  Proven, not asserted: `npm run bench:ceiling` is a falsifiable eight-criterion
  gate whose pass condition was written before the numbers, and it rejects wrong
  candidates in both directions (`2**25` and `2**30` too high, `2**20` too low).
  The load-bearing criterion is C6: **there is no size at which the lane
  allocator fails politely.** `2**33` does not throw, it kills the process
  (exit 133, uncatchable), so a `try/catch` cannot save a caller and validation
  is the only guard between a typo and a dead process.
- `LIFE_MIN` (`2.938735964636876e-39`) and `LIFE_MAX`
  (`3.4028235677973362e+38`) exports -- both **measured** f32 boundaries, not
  analytic ones. The analytic `1 / F32MAX` is `2.938736052218037e-39`, which is
  *larger* than the true boundary and would silently reject a band of perfectly
  legal lifetimes.
- `options.maxDt` constructor option (default `0.1`), validated at the door.
- `test/bench-ceiling.mjs` and `test/bench-emit.mjs`, with `npm run
  bench:ceiling`, `bench:emit` and `bench:emit:selftest`. Test-only; neither
  ships.

### Changed
- **Breaking for callers passing garbage to the constructor.** 1.0.3 accepted
  `2.5`, `'10'`, `null`, `NaN` and `0`; 1.0.4 throws on all five. Every one of
  them produced an engine that could not work, so the affected callers are
  already broken and do not know it. Shipped as a patch for that reason, and
  called out here regardless.
- A clamped frame **loses time by design** -- the alternative is a physics step
  so large that particles tunnel. This engine is not a fixed-step simulator; a
  caller needing an accumulator drives the step themselves.
- `clear()` is **life-only by contract**, now stated rather than implied: it
  zeroes `life` and resets the write cursor and does not touch
  `x/y/vx/vy/invLife/data`. For a slot with `life[i] <= 0` those six lanes are
  undefined and must not be read.
- The seven lanes are **reassigned only by `destroy()`**, now stated in the
  contract.

### Performance
`emit()` gains exactly one net comparison: the `dataFlag` int32 test. The `life`
band test `!(life >= LIFE_MIN && life <= LIFE_MAX)` *replaces* the old
`!Number.isFinite(life) || life <= 0` pair -- written with the negation outside,
one range test also rejects `NaN`, both infinities, `0` and negatives.

Measured with `npm run bench:emit` (Apple M4 Pro, node v26.3.1, 51 interleaved
pairs against the frozen 1.0.3 baseline): **+0.3% against that run's own
resolution limit of R = 6.4%.** That is below resolution, so this release makes
**no throughput claim in either direction** -- "no measurable change" is the
result, and a number smaller than the noise that produced it is not. The harness
reports R on every run and refuses to publish a delta it cannot resolve;
`npm run bench:emit:selftest` is the control proving it can correctly call two
identical implementations indistinguishable.

### Testing
24 -> 98 `node:test` cases. Every one of the nine findings has a named test that
fails against 1.0.3 and passes here. Torture tier T1 was inverted from pinning
the old buggy behaviour to asserting the new contract, T4 gained the lifecycle-
abuse matrix, and T9 gained a control that reverts the dt clamp to the 0.016
fabrication and must fail T1.

## [1.0.3] - 2026-08-15

Packaging honesty, `node:test` port, and the torture skeleton. **Zero behaviour
change:** `emit()` and `_loop()` are byte-for-byte identical in logic to 1.0.2.
The only edits to `SoaParticleEngine.js` are em-dash -> ASCII replacements, the
new `VERSION` export, and comment text. Every finding P-01..P-16 is RECORDED
below, not repaired; fixes begin in S2.

### Added
- `VERSION` export (`'1.0.3'`) in `SoaParticleEngine.js` and its `.d.ts`, so the
  version now lives in three places at once (package.json / VERSION / llms.txt)
  and can drift-check.
- `LICENSE` (MIT, (c) Zahary Shinikchiev). The tarball previously shipped no
  licence text despite `"license": "MIT"`.
- `CHANGELOG.md` (this file).
- `package.json` `scripts`: `test` (`node --test test/*.test.js`), `torture`
  (`node --expose-gc test/torture.mjs`), `verify` (`npm test && npm run torture`).
- `package.json` `engines.node` `>=18` and `sideEffects: false`.
- `llms.txt` and `LICENSE` and `CHANGELOG.md` added to `files[]` -- `llms.txt`
  previously existed in the repo but reached no consumer.
- `test/helpers/env.mjs` -- a deterministic frame pump. Node has no
  `requestAnimationFrame` / `cancelAnimationFrame` and no DOM `performance.now`
  (finding P-08); the shims live here once, driven by explicit timestamps, and
  are shared by both the node:test suite and the torture harness.
- `test/torture.mjs` + `test/torture/` -- the ten-tier torture suite. T0 (emit/
  tick algebra), T1 (degenerate values, current behaviour pinned), T6 (zero-alloc
  gate with per-lane `buffer.byteLength` pins), T7 (4096-cycle soak + raw-mode
  head invariant + a lite-leak second witness) and T9 (controls) are wired now.
  T2, T3, T4, T5, T8 are registered empty for later sessions.
- `test/ascii.test.js` -- a guard asserting every shipped file is ASCII-only
  (the only exceptions being U+00D7 and U+00B5).
- `decisions/0001-positioning.md` -- records the "two packages, two contracts"
  positioning versus `@zakkster/lite-particles`, citing that package's
  `decisions/0010` measured SoA `update()` regression, and the alignment to adopt
  its LAYOUT.POINT stride/offset contract for this package's future GPU handoff.

### Changed
- Test runner ported from vitest to `node:test` + `node:assert/strict`. All 23
  cases across 8 `describe` blocks are preserved; the vitest spies on
  `requestAnimationFrame` / `cancelAnimationFrame` / `performance.now` are
  replaced by the deterministic shims in `test/helpers/env.mjs`.
- ASCII sweep across the shipped files: em-dashes (U+2014) in
  `SoaParticleEngine.js`, `llms.txt`, and `README.md`, an en-dash (U+2013) in
  `llms.txt`, and emoji in `README.md` and the test file are all removed.
- Ring-buffer semantics documented TRUTHFULLY in the source comment, `README.md`
  and `llms.txt`: `emit()` overwrites the slot at the write cursor whether or not
  it is alive, which with mixed lifetimes is frequently NOT the oldest particle
  (finding P-01). The prior "overwrites the oldest particle" wording was false.
- `README.md`: the unverifiable benchmark table (finding P-10) is removed and
  replaced with a single sentence pointing at the stamped, reproducible benchmark
  that lands in S6. No performance number is claimed until then.
- `llms.txt`: the `._head` line (finding P-12) is removed; a public `head`
  getter is a later session's decision.

### Fixed
- Nothing. This session repairs no behaviour by design (see Known issues).

### Packaging
- `npm pack --dry-run`: **7 files**, up from the pre-session baseline of 4.
  New shipped files: `llms.txt`, `LICENSE`, `CHANGELOG.md`. `test/` and `demo/`
  remain excluded. The shipped set, not a byte count, is what S2 diffs against:
  this file is itself inside the tarball, so recording a packed size here changes
  the size it records. That fixed point is unreachable and chasing it produces
  exactly the kind of stale number this session deleted from the README. For a
  byte figure, run `npm pack --dry-run` -- it was ~9.5 kB packed at 1.0.3.

### Known issues (recorded, not repaired)

Each finding was reproduced by executing v1.0.2 on 2026-08-15. Severity: S1 =
silent data loss / corruption, S2 = broken documented guarantee, S3 = hygiene /
contract gap. The session that repairs each is noted.

- **P-01 (S1, S4)** -- The ring overwrites the slot at the write cursor whether
  or not it is alive, so a live particle is stomped while dead slots sit free.
  Repro: `max=3`; emit life 1.5 -> slot0, 0.3 -> slot1, 0.3 -> slot2; set
  `life[1]=life[2]=0`; emit again -> writes slot0 (`life[0]` becomes 0.30000001,
  `data[0]` becomes 4) instead of a free dead slot.
- **P-02 (S1, S2)** -- The dt cap fabricates a fixed 60Hz frame instead of
  clamping: `if (dt > 0.1) dt = 0.016`. Repro: `_loop` across a 200ms gap yields
  `dt === 0.016`; across a 101ms gap yields `dt === 0.016`.
- **P-03 (S1, S2)** -- No constructor validation. Repro: `new(0)` -> `max===0`,
  lanes length 0; `(2.5)` -> `max===2.5`, lanes length 2; `(NaN)` -> `max===NaN`,
  lanes length 0; `('10')` -> `typeof max==='string'`, lanes length 10;
  `(null)` -> `max===null`, lanes length 0; `(-1)` and `(Infinity)` -> raw
  `RangeError: Invalid typed array length`.
- **P-04 (S1, S2)** -- `_head` becomes `NaN` permanently and every later emit is
  a silent no-op. Repro: `const z = new SoaParticleEngine(0); z.emit(1,1,0,0,1);`
  -> `z._head` is `NaN`; a second emit leaves it `NaN`.
- **P-05 (S1, S2)** -- Below a precision floor on `life`, `invLife` becomes
  `Infinity` and the documented alpha `life*invLife` becomes `NaN`. Repro:
  `emit(...life=1e-46)` -> `life[0]===0`, `invLife[0]===Infinity`,
  `life[0]*invLife[0]` is `NaN`; `life=1e-40` -> `invLife[0]===Infinity`.
- **P-06 (S2)** -- `dataFlag` is unvalidated; four silent coercions through the
  Int32Array. Repro: `3.7 -> 3`, `2**31 -> -2147483648`, `NaN -> 0`, `'x' -> 0`.
- **P-07 (S2, S4)** -- Iteration is always O(max), never O(alive); no
  `aliveCount`. Repro: `max=100000` with 500 emitted scans 100000 slots per
  frame to touch 500 live particles.
- **P-08 (S2, S3)** -- The engine owns the RAF loop but exposes no `tick(dt)`, so
  it cannot be host-driven and throws without a DOM. Repro: `start()` calls
  `requestAnimationFrame` unconditionally; under Node `_loop` throws
  `ReferenceError: requestAnimationFrame is not defined`.
- **P-09 (S2, S3)** -- No deterministic spawn path and `emit()` returns `void`,
  so a caller cannot learn which slot was written. Repro: the README advertises
  `Deterministic | Yes` while every recipe uses `Math.random()` and `emit()`
  returns nothing.
- **P-10 (S2, S6)** -- The README benchmark table had zero provenance (no
  methodology, machine, version stamp, or repro script). Repro: the table
  existed in `README.md` and is removed this session; its numbers are not
  restated here.
- **P-11 (S3, S5)** -- `destroy()` nulls the public lanes, forcing
  `Float32Array | null` in the d.ts and a null-check on every hot-lane access.
  Repro: `SoaParticleEngine.d.ts` lanes are typed `... | null`.
- **P-12 (S3)** -- `llms.txt` documented `._head` (an underscore-private) as
  public API. Repro: the `._head` line in `llms.txt`, removed this session.
- **P-13 (S3, S4)** -- `clear()` only zeroes `life` and resets the cursor;
  `x/y/vx/vy/data` retain the previous scene. Repro: `emit(5,6,7,8,1,42)` then
  `clear()` -> `x[0]===5`, `vx[0]===7`, `data[0]===42`, `life[0]===0`.
- **P-14 (S3, S5)** -- Nothing is frozen or sealed; lanes are reassignable by any
  consumer. Repro: `Object.isFrozen(engine) === false`.
- **P-15 (S3, S5)** -- `pause()` is a bare alias for `stop()` with no distinct
  semantics. Repro: `pause() { this.stop(); }`.
- **P-16 (S3, S4)** -- No `validate()` / `stats(out)` introspection of any kind;
  the only observability is reading raw lanes. Repro: no such methods exist in
  the source.

### Known gaps in this session's own guards

- The ASCII guard in `test/ascii.test.js` covers the SHIPPED set only, so
  `demo/demo.html` is unswept and still carries non-ASCII (U+2014 in the title
  and headings, U+2550 box-drawing in the comment banners). Repro:
  `LC_ALL=C grep -n '[^ -~]' demo/demo.html`. The demo is not in `files[]` and
  reaches no consumer, and S6 rebuilds it to the demo convention -- but the
  ASCII law is written about source, not about the tarball, so this is a real
  gap and not a decision. S6 owns it; widen the guard to `demo/` in the same
  session.
- **P-07 has no pin and cannot get one yet.** It is a scaling cost, not a state
  transition: with no `aliveCount` and no timing lane in the gate, any test
  would assert nothing. S4 introduces the counter that makes it checkable.
  Recorded here so its absence is deliberate rather than overlooked.

[1.0.3]: https://github.com/PeshoVurtoleta/lite-soa-particle-engine
