import * as THREE from 'three';

const MAX_PARTICLES = 800;
const DUST_RATE = 80;        // particles per second at full intensity
const SPARK_RATE = 140;
const DUST_GRAVITY = -0.5;  // m/s²; dust hangs
const SPARK_GRAVITY = -5;
const DUST_DRAG = 1.8;       // 1/s
const SPARK_DRAG = 2.5;

/**
 * Dust: a pool of soft round puffs for everything the desert throws up. Tyres billow it on loose ground
 * and in slides, rotors blow it out in a ring when flying low, and the capacitors crackle cyan sparks
 * while boost is live. Game feeds it sources ({ point, color, intensity, spark, velocity }); it owns the
 * points, moves and ages them, and hides whatever has died. Purely visual: no physics, no collisions.
 */
export class Dust {
  points;
  cursor = 0;                      // next slot to use, round-robin
  positions;                        // Float32Array, MAX_PARTICLES × 3
  velocities;
  ages;                            // seconds lived
  lifetimes;
  sizes;
  alphas;
  tints;                           // Float32Array, MAX_PARTICLES × 3

  constructor(scene) {
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.velocities = new Float32Array(MAX_PARTICLES * 3);
    this.ages = new Float32Array(MAX_PARTICLES).fill(1e9); // everything starts long dead
    this.lifetimes = new Float32Array(MAX_PARTICLES).fill(1);
    this.sizes = new Float32Array(MAX_PARTICLES);
    this.alphas = new Float32Array(MAX_PARTICLES);
    this.tints = new Float32Array(MAX_PARTICLES * 3);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));
    geometry.setAttribute('tint', new THREE.BufferAttribute(this.tints, 3));

    this.points = new THREE.Points(geometry, this.dustMaterial());
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  /** Spawns from one source for this frame: dt seconds of emission at the source's intensity. */
  emit(source, dt) {
    if (source.intensity <= 0.05) return;
    const spark = Boolean(source.spark);
    const rate = spark ? SPARK_RATE : DUST_RATE;
    let count = source.intensity * rate * dt;
    count = Math.floor(count) + (Math.random() < count % 1 ? 1 : 0);
    const color = new THREE.Color(source.color);
    const drift = source.velocity ?? ZERO;
    for (let index = 0; index < count; index++) {
      const slot = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      const spread = spark ? 0.12 : THREE.MathUtils.lerp(0.15, 0.45, Math.random());
      this.positions[slot * 3] = source.point.x + (Math.random() - 0.5) * spread;
      this.positions[slot * 3 + 1] = source.point.y + Math.random() * spread * 0.4;
      this.positions[slot * 3 + 2] = source.point.z + (Math.random() - 0.5) * spread;
      const speed = spark ? 0.35 : 0.3;
      this.velocities[slot * 3] = drift.x * 0.3 + (Math.random() - 0.5) * speed * 3;
      this.velocities[slot * 3 + 1] = drift.y * 0.3 + (spark ? Math.random() * 1.5 : THREE.MathUtils.lerp(0.5, 2.0, Math.random()));
      this.velocities[slot * 3 + 2] = drift.z * 0.3 + (Math.random() - 0.5) * speed * 3;
      this.ages[slot] = 0;
      this.lifetimes[slot] = spark ? THREE.MathUtils.lerp(0.12, 0.3, Math.random()) : THREE.MathUtils.lerp(0.7, 1.5, Math.random());
      this.sizes[slot] = spark ? THREE.MathUtils.lerp(0.08, 0.2, Math.random()) : THREE.MathUtils.lerp(0.5, 1.3, Math.random());
      const tint = spark ? color.clone().lerp(WHITE, Math.random() * 0.5) : color.clone().offsetHSL(0, 0, (Math.random() - 0.5) * 0.1);
      this.tints[slot * 3] = tint.r;
      this.tints[slot * 3 + 1] = tint.g;
      this.tints[slot * 3 + 2] = tint.b;
    }
  }

  /** Moves, fades and grows the live particles; call once per frame. */
  update(dt) {
    for (let slot = 0; slot < MAX_PARTICLES; slot++) {
      const age = this.ages[slot] + dt;
      if (age > this.lifetimes[slot]) {
        if (this.alphas[slot] !== 0) {
          this.alphas[slot] = 0;
          this.points.geometry.attributes.alpha.needsUpdate = true;
        }
        continue;
      }
      this.ages[slot] = age;
      const spark = this.sizes[slot] < 0.3;
      const drag = Math.exp(-(spark ? SPARK_DRAG : DUST_DRAG) * dt);
      this.velocities[slot * 3] *= drag;
      this.velocities[slot * 3 + 1] = this.velocities[slot * 3 + 1] * drag + (spark ? SPARK_GRAVITY : DUST_GRAVITY) * dt;
      this.velocities[slot * 3 + 2] *= drag;
      this.positions[slot * 3] += this.velocities[slot * 3] * dt;
      this.positions[slot * 3 + 1] += this.velocities[slot * 3 + 1] * dt;
      this.positions[slot * 3 + 2] += this.velocities[slot * 3 + 2] * dt;
      const remaining = 1 - age / this.lifetimes[slot];
      this.alphas[slot] = Math.pow(remaining, 1.5) * (spark ? 0.95 : 0.55);
      if (!spark) this.sizes[slot] += dt * 0.55; // dust clouds swell as they settle
    }
    for (const name of ['position', 'size', 'alpha', 'tint']) {
      this.points.geometry.attributes[name].needsUpdate = true;
    }
  }

  dustMaterial() {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float alpha;
        attribute vec3 tint;
        varying float vAlpha;
        varying vec3 vTint;
        void main() {
          vAlpha = alpha;
          vTint = tint;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (240.0 / max(-mvPosition.z, 0.1));
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vTint;
        void main() {
          float distance = length(gl_PointCoord - vec2(0.5));
          float a = smoothstep(0.5, 0.12, distance) * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vTint, a);
        }
      `,
    });
  }
}

const ZERO = new THREE.Vector3();
const WHITE = new THREE.Color(0xffffff);