# 0003 -- loop ownership: give the frame back to the application

- **Status:** accepted
- **Date:** 2026-08-16
- **Session:** S3 (v1.1.0)
- **Findings:** P-08, P-09 (receipt half), P-12 (closed, declined), P-25, P-26,
  P-27, P-28.
- **Supersedes on one point:** the `_loop` "a broken clock is the caller's
  problem" comment from `decisions/0002-the-door.md` (P-02 section). See D8.

## Context

Through v1.0.5 the engine OWNS `requestAnimationFrame` and does not own the
physics -- exactly backwards. There is no `tick(dt)`, so the package cannot be
driven from a host game loop, a fixed-step accumulator, `lite-scheduler`, or a
worker, and it cannot be loaded anywhere without a DOM.

S2 and S2.1 closed the door on `emit()`. This session opens a NEW door:
`tick(dt)` takes a caller-supplied number in the hot path for the first time.
The whole point of doing it in the door family's shadow is that the door law is
already written -- type before value, one negation, no coercion, no caller
code. The failure this session must not produce is a new entry point built to
the old standard.

While S3 rewrites `_loop`/`start`/`onTick`, three defects reproduced on
2026-08-16 (node 26.3.1) live in that exact code and are repaired here rather
than touching the same twenty lines twice:

```
P-26  _loop() re-arms RAF unconditionally after the callback returns, even when
      the callback called destroy()/stop(). One orphaned frame on a torn-down
      engine. Self-heals, does not throw -- cosmetic today, wrong shape to carry
      into a public tick(dt).
P-27  onTick(cb) stores cb unvalidated; a truthy non-function throws a raw
      TypeError from INSIDE the frame callback -- the exact failure emit()'s
      never-throws contract exists to prevent. null/undefined are falsy and
      safely unregister, so the surface is asymmetric: one bad value is a no-op,
      the next is a crash.
P-28  start() sets _isRunning = true and _lastTime BEFORE reaching
      requestAnimationFrame, so a ReferenceError with no DOM leaves the engine
      flagged running with no frame pending. Every later start() returns early on
      `if (this._isRunning) return;` -- permanently unstartable, even after a
      real RAF is installed.
```

## D1 -- `tick(dt)` primary, RAF wrapper retained

- **A (CHOSEN).** `tick(dt)` is the contract; `start()`/`stop()` become thin
  wrappers that pump it from RAF. Additive, non-breaking, and it is what every
  downstream integration needs.
- **B.** `tick(dt)` primary, RAF removed. Cleaner, breaks every consumer, waits
  for S5 if ever.
- **C.** Keep RAF ownership, add a "manual mode" flag. Two loop owners, two ways
  to be wrong about `_lastTime`. Rejected.

`tick(dt)` is the only place the clamp and the callback invocation live; `_loop`
computes `dt` from the clock and calls `tick(dt)`. The clamp is NOT duplicated
in both -- `maxDt` appears exactly once in `tick`'s body and zero times in
`_loop`'s (the precondition for the tick/RAF byte-identity claim; grep gate R8).

## D2 -- `start()` fails closed (P-08 + P-28)

`start()` validates the environment BEFORE mutating any state, and throws a
named library error -- `SoaParticleEngine: start() requires requestAnimationFrame ...`
-- not a bare `ReferenceError`. On the throw path `_isRunning` and `_lastTime`
must be UNTOUCHED, so a caller who installs a polyfill and retries gets a
working engine. Today that retry is a silent no-op forever (P-28).

Detection is `typeof requestAnimationFrame !== 'function'` -- `typeof` on an
undeclared identifier does not throw, which is the whole reason it is the test.
No `try`/`catch` around the call.

`stop()` stays as-is: it is already idempotent and DOM-safe (`_rafId` is `null`
unless a frame was actually armed).

## D3 -- `tick(dt)` validates `dt` (the new door)

This is the session's real decision. `dt` is now a caller argument in the hot
path, which is exactly what `emit()`'s five arguments are, and the door law
already covers it. Without a guard: `tick('0.05')` passes `'0.05' > maxDt`
(false, no clamp) and hands the STRING to the callback, where `x[i] += vx[i] * dt`
coerces it -- the P-23 laundering class, one entry point over. `tick(-1)` runs
the simulation backwards. `tick(NaN)` poisons every lane the callback touches,
permanently.

**CHOSEN policy, matching `emit()` in shape and in silence:**

```js
tick(dt) {
    if (this._destroyed) return false;
    // Type before value, one negation. `dt >= 0` rejects NaN for free, exactly
    // as the lane bands do. -0 passes and is harmless.
    if (!(typeof dt === 'number' && dt >= 0)) return false;
    if (dt > this.maxDt) dt = this.maxDt;
    if (this._onTick === null) return false;
    this._onTick(dt, this.x, ..., this.max);
    return true;
}
```

- **Reject, do not throw.** `tick()` is per-frame; a throw is a render-loop
  crash. Same reasoning as `emit()`.
- **Reject, do not clamp, on the low side.** Clamping `-1` to `0` silently
  changes what the caller asked for -- the failure mode this package removes
  (law 4).
- **Clamp, do not reject, on the high side.** The shipped S2 contract; unchanged.
- **Return a receipt.** `true` = the callback ran; `false` = rejected dt, no
  callback registered, or destroyed. Costs a register.

The `>= 0` half rejects NaN for free. The `typeof` half is load-bearing for the
same reason it is on `emit()`'s lanes: a relational operator on an unvalidated
argument coerces (`'0.05'` -> 0.05, `null` -> 0, `[7]` -> 7, `true` -> 1) and
THROWS for BigInt and Symbol and RUNS caller code (`valueOf`,
`Symbol.toPrimitive`). `typeof` first is what makes `tick` throw-safe on the
P-24 corpus (`10n`, `Symbol()`, `{valueOf(){throw 0;}}`).

Second half of D3 (widens a door `0002` owns -- recorded as an amendment there):
`maxDt: Infinity` is the supported way to disable clamping for a fixed-step
accumulator. The S2 constructor threw on it (`Number.isFinite(m) && m > 0`
rejects `Infinity`). Relaxed to `typeof m === 'number' && m > 0`, which admits
`Infinity` and still rejects `NaN` (`NaN > 0` is false) and every negative.
`dt > Infinity` is never true, so the clamp becomes a documented no-op and the
hot path is unchanged.

## D4 -- `emit()` returns the written slot index, or `-1`

Zero cost; the index is already in a local. `-1` on ALL SEVEN current early
returns, the `_destroyed` guard included, so there is exactly one rejection
value and no `undefined` anywhere in the return type; the tail returns `i`.

A slot index is a RECEIPT, not an IDENTITY: valid until that slot is reused, and
after S4 until the next compaction. This is what gives T4 a handle worth
abusing.

## D5 -- P-12: no public `head` getter. Close the finding. DECLINED.

S1 already did the half that mattered -- `._head` is gone from `llms.txt`. The
remaining half was "or promote it to a public getter", and D4 removes the reason
anyone wanted it: the receipt tells you the slot you just wrote, which is what a
caller reading `head` was approximating. Adding a getter now is new public
surface, with a what-does-it-return-after-`destroy()` question attached, and no
consumer.

**DECLINED. P-12 is closed.** If S4's managed mode needs an exposed cursor it
will be `aliveCount`, which is a different number with a different meaning.

## D6 -- P-27: `onTick()` throws at registration

Registration is a COLD path, called once at setup. It follows the constructor's
throw-at-the-door policy, not `emit()`'s silent-reject policy:

- a function -> registered
- `null` or `undefined` -> unregisters, returns normally (the current safe
  behaviour; callers may already depend on it)
- anything else -> named `TypeError` naming the argument and its type, built
  with the existing `_showArg` helper so a hostile `toString` cannot replace
  this library's error with a foreign one

Store `null`, never `undefined`, so `_loop`/`tick` test `=== null` rather than
truthiness -- truthiness is what let `42` through.

## D7 -- P-26: the re-arm is guarded

`_loop` re-arms only when `this._isRunning && !this._destroyed`. The pinned
assertion at `test/torture/t4-handles.mjs:275` MUST be flipped as part of this
session, not deleted -- the pin exists precisely so this change is visible and
deliberate. A T9 control reverts the guard and must fail the flipped pin.

Three pins flip (0007 named one; there are three):

```
t4-handles.mjs:49   pins threw instanceof ReferenceError -> named library TypeError (D2)
t4-handles.mjs:58   pins emit() returns undefined         -> slot index (D4)
t4-handles.mjs:275  pins the orphaned re-arm              -> PUMP.pending() === false (D7)
```

Plus a shipped node:test asserting the opposite of D3's second half:
`test/SoaParticleEngine.test.js:296` asserts `{ maxDt: Infinity }` throws a
RangeError -- inverted, not deleted. And "finite" appears as a documented
`maxDt` constraint in seven sites, all updated:
`SoaParticleEngine.js:95`, `:121`, `:150`, `SoaParticleEngine.d.ts:12`, `:32`,
`llms.txt:27`, `decisions/0002-the-door.md:67`.

## D8 -- the clock is environment input (the planner's question, which D3 did not answer)

`_loop` writes `this._lastTime = time` BEFORE the callback runs. If the clock
hands it a `NaN` or a backwards `time`, `_lastTime` is poisoned permanently:
every later frame computes `NaN`, `tick()` rejects each one, and the engine goes
SILENTLY and PERMANENTLY dead while still burning a RAF slot per frame. That is
P-28's failure shape -- fail-open into an unrecoverable state -- reintroduced
through the other door, and it must not ship in the session that exists to
delete it.

**CHOSEN:** `_loop` validates `time` and does not advance `_lastTime` on a bad
reading, so a transient bad sample self-heals and a persistently broken clock is
a visible no-op instead of a silent death:

> **LIMIT, recorded 2026-08-16 by S3 qa -- finding P-29 (S1, open).** The
> self-heal claim in the paragraph above is NARROWER than it reads, and the
> honest scope is: this guard self-heals from a `NaN` reading and from a
> BACKWARDS reading, both verified. It does NOT self-heal from a single
> anomalously large FORWARD reading. Such a reading satisfies
> `time >= this._lastTime`, is accepted as a legitimate frame, and raises
> `_lastTime` permanently; every later real-clock sample is smaller, fails the
> guard forever, and the engine goes silently and permanently dead -- the exact
> shape this decision was written to prevent, reached from the one side the
> predicate does not bound. Realistic trigger: a RAF polyfill that hands back a
> different clock basis for one frame (`Date.now()` ~1.7e12 against
> `performance.now()`'s small domain).
>
> ```js
> const e = new SoaParticleEngine(4);
> e.onTick(() => {}); e._isRunning = true; e._lastTime = 0;
> e._loop(1e15);                 // accepted; _lastTime := 1e15
> let now = 5000;                // resume a real performance.now() timeline
> for (let i = 0; i < 50; i++) { e._loop(now); now += 16; }
> // the callback never fires again
> ```
>
> NOT a regression, and this is why it is recorded rather than patched here.
> Measured against the same input under v1.0.5's unconditional-advance `_loop`:
> the next frame delivered `dt === -999999999995` to the caller's callback --
> a negative step of ~31,000 years that poisons every lane it touches, S1
> silent corruption -- and only then recovered to 0.016. S3 therefore trades
> lane corruption for a stopped loop, which is the better failure under law 4,
> but "better" is not "closed".
>
> Deliberately NOT fixed in S3. A bound on a forward reading is new policy --
> what magnitude is anomalous, and against which basis -- and inventing it
> after the reviewer approved the diff is the mid-flight scope widening that
> the S2 -> S2.1 split exists to prevent. Pinned as CURRENT behaviour in
> `test/qa-s3.test.js`, the same way `t4-handles.mjs` carried the P-26 pin into
> this session. Schedule it with S4's loop work.

```js
_loop(time) {
    if (!this._isRunning || this._destroyed) return;
    // The clock is environment input, not the engine's. `time >= _lastTime`
    // rejects NaN and a backwards clock in one comparison, and it guarantees
    // dt >= 0, so tick()'s own low-side guard can never reject a value _loop
    // produced -- the two guards compose instead of duplicating.
    if (typeof time === 'number' && time >= this._lastTime) {
        const dt = (time - this._lastTime) / 1000;
        this._lastTime = time;
        this.tick(dt);
    }
    if (this._isRunning && !this._destroyed) {
        this._rafId = requestAnimationFrame(this._loop);
    }
}
```

- **Rejected alternative:** advance `_lastTime` unconditionally ("a broken clock
  stays the caller's problem"). That was defensible while `dt` was internal; it
  is not defensible once the permanent-death path above is written down. This is
  the comment in `0002`'s P-02 section, and D8 supersedes it.
- **Rejected alternative:** gate on `tick()`'s return value. It conflates "the
  dt was rejected" with "no callback is registered", and the second case would
  freeze `_lastTime` forever while dt grew unboundedly.

Cost: two comparisons per FRAME (not per particle). Measured under T6 like
everything else, not assumed.

## Consequences

- `tick(dt)` is the documented primary API; the package runs with zero DOM.
- `start()` fails closed and stays retryable.
- `onTick` rejects non-callables at the door; the frame path can no longer throw
  for any registered value.
- `emit()` returns a receipt on every path.
- The three T4 pins and the one node:test are flipped, each with a T9 control
  that reverts the guard and fails the flipped pin.
- T5 is filled: an AoS oracle differentially checks `tick(dt)` over a seeded
  fuzz corpus that includes rejected emits.

## References

- `S3_BRIEF.md` -- the session brief and the D1..D8 shapes.
- `S3_PLAN.md` -- the atomic task decomposition.
- `decisions/0002-the-door.md` -- the door law and the `maxDt: Infinity`
  amendment (D3 second half).
- `SoaParticleEngine_ROADMAP.md` -- findings P-08, P-09, P-12, P-25..P-28.
