import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { toonMesh, toonMaterial } from './toon.js';

const MAST_HEIGHT = 15;
const CROWN_RADIUS = 1.8;
const PLATE_RADIUS = 4.2;
const BEAM_RADIUS = 4;
const BEAM_HEIGHT = 1400;
const SHOCKWAVE_SECONDS = 2.2;
const SHOCKWAVE_REACH = 260;      // m the light ring races out across the ground
const DORMANT_PULSE_PERIOD = 2.4; // seconds
const RUST = 0x5a4a44;
const IRON = 0x34393d;
const LIVE = 0x5ff0e0;
const WAITING = 0xffb13a;

/**
 * Relay: one node of the valley's dead power grid. A chunky pylon with a coil crown and a charging plate
 * in front of it, in one of three states: dark (no power can reach it yet), waiting (a lit neighbour
 * means it can be woken; its crown pulses amber) or lit (crown blazing, a column of light into the sky,
 * and its plate a charging station). Grid owns the relays, decides their states and feeds them charge;
 * a Relay only knows how to look and where its plate is. Parts that change (crown, plate glow, beam,
 * shockwave) carry userData.dynamic, so Grid can merge everything else across all relays.
 */
export class Relay {
  definition;            // { id, name, title, cost, perch } from Grid's table
  station;               // THREE.Vector3: centre of the charging plate (where a vehicle parks)
  crownTop;              // THREE.Vector3: the top of the coil, where arcs leave from
  state = 'dark';        // 'dark' | 'waiting' | 'lit'
  group = new THREE.Group();
  crown;
  plateGlow;
  beam;
  shockwave;
  shockwaveAge = Infinity;

  constructor(definition, station, towerOffset, world) {
    this.definition = definition;
    this.station = station.clone();
    const tower = station.clone().add(towerOffset);
    this.crownTop = tower.clone().add(new THREE.Vector3(0, MAST_HEIGHT + CROWN_RADIUS * 1.6, 0));
    this.buildTower(tower);
    this.buildPlate();
    this.buildBeam(tower);
    this.buildShockwave();
    // The mast is solid: drive into it and you stop.
    world.createCollider(RAPIER.ColliderDesc.cylinder(MAST_HEIGHT / 2, 0.9)
      .setTranslation(tower.x, tower.y + MAST_HEIGHT / 2, tower.z));
    this.setState('dark');
  }

  id() { return this.definition.id; }
  isLit() { return this.state === 'lit'; }

  /** Dark, waiting or lit: sets the crown, plate and beam to match. */
  setState(state) {
    this.state = state;
    this.beam.visible = state === 'lit';
    this.plateGlow.visible = state === 'lit';
    const color = state === 'lit' ? LIVE : state === 'waiting' ? WAITING : IRON;
    this.crown.material.color.set(color);
    this.crown.material.emissive.set(state === 'dark' ? 0x000000 : color);
  }

  /** Sets off the light ring that races across the ground when the relay wakes. */
  celebrate() {
    this.shockwaveAge = 0;
    this.shockwave.visible = true;
  }

  /** Animates the crown pulse, the beam's slow bands and the shockwave; Grid calls this each frame. */
  update(elapsedSeconds, frameSeconds, charging) {
    if (this.state === 'waiting') {
      const pulse = 0.5 + 0.5 * Math.sin((elapsedSeconds / DORMANT_PULSE_PERIOD) * Math.PI * 2);
      this.crown.material.emissiveIntensity = charging ? 2.5 + Math.random() * 1.5 : 0.4 + pulse * 1.4;
    } else if (this.state === 'lit') {
      this.crown.material.emissiveIntensity = 2.2 + 0.4 * Math.sin(elapsedSeconds * 3);
      this.beam.material.uniforms.uTime.value = elapsedSeconds;
    }
    if (this.shockwaveAge < SHOCKWAVE_SECONDS) {
      this.shockwaveAge += frameSeconds;
      const progress = Math.min(this.shockwaveAge / SHOCKWAVE_SECONDS, 1);
      const eased = 1 - (1 - progress) ** 3;
      this.shockwave.scale.setScalar(1 + eased * SHOCKWAVE_REACH);
      this.shockwave.material.opacity = 0.85 * (1 - progress);
      if (progress >= 1) this.shockwave.visible = false;
    }
  }

  /** Is this point parked on the plate (close across, and not far above or below)? */
  covers(position) {
    return Math.hypot(position.x - this.station.x, position.z - this.station.z) < PLATE_RADIUS + 1.5
      && Math.abs(position.y - this.station.y) < 4;
  }

  buildTower(tower) {
    const parts = [
      // A squat hex plinth, a three-sided lattice mast, insulator bells and the coil crown.
      [new THREE.CylinderGeometry(1.6, 2.1, 1.2, 6), RUST, 0.6],
      [new THREE.CylinderGeometry(0.35, 1.1, MAST_HEIGHT, 3), IRON, MAST_HEIGHT / 2 + 1.2],
    ];
    for (const [geometry, color, height] of parts) {
      const mesh = toonMesh(geometry, color, { outline: 0.06 });
      mesh.position.set(tower.x, tower.y + height, tower.z);
      this.group.add(mesh);
    }
    for (let index = 0; index < 3; index++) {
      const bell = toonMesh(new THREE.CylinderGeometry(0.25, 0.55, 0.7, 8), 0xe8e4d8, { outline: 0.03 });
      const angle = (index / 3) * Math.PI * 2;
      bell.position.set(tower.x + Math.cos(angle) * 0.9, tower.y + MAST_HEIGHT - 2.5, tower.z + Math.sin(angle) * 0.9);
      this.group.add(bell);
    }
    const arm = toonMesh(new THREE.BoxGeometry(5, 0.3, 0.3), IRON, { outline: 0.03 });
    arm.position.set(tower.x, tower.y + MAST_HEIGHT - 3.2, tower.z);
    this.group.add(arm);
    this.crown = toonMesh(new THREE.TorusGeometry(CROWN_RADIUS, 0.45, 8, 20).rotateX(Math.PI / 2), IRON, {
      outline: 0.05,
      material: toonMaterial(IRON, { emissive: 0x000000 }),
    });
    this.crown.position.set(tower.x, tower.y + MAST_HEIGHT + 1.4, tower.z);
    this.crown.userData.dynamic = true;
    this.group.add(this.crown);
    const core = toonMesh(new THREE.IcosahedronGeometry(0.8, 0), 0xe8e4d8, { outline: 0.04 });
    core.position.set(tower.x, tower.y + MAST_HEIGHT + 1.4, tower.z);
    this.group.add(core);
  }

  buildPlate() {
    const plate = toonMesh(new THREE.CylinderGeometry(PLATE_RADIUS, PLATE_RADIUS * 1.06, 0.14, 6), 0x2f3a3c, { outline: 0.04 });
    plate.position.set(this.station.x, this.station.y + 0.07, this.station.z);
    this.group.add(plate);
    this.plateGlow = new THREE.Mesh(
      new THREE.TorusGeometry(PLATE_RADIUS * 0.85, 0.12, 6, 32).rotateX(Math.PI / 2),
      toonMaterial(LIVE, { emissive: LIVE, emissiveIntensity: 1.6 }),
    );
    this.plateGlow.position.set(this.station.x, this.station.y + 0.17, this.station.z);
    this.plateGlow.userData.dynamic = true;
    this.group.add(this.plateGlow);
  }

  /** A soft column of light, brightest along its middle, banded and fading as it climbs. */
  buildBeam(tower) {
    const geometry = new THREE.CylinderGeometry(BEAM_RADIUS, BEAM_RADIUS, BEAM_HEIGHT, 16, 1, true);
    geometry.translate(0, BEAM_HEIGHT / 2, 0);
    this.beam = new THREE.Mesh(geometry, beamMaterial(LIVE));
    this.beam.position.set(tower.x, tower.y + MAST_HEIGHT + 1.4, tower.z);
    this.beam.frustumCulled = false;
    this.beam.renderOrder = 2;
    this.group.add(this.beam);
  }

  buildShockwave() {
    this.shockwave = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: LIVE, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    );
    this.shockwave.position.set(this.station.x, this.station.y + 0.6, this.station.z);
    this.shockwave.visible = false;
    this.shockwave.userData.dynamic = true;
    this.group.add(this.shockwave);
  }
}

/** The light-column shader, shared by relay beams and the Spire's beam. */
export function beamMaterial(color, brightness = 1) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uBrightness: { value: brightness } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vFacing;
      void main() {
        vUv = uv;
        vec3 viewNormal = normalize(normalMatrix * normal);
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vFacing = abs(dot(viewNormal, normalize(-viewPosition.xyz)));
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uBrightness;
      varying vec2 vUv;
      varying float vFacing;
      void main() {
        float core = pow(vFacing, 3.0);                                 // bright down the middle, soft at the edges
        float climb = 1.0 - smoothstep(0.05, 1.0, vUv.y);              // fades as it rises
        float base = smoothstep(0.0, 0.004, vUv.y);                    // no hard foot
        float bands = 0.8 + 0.2 * sin(vUv.y * 140.0 - uTime * 3.0);    // slow bands of energy rising
        float alpha = core * climb * base * bands * 0.55 * uBrightness;
        gl_FragColor = vec4(uColor * alpha, alpha);
      }
    `,
  });
}
