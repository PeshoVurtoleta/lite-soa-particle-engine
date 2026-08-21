# @zakkster/lite-soa-particle-engine

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-soa-particle-engine.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-soa-particle-engine)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-soa-particle-engine?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-soa-particle-engine)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-soa-particle-engine?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-soa-particle-engine)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-soa-particle-engine?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-soa-particle-engine)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

Zero-GC canvas particle system using Structure of Arrays (SoA) and flat TypedArrays.

**The fastest way to move thousands of dots on a Canvas. No objects. No GC. No mercy.**

## Live Demo (SoaParticleEngine)
https://codepen.io/Zahari-Shinikchiev/debug/gbwmWvJ

## Performance

A stamped, reproducible benchmark (machine + Node + version provenance, with a
runnable script) lands in S6. Until then this README makes no numeric performance
claim.

### Why SoA is faster

Traditional particle systems store each particle as an object: `{ x, y, vx, vy, life }`. When you loop over 10,000 particles, the CPU fetches each object from a random memory location -- **cache miss after cache miss**.

SoA stores each property in a contiguous `Float32Array`. When you loop over `x[0], x[1], x[2]...`, the data is sequential in memory -- the CPU prefetcher loads it all into L1 cache in one shot, instead of chasing a scattered object graph across the heap.

## Installation

```bash
npm install @zakkster/lite-soa-particle-engine
```

## Quick Start

```javascript
import { SoaParticleEngine } from '@zakkster/lite-soa-particle-engine';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const engine = new SoaParticleEngine(5000);

engine.onTick((dt, x, y, vx, vy, life, invLife, data, max) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < max; i++) {
        if (life[i] <= 0) continue;

        // Physics
        life[i] -= dt;
        vy[i] += 400 * dt;  // gravity
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;

        // Render
        ctx.globalAlpha = Math.max(0, life[i] * invLife[i]);
        ctx.fillRect(x[i], y[i], 4, 4);
    }
});

engine.start();

// Emit anywhere
canvas.addEventListener('click', (e) => {
    for (let i = 0; i < 50; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 100 + Math.random() * 200;
        engine.emit(e.offsetX, e.offsetY, Math.cos(angle) * speed, Math.sin(angle) * speed, 1.5);
    }
});
```

## API

### `new SoaParticleEngine(maxParticles?, options?)`

Allocates all memory once. Default: 1000 particles.

`maxParticles` must be an integer in `[1, MAX_PARTICLES]` (`MAX_PARTICLES` is
`2**24` = 16777216, exported). Anything else **throws** a named error rather than
constructing an engine that cannot work:

```javascript
new SoaParticleEngine(2.5);    // RangeError: SoaParticleEngine: maxParticles must be an integer in [1, 16777216], got 2.5
new SoaParticleEngine(0);      // RangeError -- a zero-length engine silently swallows every emit
new SoaParticleEngine('10');   // TypeError:  SoaParticleEngine: maxParticles must be a number, got string "10"
```

There is no size at which the lane allocator fails politely -- a large enough
request kills the process outright rather than throwing -- so this validation is
the only thing between a typo and a dead process. See
`decisions/0002-the-door.md`.

`options.maxDt` (default `0.1`) is the largest frame delta the loop passes to
`onTick`. It must be a finite number greater than 0 or the constructor throws.

### Methods

| Method | Description |
|--------|-------------|
| `.emit(x, y, vx, vy, life, dataFlag?)` | Emit a particle at the ring write cursor. Never throws -- silently rejects anything it cannot store (see Input Contract). When full it overwrites the slot at the cursor, alive or not (see Ring Buffer Behavior). |
| `.emitBurst(x, y, count, spec?, rng?)` | Emit a cone of `count` particles with the randomness supplied as an argument, so the spawn is replayable (see Determinism and replay). Never throws for a bad-VALUE argument (a coercing spec field -- Symbol, BigInt, throwing `valueOf` -- is rejected with `-1`); caller CODE propagates -- a throwing `rng.next()`, or a throwing accessor getter on a spec field or on `rng.next`. Returns `-1` on a door rejection or exactly `count`. |
| `.onTick(callback)` | Register the frame callback. Receives raw TypedArrays. |
| `.start()` | Start the RAF loop. |
| `.stop()` / `.pause()` | Stop the RAF loop. |
| `.clear()` | Kill all particles: zeroes the `life` lane only (see Input Contract). |
| `.destroy()` | Stop and release all TypedArray memory. |

## Input Contract

The constructor throws; `emit()` never does. That split is deliberate: the
constructor runs once and a bad argument there is a programming error worth
surfacing loudly, while `emit()` runs per particle per frame and a throw inside a
render loop is a crash.

**`emit()` silently rejects**, before touching any lane, and returns without
advancing the write cursor:

- `x`, `y`, `vx` or `vy` that is **not a number** (`typeof`), or is outside the
  symmetric f32 band `[-LANE_MAX, LANE_MAX]`. The band half covers `NaN` and both
  infinities; the type half is why **a numeric string, boolean, array or `null` is
  rejected, not coerced** -- the band uses `>=`/`<=`, which would coerce `null` to
  `0` (inside the band) or `"5"` to `5`, so without the `typeof` check an untyped
  value would be laundered into a coordinate;
- `life` that is **not a number**, or is outside `[LIFE_MIN, LIFE_MAX]`. Same two
  halves: `"1"`, `true` and `[1]` are rejected, not coerced, and the band half also
  covers `NaN`, both infinities, `0` and negatives;
- a `dataFlag` that is **not a number** (`typeof`) or is not an exact int32. The
  type half is not optional: `(dataFlag | 0)` invokes `ToNumeric`, which **throws**
  for a `BigInt` or `Symbol` and **runs caller code** (`valueOf`,
  `Symbol.toPrimitive`) for an object, so a hostile or buggy `dataFlag` is rejected
  **without throwing** only because `typeof` runs first and short-circuits before
  the `|`. `emit()` invokes no caller code on any argument.

A rejected `emit()` leaves the engine byte-identical.

`LIFE_MIN` (`2.938735964636876e-39`), `LIFE_MAX` (`3.4028235677973362e+38`) and
`LANE_MAX` (`3.4028235677973362e+38`) are exported, and all three are
**measured** f32 boundaries, not analytic ones. Below `LIFE_MIN`, `1/life`
overflows f32 and `invLife` becomes `Infinity`, making the documented
`life[i] * invLife[i]` alpha `NaN`; above `LIFE_MAX`, `life` itself stores as
`Infinity`. Both ends silently corrupted a particle in earlier versions.

`LANE_MAX` is the largest f64 that stores as a finite f32 -- one step past it,
a position or velocity would round to `Infinity`, which is permanent in a lane
and turns the caller's own physics to `NaN` on the first frame. It is
numerically equal to `LIFE_MAX` by coincidence of the shared f32 storage type,
but is a separate export: the bound comes from `Float32Array`, not from any
physical quantity, so one `LANE_MAX` covers all four lanes. Unlike the `life`
band this one is **symmetric and has no floor** -- `x`, `y`, `vx` and `vy` are
legitimately signed and nothing reciprocates them, so `0`, `-0`, ordinary
negatives and subnormals are all perfectly good coordinates and are accepted.

Because both lanes are f32, alpha at birth is `1` only to within one f32 ulp:
the measured worst case across the legal band is `|alpha - 1| = 2.31e-7`. Clamp
if you need exactly `[0, 1]`, as the Quick Start does with `Math.max`.

**Dead slots hold undefined data.** `clear()` zeroes `life` and resets the write
cursor; it does not touch `x/y/vx/vy/invLife/data`. For any slot where
`life[i] <= 0`, treat those six lanes as meaningless -- the liveness test is
`life[i] <= 0` and nothing else.

**The lanes are reassigned only by `destroy()`**, which sets all seven to `null`.
No other method replaces a lane.

**A clamped frame loses time by design.** A gap larger than `maxDt` is clamped to
`maxDt` and the excess is dropped, because the alternative is a physics step so
large that particles tunnel. This engine is therefore not a fixed-step simulator;
a caller needing an accumulator should drive the step themselves.

### The `onTick` Callback

```javascript
engine.onTick((dt, x, y, vx, vy, life, invLife, data, max) => {
    // dt: seconds since last frame, clamped to maxDt (default 0.1)
    // x, y: Float32Array positions
    // vx, vy: Float32Array velocities
    // life: Float32Array remaining life
    // invLife: Float32Array (1/initialLife) -- multiply for normalized progress
    // data: Int32Array -- recipe IDs or custom flags
    // max: array length
    //
    // MUTATE THESE DIRECTLY -- that's the whole point
});
```

### The `data` Channel

Each particle has an `Int32Array` slot for custom integer data. Use it for recipe IDs, team colors, particle types, or any per-particle flag:

```javascript
engine.emit(x, y, vx, vy, life, 1);  // type 1 = fire
engine.emit(x, y, vx, vy, life, 2);  // type 2 = smoke

engine.onTick((dt, x, y, vx, vy, life, invLife, data, max) => {
    for (let i = 0; i < max; i++) {
        if (life[i] <= 0) continue;
        if (data[i] === 1) ctx.fillStyle = 'orange';
        if (data[i] === 2) ctx.fillStyle = 'gray';
        // ...
    }
});
```

## Recipes

### Mouse Trail

```javascript
canvas.addEventListener('mousemove', (e) => {
    engine.emit(
        e.offsetX, e.offsetY,
        (Math.random() - 0.5) * 50,  // slight spread
        -50 - Math.random() * 50,     // float upward
        0.8
    );
});
```

### Rain

```javascript
function spawnRain() {
    for (let i = 0; i < 3; i++) {
        engine.emit(
            Math.random() * canvas.width,  // random X
            -10,                            // above screen
            0,                              // no horizontal velocity
            300 + Math.random() * 200,      // fast downward
            2.0                             // 2 second life
        );
    }
    requestAnimationFrame(spawnRain);
}
```

### Explosion with Multiple Types

```javascript
function explode(x, y) {
    // Core flash (type 0)
    for (let i = 0; i < 20; i++) {
        const a = Math.random() * Math.PI * 2;
        engine.emit(x, y, Math.cos(a) * 300, Math.sin(a) * 300, 0.3, 0);
    }
    // Debris (type 1)
    for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 50 + Math.random() * 150;
        engine.emit(x, y, Math.cos(a) * s, Math.sin(a) * s, 1.5, 1);
    }
}
```

The same explosion as a single `emitBurst`. The first form uses the platform PRNG
inside the caller's own loop, so two runs diverge; the second injects a seeded RNG
and replays byte-for-byte (see Determinism and replay):

```javascript
import { Random } from '@zakkster/lite-random';
const rng = new Random(12345); // any object with a `.next()` -> [0, 1) satisfies it

function explode(x, y) {
    // Core flash (type 0): a full disc, fast, short-lived.
    engine.emitBurst(x, y, 20, { speed: 300, angle: 0, angleVar: Math.PI, life: 0.3, data: 0 }, rng);
    // Debris (type 1): a full disc, speed 50..200, longer-lived.
    engine.emitBurst(x, y, 40, { speed: 125, speedVar: 75, angle: 0, angleVar: Math.PI, life: 1.5, data: 1 }, rng);
}
```

## Ring Buffer Behavior

`emit()` writes at an internal write cursor and advances it by one, wrapping at `max`. When the pool is full it overwrites the slot at the cursor **whether or not that slot is still alive** -- it does not search for the oldest or a dead slot. With mixed lifetimes the cursor slot is frequently not the oldest particle, so a long-lived particle can be overwritten while dead slots sit free. The upside is bounded, allocation-free, GC-free behaviour under extreme load: emission never crashes and never stalls the frame. A liveness-aware overwrite policy is planned (tracked as finding P-01); until it ships, the write-cursor overwrite above is the exact documented contract.

## Determinism and replay

`emitBurst` takes its randomness as an argument, which is what makes a scene
replayable. The contract, and its three bounds, live in one paragraph so nobody
trusts the claim without the caveats: given a **fresh** engine, an identical
emit/tick script, and an RNG replaying the same seed, every lane is byte-identical
across runs and across machines -- but (1) `clear()` is **not** a replay reset: it
zeroes the `life` lane and the write cursor and leaves `x/y/vx/vy/data` from the
previous scene, so a shorter replay after `clear()` matches a fresh engine only
where it happens to overwrite (construct a new engine to replay); (2) parity comes
from **seed** parity, not from sharing one `Random` instance -- two engines sharing
one instance interleave their draws and both diverge, while two instances seeded
alike replay identically; and (3) **f32 storage is the equality domain** -- lanes
compare as stored (f32 for the six float lanes, i32 for `data`), never as the f64
the caller passed. Each `emitBurst` particle draws exactly three RNG values, in the
order `angle, speed, life`, unconditionally -- so the stream is independent of ring
occupancy and a replay survives a full pool.

## TypeScript

```typescript
import { SoaParticleEngine, type TickCallback } from '@zakkster/lite-soa-particle-engine';

const tick: TickCallback = (dt, x, y, vx, vy, life, invLife, data, max) => {
    // fully typed Float32Array/Int32Array access
};
```

## License

MIT
