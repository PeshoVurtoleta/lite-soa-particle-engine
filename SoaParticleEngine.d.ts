export type TickCallback = (
    dt: number,
    x: Float32Array, y: Float32Array,
    vx: Float32Array, vy: Float32Array,
    life: Float32Array, invLife: Float32Array,
    data: Int32Array, max: number
) => void;

export class SoaParticleEngine {
    readonly max: number;
    x: Float32Array | null;
    y: Float32Array | null;
    vx: Float32Array | null;
    vy: Float32Array | null;
    life: Float32Array | null;
    invLife: Float32Array | null;
    data: Int32Array | null;

    constructor(maxParticles?: number);
    emit(x: number, y: number, vx: number, vy: number, life: number, dataFlag?: number): void;
    onTick(callback: TickCallback): void;
    start(): void;
    stop(): void;
    pause(): void;
    clear(): void;
    destroy(): void;
}

export default SoaParticleEngine;
