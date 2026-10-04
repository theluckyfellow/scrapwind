import * as THREE from 'three';

const STRANDS = 3;
const STRAND_POINTS = 16;
const JITTER = 0.9;              // m of zig-zag at full charging rate
const BOW = 3;                   // m the spark bows upward at its middle
const BEADS = 22;                // soft points of glow strung along the spark
const BEAD_SIZE = 2.4;           // m across one bead
const FLARE_SIZE = 6;            // m across the flares where the spark meets the vehicle and the crown
const MAX_POINT_PIXELS = 512;
const COLOR = 0xbffcff;

/**
 * ChargeSpark: the crackling stream of charge between a vehicle and the relay crown it is feeding. A few
 * jagged strands, redrawn every frame, wrapped in beads of soft glow so it still reads from far off,
 * where a one-pixel line would vanish. Grid shows it while a relay is drinking and hides it otherwise.
 */
export class ChargeSpark {
  group = new THREE.Group();
  strands;                       // THREE.LineSegments: every strand in one draw
  glow;                          // THREE.Points: the beads and the two end flares
  path = Array.from({ length: STRAND_POINTS }, () => new THREE.Vector3());

  constructor() {
    const strandGeometry = new THREE.BufferGeometry();
    strandGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STRANDS * (STRAND_POINTS - 1) * 2 * 3), 3));
    this.strands = new THREE.LineSegments(strandGeometry, new THREE.LineBasicMaterial({
      color: COLOR, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));

    const glowCount = BEADS + 2;
    const glowGeometry = new THREE.BufferGeometry();
    glowGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(glowCount * 3), 3));
    glowGeometry.setAttribute('size', new THREE.BufferAttribute(new Float32Array(glowCount), 1));
    glowGeometry.setAttribute('brightness', new THREE.BufferAttribute(new Float32Array(glowCount), 1));
    this.glow = new THREE.Points(glowGeometry, glowMaterial(COLOR));
    // Point sizes are in pixels, so the shader needs the height of whatever it is drawing into.
    const viewport = new THREE.Vector4();
    this.glow.onBeforeRender = renderer => {
      renderer.getCurrentViewport(viewport);
      this.glow.material.uniforms.uViewportHeight.value = viewport.w;
    };

    for (const part of [this.strands, this.glow]) {
      part.frustumCulled = false;
      part.renderOrder = 3;
      this.group.add(part);
    }
    this.group.visible = false;
  }

  hide() {
    this.group.visible = false;
  }

  /** Redraws the spark between two points; a higher rate (0..1) makes it wilder and brighter. */
  show(from, to, rate) {
    this.group.visible = true;
    for (let index = 0; index < STRAND_POINTS; index++) {
      const t = index / (STRAND_POINTS - 1);
      this.path[index].lerpVectors(from, to, t);
      this.path[index].y += Math.sin(t * Math.PI) * BOW;
    }

    const sway = JITTER * (0.4 + rate);
    const strandPositions = this.strands.geometry.attributes.position;
    const point = new THREE.Vector3();
    const previous = new THREE.Vector3();
    let vertex = 0;
    for (let strand = 0; strand < STRANDS; strand++) {
      const wildness = strand === 0 ? 1 : 1.8;   // the first strand is the trunk, the others fork about it
      for (let index = 0; index < STRAND_POINTS; index++) {
        point.copy(this.path[index]);
        if (index > 0 && index < STRAND_POINTS - 1) point.add(randomOffset(sway * wildness));
        if (index > 0) {
          strandPositions.setXYZ(vertex++, previous.x, previous.y, previous.z);
          strandPositions.setXYZ(vertex++, point.x, point.y, point.z);
        }
        previous.copy(point);
      }
    }
    strandPositions.needsUpdate = true;

    const attributes = this.glow.geometry.attributes;
    for (let bead = 0; bead < BEADS; bead++) {
      this.pointAlong(Math.random(), point).add(randomOffset(sway * 0.6));
      attributes.position.setXYZ(bead, point.x, point.y, point.z);
      attributes.size.setX(bead, BEAD_SIZE * (0.5 + Math.random() * 0.9) * (0.6 + 0.4 * rate));
      attributes.brightness.setX(bead, 0.25 + Math.random() * 0.6);
    }
    for (const [slot, end] of [[BEADS, from], [BEADS + 1, to]]) {
      attributes.position.setXYZ(slot, end.x, end.y, end.z);
      attributes.size.setX(slot, FLARE_SIZE * (0.8 + Math.random() * 0.4));
      attributes.brightness.setX(slot, 0.8 + Math.random() * 0.2);
    }
    attributes.position.needsUpdate = true;
    attributes.size.needsUpdate = true;
    attributes.brightness.needsUpdate = true;
  }

  /** A point a fraction of the way along the spark's bowed centre line. */
  pointAlong(fraction, target) {
    const scaled = fraction * (STRAND_POINTS - 1);
    const index = Math.min(Math.floor(scaled), STRAND_POINTS - 2);
    return target.lerpVectors(this.path[index], this.path[index + 1], scaled - index);
  }
}

function randomOffset(size) {
  return new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(size * 2);
}

/** Soft round points sized in metres, not pixels, so the glow shrinks with distance like the rest of the world. */
function glowMaterial(color) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) }, uViewportHeight: { value: 600 } },
    vertexShader: /* glsl */ `
      attribute float size;
      attribute float brightness;
      uniform float uViewportHeight;
      varying float vBrightness;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = min(size * projectionMatrix[1][1] * 0.5 * uViewportHeight / -viewPosition.z, ${MAX_POINT_PIXELS.toFixed(1)});
        vBrightness = brightness;
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vBrightness;
      void main() {
        float fromCentre = length(gl_PointCoord - 0.5) * 2.0;
        float alpha = pow(max(1.0 - fromCentre, 0.0), 2.2) * vBrightness;
        gl_FragColor = vec4(uColor * alpha, alpha);
      }
    `,
  });
}
