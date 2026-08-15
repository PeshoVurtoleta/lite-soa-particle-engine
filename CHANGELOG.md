# Changelog

All notable changes to `@zakkster/lite-soa-particle-engine` are documented here.
The format follows Keep a Changelog; this project uses semantic versioning.

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
