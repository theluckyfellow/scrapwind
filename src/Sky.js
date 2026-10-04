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
// The neighbour: a vast moon over the north-east, lit by the same sun as the valley, so it hangs gibbous
// with its terminator facing away from the sun. Angular sizes in the shader are direction-space radii;
// MOON_RADIUS ≈ 6.6°. Its seas are noise on the sphere, its craters are lit by the sun's actual angle,
// and an old network of lines across it wakes teal with the grid.
export const MOON_DIRECTION = new THREE.Vector3(0.42, 0.4, -0.8).normalize();
export const MOON_RADIUS = 0.115;
export const MOON_PALE = 0xe6ddd0;
export const MOON_MARIA = 0x9c9088;
const MOON_INK = 0x2a1f1a;
const MOON_GRID = 0x5ff0e0;
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
        moonInk: { value: new THREE.Color(MOON_INK) },
        moonGrid: { value: new THREE.Color(MOON_GRID) },
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
        uniform vec3 moonInk;
        uniform vec3 moonGrid;
        uniform vec3 auroraGreen;
        uniform vec3 auroraViolet;
        uniform float uTime;
        uniform float uAwakening;
        varying vec3 viewDirection;

        float hash31(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }

        float noise3(vec3 x) {
          vec3 i = floor(x);
          vec3 f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x), mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
            mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x), mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y),
            f.z);
        }

        float fbm3(vec3 p) {
          float sum = 0.0;
          float amplitude = 0.5;
          for (int octave = 0; octave < 5; octave++) {
            sum += amplitude * noise3(p);
            p = p * 2.03 + 17.1;
            amplitude *= 0.5;
          }
          return sum;
        }

        /**
         * One crater at disk position c (radius in disk units) on the moon-local unit sphere: its far inner
         * wall catches the sun, its near inner wall and floor fall into shadow, and its outer rim lights up
         * on the sun's side. light is the sun's direction in the same moon-local frame.
         */
        float moonCrater(vec3 p, vec2 c, float radius, vec3 light) {
          vec3 centre = vec3(c, sqrt(max(1.0 - dot(c, c), 0.0)));
          float d = length(p - centre) / radius;
          if (d > 1.4) return 0.0;
          vec3 outward = normalize(p - centre * dot(p, centre) + 1e-5);
          vec3 sunAcross = normalize(light - centre * dot(light, centre) + 1e-5);
          float side = dot(outward, sunAcross);
          float bowl = 1.0 - smoothstep(0.7, 1.0, d);
          float rim = smoothstep(0.85, 1.0, d) * (1.0 - smoothstep(1.0, 1.4, d));
          return bowl * (-side * 0.36 - 0.1) + rim * side * 0.3;
        }

        void main() {
          vec3 direction = normalize(viewDirection);
          float height = direction.y;
          vec3 color = height > 0.0
            ? mix(horizonColor, zenithColor, smoothstep(0.0, 0.5, height))
            : mix(horizonColor, belowColor, smoothstep(0.0, -0.15, height));

          // The neighbour: a sphere lit by the valley's own sun, drawn in two toon tones with an ink limb.
          vec3 moonAxis = normalize(moonDirection);
          vec3 tangentU = normalize(cross(moonAxis, vec3(0.0, 1.0, 0.0)));
          vec3 tangentV = cross(tangentU, moonAxis);
          vec2 disk = vec2(dot(direction, tangentU), dot(direction, tangentV)) / moonRadius;
          float diskR = length(disk);
          float facing = dot(direction, moonAxis);
          // A wide faint halo: the moon hangs in the valley's dust.
          color += moonPale * pow(max(facing, 0.0), 160.0) * 0.18;
          if (diskR < 1.0 && facing > 0.0) {
            // Moon-local frame: x, y across the disk, z toward the viewer. The surface normal in the world
            // points back at us at the centre and sideways at the limb.
            vec3 p = vec3(disk, sqrt(1.0 - diskR * diskR));
            vec3 normal = disk.x * tangentU + disk.y * tangentV - p.z * moonAxis;
            vec3 sun = normalize(sunDirection);
            vec3 light = vec3(dot(sun, tangentU), dot(sun, tangentV), -dot(sun, moonAxis));
            float lambert = dot(normal, sun);

            float seas = smoothstep(0.5, 0.6, fbm3(p * 1.7 + vec3(3.1, 0.7, 5.3)));
            float mottle = fbm3(p * 9.0) - 0.5;
            vec3 albedo = mix(moonPale, moonMaria, seas * 0.8) * (1.0 + mottle * 0.18);
            float relief = 0.0;
            relief += moonCrater(p, vec2(-0.22, 0.30), 0.16, light);
            relief += moonCrater(p, vec2(0.40, 0.12), 0.10, light);
            relief += moonCrater(p, vec2(-0.52, -0.30), 0.13, light);
            relief += moonCrater(p, vec2(0.08, -0.36), 0.22, light);
            relief += moonCrater(p, vec2(0.55, 0.45), 0.07, light);
            relief += moonCrater(p, vec2(-0.05, 0.70), 0.09, light);
            relief += moonCrater(p, vec2(0.66, -0.30), 0.12, light);
            relief += moonCrater(p, vec2(-0.75, 0.25), 0.08, light);
            relief += moonCrater(p, vec2(0.25, 0.48), 0.05, light);
            // One young crater throws bright rays across half the face.
            vec2 young = vec2(0.30, -0.52);
            relief += moonCrater(p, young, 0.06, light);
            vec2 fromYoung = disk - young;
            float rayAngle = atan(fromYoung.y, fromYoung.x);
            float rayReach = 0.35 + 0.45 * noise3(vec3(rayAngle * 2.0, 4.0, 1.0));
            float rays = pow(abs(sin(rayAngle * 4.5 + 1.3 * sin(rayAngle * 3.0))), 5.0)
              * (1.0 - smoothstep(0.08, rayReach, length(fromYoung))) * smoothstep(0.05, 0.1, length(fromYoung));
            albedo += moonPale * rays * 0.16;
            albedo *= 1.0 + relief;

            // Two toon tones and a soft terminator, a touch of limb darkening.
            float day = smoothstep(-0.03, 0.06, lambert);
            float tone = mix(0.8, 1.06, smoothstep(0.3, 0.38, lambert));
            vec3 lit = albedo * tone * (0.86 + 0.14 * p.z);
            // In daylight the night side is only a little darker than the sky behind it.
            vec3 night = color * 0.8 + moonMaria * 0.05 * (1.0 - seas);
            vec3 moonColor = mix(night, lit, day);

            // The moon's own dead grid: fine lines that wake teal when the valley's grid is whole.
            float lines = 1.0 - abs(noise3(p * 7.0 + 11.0) * 2.0 - 1.0);
            lines = smoothstep(0.93, 0.985, lines) * (0.4 + 0.6 * seas);
            moonColor += moonGrid * lines * uAwakening * (1.6 - day);

            // An ink line around the limb, as everything in the valley wears.
            moonColor = mix(moonColor, moonInk, smoothstep(0.955, 0.98, diskR) * 0.55);
            color = mix(color, moonColor, 1.0 - smoothstep(0.985, 1.0, diskR));
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