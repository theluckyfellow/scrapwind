import * as THREE from 'three';

// High-noon Gobi light: a deep cyan-blue overhead, a burning amber horizon, a hard white sun.
const ZENITH_COLOR = 0x2e6ed4;
const HORIZON_COLOR = 0xffcf8e;
const BELOW_HORIZON_COLOR = 0xd99a6c;
const SUN_COLOR = 0xfff3d8;
export const SUN_DIRECTION = new THREE.Vector3(-0.55, 0.5, 0.67).normalize(); // toward the sun: behind-left of the start line
const SUN_INTENSITY = 3.0;
const SKY_FILL_COLOR = 0x9fc8f2;
const GROUND_FILL_COLOR = 0xd0905a;
const FILL_INTENSITY = 1.2;
const FOG_NEAR = 160;
const FOG_FAR = 3200;
const DOME_RADIUS = 3000;
const SHADOW_EXTENT = 70;       // m around the vehicle that gets crisp shadows
const SHADOW_MAP_SIZE = 2048;
const SUN_DISTANCE = 200;       // how far up-sun the shadow-casting light sits
// The neighbour: a vast pale moon over the north-east, close enough to show its maria. Angular
// sizes in the shader are direction-space radii; MOON_RADIUS ≈ 6°.
const MOON_DIRECTION = new THREE.Vector3(0.42, 0.4, -0.8).normalize();
const MOON_RADIUS = 0.115;
const MOON_PALE = 0xd8cfc2;
const MOON_MARIA = 0xa89a88;
const AURORA_GREEN = 0x3fe8b0;
const AURORA_VIOLET = 0x8a5fd8;

/**
 * Sky: the gradient dome with its sun disc, the sunlight and fill light, and the haze that melts the
 * horizon into the sky. Game owns one and calls follow() each frame so the sun's shadow box stays on the
 * vehicle. The dome outputs plain linear colour: tone mapping happens once, in PostFX's output pass.
 */
export class Sky {
  dome;
  sun;
  fill;

  constructor(scene) {
    scene.fog = new THREE.Fog(HORIZON_COLOR, FOG_NEAR, FOG_FAR);
    scene.background = new THREE.Color(HORIZON_COLOR);

    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 16), this.domeMaterial());
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.left = -SHADOW_EXTENT;
    shadowCamera.right = SHADOW_EXTENT;
    shadowCamera.top = SHADOW_EXTENT;
    shadowCamera.bottom = -SHADOW_EXTENT;
    shadowCamera.near = 1;
    shadowCamera.far = SUN_DISTANCE * 2.5;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.fill = new THREE.HemisphereLight(SKY_FILL_COLOR, GROUND_FILL_COLOR, FILL_INTENSITY);
    scene.add(this.fill);
  }

  /** Centres the dome on the camera and the shadow box on the point of interest. */
  follow(cameraPosition, focus) {
    this.dome.position.copy(cameraPosition);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(SUN_DIRECTION, SUN_DISTANCE);
    this.sun.target.updateMatrixWorld();
  }

  /** How far the sky has answered the waking grid, 0..1. */
  setAwakening(level) {
    this.dome.material.uniforms.uAwakening.value = level;
  }

  /** The direction of the great moon, for things aimed at it. */
  moonDirection() {
    return MOON_DIRECTION.clone();
  }

  /** Advances the slow sky animation (the aurora breathes). */
  updateTime(elapsedSeconds) {
    this.dome.material.uniforms.uTime.value = elapsedSeconds;
  }

  domeMaterial() {
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zenithColor: { value: new THREE.Color(ZENITH_COLOR) },
        horizonColor: { value: new THREE.Color(HORIZON_COLOR) },
        belowColor: { value: new THREE.Color(BELOW_HORIZON_COLOR) },
        sunColor: { value: new THREE.Color(SUN_COLOR) },
        sunDirection: { value: SUN_DIRECTION },
        moonDirection: { value: MOON_DIRECTION },
        moonRadius: { value: MOON_RADIUS },
        moonPale: { value: new THREE.Color(MOON_PALE) },
        moonMaria: { value: new THREE.Color(MOON_MARIA) },
        auroraGreen: { value: new THREE.Color(AURORA_GREEN) },
        auroraViolet: { value: new THREE.Color(AURORA_VIOLET) },
        uTime: { value: 0 },
        uAwakening: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 viewDirection;
        void main() {
          viewDirection = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 zenithColor;
        uniform vec3 horizonColor;
        uniform vec3 belowColor;
        uniform vec3 sunColor;
        uniform vec3 sunDirection;
        uniform vec3 moonDirection;
        uniform float moonRadius;
        uniform vec3 moonPale;
        uniform vec3 moonMaria;
        uniform vec3 auroraGreen;
        uniform vec3 auroraViolet;
        uniform float uTime;
        uniform float uAwakening;
        varying vec3 viewDirection;

        /** One crater: a soft bowl of maria with a thin bright rim just outside its edge. */
        void moonCrater(float pU, float pV, float cU, float cV, float radius, inout float craters, inout float rims) {
          float d = length(vec2(pU - cU, pV - cV));
          craters += smoothstep(radius, radius * 0.45, d) * 0.55;
          rims += smoothstep(radius * 1.35, radius * 1.08, d) * smoothstep(radius * 0.96, radius * 1.1, d) * 0.6;
        }

        void main() {
          vec3 direction = normalize(viewDirection);
          float height = direction.y;
          vec3 color = height > 0.0
            ? mix(horizonColor, zenithColor, smoothstep(0.0, 0.5, height))
            : mix(horizonColor, belowColor, smoothstep(0.0, -0.15, height));

          // The neighbour: a vast pale moon — a clean shaded disk with a few honest craters.
          vec3 moonDirectionN = normalize(moonDirection);
          vec3 offset = direction - moonDirectionN * dot(direction, moonDirectionN);
          vec3 tangentU = normalize(cross(moonDirectionN, vec3(0.0, 1.0, 0.0)));
          vec3 tangentV = cross(tangentU, moonDirectionN);
          float moonU = dot(offset, tangentU);
          float moonV = dot(offset, tangentV);
          float moonR = length(offset);
          // A wide faint halo: the moon hangs in the valley's dust.
          color += moonPale * pow(max(dot(direction, moonDirectionN), 0.0), 160.0) * 0.22;
          float disk = 1.0 - smoothstep(moonRadius - 0.0025, moonRadius, moonR);
          if (disk > 0.0) {
            // Shaded like a solid body: lit from the lower left, falling away across the disk.
            float lit = 0.68 + 0.32 * smoothstep(0.07, -0.07, moonU + moonV);
            float craters = 0.0;
            float rims = 0.0;
            moonCrater(moonU, moonV, -0.020, 0.016, 0.015, craters, rims);
            moonCrater(moonU, moonV, 0.030, -0.008, 0.010, craters, rims);
            moonCrater(moonU, moonV, -0.041, -0.022, 0.012, craters, rims);
            moonCrater(moonU, moonV, 0.008, -0.038, 0.018, craters, rims);
            moonCrater(moonU, moonV, 0.048, 0.028, 0.007, craters, rims);
            vec3 moonColor = mix(moonPale, moonMaria, clamp(craters, 0.0, 0.85));
            moonColor *= lit + rims * 0.4; // crater rims catch the light
            color = mix(color, moonColor, disk * 0.96);
          }

          // Aurora ribbons: slow green-violet curtains high up, breathing on a long period.
          // When the grid wakes the sky answers: the aurora floods down toward the horizon and burns bright.
          float auroraHeight = smoothstep(0.12 - 0.1 * uAwakening, 0.45 - 0.2 * uAwakening, height) * (1.0 - smoothstep(0.55 + 0.3 * uAwakening, 0.9 + 0.3 * uAwakening, height));
          float curtain = sin(direction.x * 6.0 + uTime * 0.11) * sin(direction.z * 4.5 - uTime * 0.07)
            + 0.6 * sin(direction.x * 13.0 - uTime * 0.05);
          float aurora = auroraHeight * max(curtain, 0.0) * (0.09 + 0.5 * uAwakening);
          color += mix(auroraGreen, auroraViolet, 0.5 + 0.5 * sin(direction.z * 3.0 + uTime * 0.04)) * aurora;

          float toSun = max(dot(direction, normalize(sunDirection)), 0.0);
          color += sunColor * pow(toSun, 3.0) * 0.10;                        // wide warm wash around the sun
          color += sunColor * pow(toSun, 12.0) * 0.35;                       // tight glow
          color += sunColor * pow(toSun, 60.0) * 0.9;                        // hot halo the bloom can bite
          color = mix(color, sunColor * 1.6, smoothstep(0.9985, 0.9990, toSun)); // crisp, flat sun disc
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
  }
}