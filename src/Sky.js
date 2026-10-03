import * as THREE from 'three';

// Late-afternoon desert light: a warm low sun, a cool blue overhead and a hazy peach horizon.
const ZENITH_COLOR = 0x3f86c4;
const HORIZON_COLOR = 0xf6d3a2;
const BELOW_HORIZON_COLOR = 0xe2b07e;
const SUN_COLOR = 0xfff0d2;
const SUN_DIRECTION = new THREE.Vector3(-0.55, 0.5, 0.67).normalize(); // toward the sun: behind-left of the start line
const SUN_INTENSITY = 2.6;
const SKY_FILL_COLOR = 0xa9cdf2;
const GROUND_FILL_COLOR = 0xc98b5e;
const FILL_INTENSITY = 1.15;
const FOG_NEAR = 160;
const FOG_FAR = 1500;
const DOME_RADIUS = 3000;
const SHADOW_EXTENT = 70;       // m around the vehicle that gets crisp shadows
const SHADOW_MAP_SIZE = 2048;
const SUN_DISTANCE = 200;       // how far up-sun the shadow-casting light sits

/**
 * Sky: the gradient dome with its sun disc, the sunlight and fill light, and the fog that melts the
 * horizon into the sky. Game owns one and calls follow() each frame so the sun's shadow box stays on the vehicle.
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
        varying vec3 viewDirection;
        void main() {
          vec3 direction = normalize(viewDirection);
          float height = direction.y;
          vec3 color = height > 0.0
            ? mix(horizonColor, zenithColor, smoothstep(0.0, 0.5, height))
            : mix(horizonColor, belowColor, smoothstep(0.0, -0.15, height));
          float toSun = max(dot(direction, normalize(sunDirection)), 0.0);
          color += sunColor * pow(toSun, 12.0) * 0.35;                        // warm glow around the sun
          color = mix(color, sunColor * 1.15, smoothstep(0.9988, 0.9992, toSun)); // crisp, flat sun disc
          gl_FragColor = vec4(color, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
  }
}
