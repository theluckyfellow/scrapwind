import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SUN_DIRECTION } from './Sky.js';

const BLOOM_STRENGTH = 0.45;
const BLOOM_RADIUS = 0.5;
const BLOOM_THRESHOLD = 0.85; // only the sun, emissive strips and the beacon crest this
const EXPOSURE = 1.1;
const SHAFT_INTENSITY = 0.55;
const SHAFT_TAPS = 20;

// Screen-space sun shafts: a radial blur pulled from the sun's spot in the frame, so mesas, pylons
// and the ringway cut visible beams out of the glow. Fades to nothing when the sun is behind us.
const SunShaftShader = {
  uniforms: {
    tDiffuse: { value: null },
    sunUv: { value: new THREE.Vector2(0.5, 0.5) },
    intensity: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 sunUv;
    uniform float intensity;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec2 stepUv = (vUv - sunUv) * (0.9 / float(${SHAFT_TAPS}));
      vec2 sampleUv = vUv;
      float illumination = 1.0;
      vec3 shafts = vec3(0.0);
      for (int tap = 0; tap < ${SHAFT_TAPS}; tap++) {
        sampleUv -= stepUv;
        shafts += texture2D(tDiffuse, sampleUv).rgb * illumination;
        illumination *= 0.93;
      }
      gl_FragColor = vec4(base.rgb + shafts * (intensity / float(${SHAFT_TAPS})), base.a);
    }
  `,
};

// The last word on the picture: a warm-vs-cool split tone, a little contrast and saturation,
// and a soft vignette. Runs after tone mapping, so it grades the final frame like a print.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    saturation: { value: 1.09 },
    contrast: { value: 1.05 },
    splitAmount: { value: 0.045 },
    vignette: { value: 0.30 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float saturation;
    uniform float contrast;
    uniform float splitAmount;
    uniform float vignette;
    varying vec2 vUv;
    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      float luminance = dot(color, vec3(0.299, 0.587, 0.114));
      color = mix(vec3(luminance), color, saturation);
      color = (color - 0.5) * contrast + 0.5;
      // Shadows lean teal, highlights lean amber: the Gobi grade.
      color += mix(vec3(-0.4, 0.35, 0.55), vec3(0.6, 0.3, -0.35), smoothstep(0.15, 0.75, luminance)) * splitAmount;
      float edge = smoothstep(0.35, 0.85, distance(vUv, vec2(0.5)));
      color *= 1.0 - vignette * edge;
      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

/**
 * PostFX: the final look. Everything renders into the composer's buffer, bright things bloom (the sun
 * disc, emissive strips, the spire crown), the sun pulls shafts past whatever stands in front of it,
 * then one ACES filmic tone mapping, then the grade: split tone, contrast and a vignette.
 * Game points it at whichever scene and camera is active and calls render() once per frame.
 */
export class PostFX {
  composer;
  renderPass;
  bloom;
  sunShafts;
  grade;

  constructor(renderer, scene, camera) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    this.sunShafts = new ShaderPass(SunShaftShader);
    this.grade = new ShaderPass(GradeShader);
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.sunShafts);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.grade);
  }

  /** Points the passes at whichever scene and camera is being drawn (drive or garage). */
  target(scene, camera) {
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
  }

  /** Places the sun in screen space and turns the shafts on by how squarely we face it. */
  updateSun(camera) {
    const facing = camera.getWorldDirection(new THREE.Vector3()).dot(SUN_DIRECTION);
    if (facing <= 0.02) {
      this.clearSun();
      return;
    }
    const projected = camera.position.clone().addScaledVector(SUN_DIRECTION, 500).project(camera);
    const uv = new THREE.Vector2(projected.x * 0.5 + 0.5, projected.y * 0.5 + 0.5);
    this.sunShafts.uniforms.sunUv.value.copy(uv);
    // The shafts are a frame-space trick: they lie most when the sun sits near the frame's edge.
    const edge = Math.max(Math.abs(uv.x - 0.5), Math.abs(uv.y - 0.5)) * 2;
    const edgeFade = 1 - THREE.MathUtils.smoothstep(edge, 0.55, 1.15);
    const intensity = SHAFT_INTENSITY * Math.min(facing * 2, 1) * edgeFade;
    this.sunShafts.uniforms.intensity.value = intensity;
    this.sunShafts.enabled = intensity > 0.001; // 21 texture taps a pixel: skip the pass when it adds nothing
  }

  /** No sun in the workshop: the garage renders without shafts. */
  clearSun() {
    this.sunShafts.uniforms.intensity.value = 0;
    this.sunShafts.enabled = false;
  }

  setSize(width, height) {
    this.composer.setSize(width, height);
  }

  render() {
    this.composer.render();
  }
}
