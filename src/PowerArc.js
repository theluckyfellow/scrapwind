import * as THREE from 'three';

const ARC_SEGMENTS = 96;
const ARC_RADIUS = 1.1;
const ARC_LIFT = 70;            // m the arc rises above the higher crown at its middle...
const ARC_LIFT_PER_METRE = 0.08; // ...plus this much per metre of span, so long links arch high over the dunes
const GROW_SECONDS = 2.6;

/**
 * PowerArc: a link of light between two lit relays, arching high over whatever lies between them. It grows
 * from the relay that sent the power to the one that received it, then hums with pulses running along it.
 * Grid makes one per lit link and updates them each frame.
 */
export class PowerArc {
  mesh;
  growth = 0;              // 0..1 of the arc drawn so far
  intensity = 1;

  constructor(from, to, color) {
    const span = from.distanceTo(to);
    const middle = from.clone().lerp(to, 0.5);
    middle.y = Math.max(from.y, to.y) + ARC_LIFT + span * ARC_LIFT_PER_METRE;
    const curve = new THREE.QuadraticBezierCurve3(from.clone(), middle, to.clone());
    const geometry = new THREE.TubeGeometry(curve, ARC_SEGMENTS, ARC_RADIUS, 6, false);
    this.mesh = new THREE.Mesh(geometry, arcMaterial(color));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Shows the whole arc at once, for links that were already lit when the game loaded. */
  complete() {
    this.growth = 1;
    this.mesh.material.uniforms.uGrowth.value = 1;
  }

  /** Grows the arc and moves its pulses along. */
  update(elapsedSeconds, frameSeconds) {
    if (this.growth < 1) this.growth = Math.min(this.growth + frameSeconds / GROW_SECONDS, 1);
    const uniforms = this.mesh.material.uniforms;
    uniforms.uGrowth.value = 1 - (1 - this.growth) ** 2;
    uniforms.uTime.value = elapsedSeconds;
    uniforms.uIntensity.value = this.intensity;
  }
}

function arcMaterial(color) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uGrowth: { value: 0 },
      uTime: { value: 0 },
      uIntensity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vFacing;
      void main() {
        vUv = uv;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-viewPosition.xyz)));
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uGrowth;
      uniform float uTime;
      uniform float uIntensity;
      varying vec2 vUv;
      varying float vFacing;
      void main() {
        if (vUv.x > uGrowth) discard;
        float head = smoothstep(uGrowth - 0.04, uGrowth, vUv.x) * step(uGrowth, 0.999); // the bright leading edge
        float pulses = pow(0.5 + 0.5 * sin(vUv.x * 160.0 - uTime * 9.0), 6.0);
        float core = pow(vFacing, 2.0);
        float alpha = core * (0.35 + 0.65 * pulses + head * 2.0) * uIntensity;
        gl_FragColor = vec4(uColor * alpha, alpha);
      }
    `,
  });
}
