import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toonMesh, toonMaterial, faceted, addOutline } from './toon.js';
import { SUN_DIRECTION, MOON_DIRECTION, MOON_RADIUS, MOON_PALE } from './Sky.js';

/** Ground types: grip multiplies the tyre's grip; rolling resistance is a fraction of the tyre's load; loose ground favours paddle and knobbly tyres. */
export const SURFACES = {
  dirt: { name: 'Gobi gravel', grip: 1.0, rollingResistance: 0.02, color: 0xc9a06b },
  road: { name: 'Hardpan road', grip: 1.08, rollingResistance: 0.014, color: 0x8a6a44 },
  water: { name: 'Shallow water', grip: 0.6, rollingResistance: 0.06, color: 0x8fd8d0, loose: true },
  sand: { name: 'Dune sand', grip: 0.72, rollingResistance: 0.07, color: 0xf0cf8f, loose: true },
  mud: { name: 'Oasis mud', grip: 0.45, rollingResistance: 0.1, color: 0x6e4c35, loose: true },
  salt: { name: 'Salt crust', grip: 0.95, rollingResistance: 0.015, color: 0xe8e0d0 },
  rock: { name: 'Red rock', grip: 1.1, rollingResistance: 0.012, color: 0xa85848 },
  concrete: { name: 'Concrete', grip: 1.05, rollingResistance: 0.012, color: 0xcfc3ae },
  metal: { name: 'Scrap metal', grip: 0.85, rollingResistance: 0.012, color: 0x7d8a8c },
};

// World shape: a 6 km valley, one through-line. The home basin (the Yard and its playground) sits
// south-centre; a dune sea rolls away west; a salt pan and the dish field lie east; meadows and
// marsh dips soften the south; and a winding red-rock canyon — the old trade road, marked by dead
// pylons, watchtowers and banners — climbs north to the Spire, the landmark you can always see.
// Mountains ring the whole valley. Regions blend by smooth masks; each is about one kind of driving.
const WORLD = {
  size: 6000, cells: 400,          // 15 m facets: region-scale forms, proving-ground detail lives in meshes
  basinRadius: 380,                // dead-flat home ground around the start
  duneSea: { start: 500, full: 1000, height: 42, wavelength: 520 },   // west: sharp-crested ridges
  salt: { center: [1300, 300], radius: 650, height: 0.5 },            // east: the pan
  canyon: { start: -500, full: -1800, width: 90, wallBase: 30, wallFull: 130, floorRise: 26 }, // the road north
  east: { start: 700, full: 1200, height: 14 },                       // rolling ground out to the dish field
  south: { start: 600, full: 1100 },                                  // meadows and marsh dips
  rimStart: 2500, rimFull: 3000, rimHeight: 260,                      // the valley wall
};
const YARDANGS = { center: [-190, -160], radii: [130, 90], height: 7 };  // ridges run east–west
const SEED = 20261003;

// The still places: shallow pools that answer the sky. The Sky Listeners hear it; these remember it.
const POOLS = [
  { at: [1290, 360], radius: 42, stretch: 1.7, heading: 0.4 },   // the salt pan's mirror, by Salt Heart
  { at: [58, 118], radius: 26, stretch: 1.3, heading: -0.7 },    // by the Yard Relay, for the settlement
  { at: [-140, 96], radius: 20, stretch: 1.0, heading: 1.2 },    // out on the west gravel, alone
  { at: [30, 645], radius: 30, stretch: 1.8, heading: 0.2 },     // a long pool in the southern meadows
];
const CIRRUS_COUNT = 14;

// Feature layout. Positions are [x, z] in metres; the start line is at [0, 30] facing north (−Z).
// Ramps rise toward the north, low edge at `at`, steepening from left to right.
const RAMPS = [
  { at: [-36, -40], angleDegrees: 10, length: 14, width: 8 },
  { at: [-12, -40], angleDegrees: 16, length: 14, width: 8 },
  { at: [12, -40], angleDegrees: 22, length: 13, width: 8 },
  { at: [36, -40], angleDegrees: 30, length: 10, width: 8 },
];
const GAP_JUMPS = [
  { at: [-95, -10], takeoffAngleDegrees: 18, takeoffLength: 14, gap: 18, landingLength: 26, width: 9 },
];
const TABLE_TOPS = [
  { at: [95, -10], rampLength: 12, height: 3.5, topLength: 16, width: 10 },
];
const BOWL = { center: [125, 95], innerRadius: 26, width: 18, height: 9, backSlope: 20, segments: 96, radialSteps: 8 };
const WASHBOARD = { at: [-135, 60], length: 72, width: 10, spacing: 2.4, bumpHeight: 0.22, bumpRadius: 0.6 };
const SURFACE_LANES = { startZ: 62, length: 95, width: 16, lanes: [['concrete', -27], ['sand', -9], ['salt', 9], ['rock', 27]] };
const START_PAD = { at: [0, 30], size: 24 };
const GROUND_PADS = [{ at: [55, 25], radius: 5 }, { at: [-55, 25], radius: 5 }];
const MESAS = [
  { name: 'yardangMesa', at: [-210, -170], radius: 24, height: 28, sides: 9, pad: true },
  { name: 'watcherMesa', at: [70, -290], radius: 13, height: 48, sides: 7, pad: true },
  { name: 'needleMesa', at: [-60, 270], radius: 7, height: 70, sides: 6, pad: true },     // the town mesa, watching the Yard
  { name: 'overlookMesa', at: [-340, 60], radius: 40, height: 34, sides: 11, pad: false },  // the dune overlook
  { name: 'islandMesa', at: [-1300, -250], radius: 30, height: 40, sides: 9, pad: false }, // an island in the sand sea, tall enough to top any dune
];
const RING = { center: [0, 34, -240], radius: 14, tube: 1.4, segments: 24 };
const ARCH = { at: [-150, 125], span: 26, height: 15 };
const MAST = { at: [185, -160], height: 42 };
const BURIED_TYRE = { at: [205, 215], radius: 9, tube: 3.2, segments: 18 };
// The old trade road's furniture: watchtowers and a dead power line follow the canyon to the Spire,
// and banner poles mark the way. Laid out along canyonPathX in buildTradeRoad().
const ROAD_MARKS = [
  { kind: 'tower', z: -420 },
  { kind: 'tower', z: -1050 },
  { kind: 'tower', z: -1700 },
  { kind: 'pylonLine', fromZ: -350, toZ: -2200, every: 240, side: 45 },
  { kind: 'banners', fromZ: -350, toZ: -2250, every: 200, side: 35 },
];
const POPLAR_GROVES = [
  { at: [300, 900], count: 16 },
  { at: [-400, 1300], count: 12 },
  { at: [800, 1100], count: 10 },
  { at: [850, 800], count: 10 },   // the salt shore grove, just off the pan's south-west corner
  { at: [-155, -235], count: 10 }, // the yardang grove, near home
];
const ROCK_COUNT = 200;
const SHRUB_COUNT = 900;
const MOUNTAIN_COUNT = 44;
const SNOW_HEIGHT = 300;       // peaks taller than this wear snow
const CRATE_SIZE = 1.2;
const CRATE_MASS = 40;
const BARREL_MASS = 30;
const BEACON_PERIOD_SECONDS = 1.6;
const BLOOM_SLOTS = 16;        // lit relays that can green the land at once (the grid has 13)

// Where the land greens around a lit relay: moss and teal ground flecked with wildflowers, behind a
// glowing edge that races outward as the bloom spreads. Injected into the terrain's toon shader.
const BLOOM_FRAGMENT = /* glsl */ `
  float bloomAmount = 0.0;
  float bloomRim = 0.0;
  for (int i = 0; i < ${BLOOM_SLOTS}; i++) {
    vec3 bloom = uBloom[i];
    if (bloom.z < 0.5) continue;
    float ragged = (sin(vBloomWorld.x * 0.061) + sin(vBloomWorld.z * 0.047 + 1.3)) * 9.0;
    float reach = distance(vBloomWorld.xz, bloom.xy) + ragged;
    bloomAmount = max(bloomAmount, 1.0 - smoothstep(bloom.z * 0.82, bloom.z, reach));
    bloomRim = max(bloomRim, smoothstep(bloom.z * 0.9, bloom.z * 0.985, reach) * (1.0 - smoothstep(bloom.z * 0.985, bloom.z * 1.02, reach)));
  }
  if (bloomAmount > 0.0) {
    vec2 bloomCell = floor(vBloomWorld.xz * 0.6);
    float seed = fract(sin(dot(bloomCell, vec2(12.9898, 78.233))) * 43758.5453);
    vec3 moss = mix(vec3(0.12, 0.32, 0.08), vec3(0.05, 0.30, 0.22), smoothstep(0.2, 0.8, seed));
    vec3 life = seed > 0.992 ? vec3(1.0, 0.75, 0.18)
      : seed > 0.984 ? vec3(0.95, 0.35, 0.45)
      : seed > 0.976 ? vec3(0.85, 0.9, 1.0)
      : moss;
    diffuseColor.rgb = mix(diffuseColor.rgb, life, bloomAmount * 0.9);
  }
`;

// The colossal things. The Spire is the through-line's end: 550 m at the head of the canyon, visible
// from the start line. The dish field drinks the sun beyond the salt; a wrecked hull drowns in the
// dune sea. Scenery only — the fog keeps them half-imagined.
const SPIRE = { at: [0, -2350], height: 550, baseRadius: 22, topRadius: 4, crownRadius: 8 };
const DISH_FARM = { center: [2100, 300], spread: 280, count: 16, minRadius: 26, maxRadius: 46 };
const WRECK = { at: [-1800, 700], radius: 30, length: 240, heading: 0.7 };
// The fallen ring: a section of the thing that broke, half-swallowed by the sand near the wreck,
// with sandfalls pouring off its edge. The dune sea's one story.
const FALLEN_RING = { at: [-2150, 250], radius: 120, tube: 18, arc: 1.2 };
const SANDFALLS = [
  { at: [-2060, 190], width: 10, height: 34, yaw: 0.7 },
  { at: [-2120, 320], width: 13, height: 40, yaw: -0.4 },
  { at: [-2210, 210], width: 9, height: 30, yaw: 1.6 },
];
// The Relay: a still-live gate on the dead trade road, halfway up the canyon, marking the mid-road pad.
const RELAY = { z: -1400, halfWidth: 7, postHeight: 9 };
// The giant's marbles: stone spheres the size of houses, half-buried in the southern meadows.
const MARBLES = { at: [420, 820], spread: 130, count: 6, minRadius: 5, maxRadius: 9 };
// Surge pads: plates of still-live ancient grid, strung along the through-route like waystations.
// Pads on the road place their x from canyonPathX at build time.
const BOOST_PADS = [
  { at: [0, -95], radius: 4 },        // past the ramps, on the home straight
  { at: [-95, -45], radius: 4 },      // the gap-jump run-up
  { at: [125, 95], radius: 5 },       // in the bowl
  { name: 'dunePad', at: [-1600, 300], radius: 5 },    // the heart of the dune sea
  { salt: true, radius: 8 },          // dead centre of the salt pan
  { roadZ: -1400, radius: 5 },        // halfway up the trade road
  { roadZ: -2250, radius: 6 },        // the Spire's foot
  { fairStart: true, radius: 5 },     // the fair circuit's start/finish line, by the village gate
];
// The New Silk Road: an elevated freight line crossing the whole valley south of home, riding up and
// over the dune sea, container pods gliding past day and night, too big and too indifferent to notice
// a buggy. The community of 拾风 (Scrapwind Yard) squats just north of it.
const SILK_LINE = { z: 215, clearance: 12, minHeight: 24, segmentLength: 100, from: -2500, to: 2500, podSpeed: 18, podOffsets: [0, 1700, 3400], podColors: [0xb85c42, 0x3f8f8a, 0xd8d2c4] };
const SETTLEMENT = { center: [90, 172] };
// The fair: the Yard's fun ground inside its own race circuit, run on grid power and stubbornness.
const FAIR = { center: [0, 430] };
const FAIR_TRACK = { center: [0, 430], baseRadius: 220, wave: 30, wave2: 15, segments: 72, width: 8 };
const STRING_POLES = [[-16, -10], [-4, -16], [8, -12], [14, 0], [6, 10], [-8, 8], [-16, -10]]; // a loop around the plaza, settlement-local

const COLORS = {
  ramp: 0x2e7f7a,
  landing: 0x4f8a9a,
  tableTop: 0x4a7f8f,
  bowl: 0xb85c42,
  bump: 0x8a6f5e,
  mesa: 0xb0523a,
  rock: 0x9c5848,
  pad: 0x2f3a3c,
  padMark: 0xf2d14b,
  ring: 0x7fe0d0,
  mast: 0x8a4a3a,
  tyre: 0x2a2522,
  crate: 0xa8643c,
  barrel: 0xd0503a,
  shrub: 0x8a8a4a,
  mountain: 0x8a4a52,
  snow: 0xf5f2ee,
  beacon: 0xff4a3a,
  tower: 0xa88a62,
  pylon: 0x5f6a70,
  poplarTrunk: 0x5a4632,
  poplarLeaf: 0xe8a33d,
  megastructure: 0x2c2f33,
  megastructureGlow: 0x54e8d8,
  dish: 0xd8d2c4,
  wreck: 0x4a3a30,
  boostPad: 0x64ffe0,
  road: 0x8a6a44,
  booth: 0x6b4a33,
  stripeRed: 0xd94f6a,
  stripePale: 0xf2f0e4,
  tent: 0x4f6fd9,
};

/**
 * TestTrack: the valley of 拾风. A 6 km world on one through-line — the home basin with its playground
 * and the settlement, the dune sea west, the salt pan and dish field east, meadows south, and the old
 * trade road winding north through a red-rock canyon to the Spire. Builds the terrain and every feature
 * (ramps, jumps, bowl, lanes, mesas, the Silk Line freight railway, colossal structures, surge pads) as
 * meshes with matching Rapier colliders. Wheels ask it what is under them (probeGround), ChaseCamera asks
 * how high the ground is (heightAt), and Game asks it to keep its props, pods and lights drawn (updateVisuals).
 */
export class TestTrack {
  world;
  scene;
  random = seededRandom(SEED);
  terrainCollider;
  surfaces = new Map();  // collider handle → SURFACES entry
  props = [];            // [{ body, mesh }] loose things that get knocked about
  beacon;
  spireCrown;
  boostPadMaterial;
  boostPads = [];        // [{ x, z, y, radius }] the surge pads a vehicle can charge from
  silkPods = [];         // [{ body, group, offset, lane }] kinematic freight pods on the Silk Line
  podClock = 0;          // seconds of simulated Silk Line time
  ferrisWheel;           // the fair's turning wheel; gondolas hang off it and stay level
  ferrisGondolas = [];
  carouselPlatform;
  carouselCups = [];
  bloomUniform;          // the terrain shader's bloom circles
  spireAwakening = 0;

  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.buildTerrain();
    this.buildStartArea();
    this.buildRamps();
    this.buildGapJumps();
    this.buildTableTops();
    this.buildBowl();
    this.buildWashboard();
    this.buildSurfaceLanes();
    this.buildMesas();
    this.buildCuriosities();
    this.buildLandmarks();
    this.scatterRocks();
    this.scatterShrubs();
    this.buildHorizon();
    this.buildMegastructures();
    this.buildSilkLine();
    this.buildSettlement();
    this.buildFairTrack();
    this.buildFairground();
    this.buildPools();
    this.buildBoostPads();
    this.buildProps();
    // Rapier only indexes new colliders for ray queries when the world steps: one step now (props settle
    // by a frame) so anything placed by raycasting after this, like the grid's relays, can see the valley.
    this.world.step();
  }

  /**
   * Casts a ray (direction must be unit length) up to maxDistance, ignoring the given chassis.
   * Returns { distance, point, normal, surface, collider } or null.
   */
  probeGround(origin, direction, maxDistance, chassis) {
    const ray = new RAPIER.Ray(origin, direction);
    const hit = this.world.castRayAndGetNormal(ray, maxDistance, true, undefined, undefined, undefined, chassis.physicsBody());
    if (!hit) return null;
    const point = origin.clone().addScaledVector(direction, hit.timeOfImpact);
    return {
      distance: hit.timeOfImpact,
      point,
      normal: new THREE.Vector3().copy(hit.normal),
      surface: this.surfaceAt(hit.collider, point),
      collider: hit.collider,
    };
  }

  /** Equal and opposite: if a wheel is pushing off something loose, push that thing back. */
  pushBack(ground, force, dt) {
    const body = ground.collider.parent();
    if (!body || !body.isDynamic()) return;
    body.applyImpulseAtPoint({ x: -force.x * dt, y: -force.y * dt, z: -force.z * dt }, ground.point, true);
  }

  /**
   * The first fixed surface below a point (x, fromY, z): what a camera or a hovering vehicle actually has
   * underneath it. Arches, the floating ring and passing freight pods overhead don't count, and neither do
   * vehicles. Starting inside a solid finds its far side, so nothing gets pushed up through a mesa.
   */
  surfaceBelow(x, fromY, z) {
    const ray = new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 });
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;
    const hit = this.world.castRay(ray, 2000, false, flags);
    return hit ? fromY - hit.timeOfImpact : terrainHeight(x, z);
  }

  /** Height of the highest fixed ground at (x, z), ignoring loose props: what the haze lies on. */
  heightAt(x, z) {
    const ray = new RAPIER.Ray({ x, y: 1000, z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, 2000, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
    return hit ? 1000 - hit.timeOfImpact : terrainHeight(x, z);
  }

  /** Copies loose props' physics poses to their meshes and blinks the radio mast light. */
  updateVisuals(elapsedSeconds) {
    for (const prop of this.props) {
      prop.mesh.position.copy(prop.body.translation());
      prop.mesh.quaternion.copy(prop.body.rotation());
    }
    this.beacon.visible = (elapsedSeconds % BEACON_PERIOD_SECONDS) < BEACON_PERIOD_SECONDS * 0.35;
    if (this.boostPadMaterial) {
      this.boostPadMaterial.emissiveIntensity = 1.3 + 0.6 * Math.sin(elapsedSeconds * 3.2);
    }
    if (this.spireCrown) {
      const awake = this.spireAwakening ?? 0;
      this.spireCrown.material.emissiveIntensity = (1.6 + 1.2 * Math.sin(elapsedSeconds * (0.9 + awake * 2.5))) * (1 + awake * 3);
    }
    if (this.sandfallMaterial) {
      this.sandfallMaterial.uniforms.uTime.value = elapsedSeconds;
    }
    if (this.poolMaterial) {
      this.poolMaterial.uniforms.uTime.value = elapsedSeconds;
    }
    for (const pod of this.silkPods) {
      pod.group.position.copy(pod.body.translation());
    }
    if (this.ferrisWheel) {
      this.ferrisWheel.rotation.z = elapsedSeconds * 0.12;
      for (const gondola of this.ferrisGondolas) gondola.rotation.z = -this.ferrisWheel.rotation.z;
    }
    if (this.carouselPlatform) {
      this.carouselPlatform.rotation.y = elapsedSeconds * 0.45;
      for (const cup of this.carouselCups) cup.rotation.y = elapsedSeconds * 2.2;
    }
  }

  /** The surge pad under this position, if any: close across the ground and not far above it. */
  boostPadAt(position) {
    return this.boostPads.find(pad =>
      Math.hypot(position.x - pad.x, position.z - pad.z) < pad.radius
      && Math.abs(position.y - pad.y) < 3) ?? null;
  }

  surfaceAt(collider, point) {
    if (collider.handle === this.terrainCollider.handle) return terrainSurfaceAt(point.x, point.y, point.z);
    return this.surfaces.get(collider.handle) ?? SURFACES.dirt;
  }

  // ---- Building blocks ----

  /**
   * The world is hundreds of static, same-material meshes; drawn individually that is a thousand
   * draw calls a frame. Instead, builders collect geometries here and one merged mesh goes to the
   * GPU per batch: same pixels, a fraction of the draws. Colliders are unaffected.
   */

  /** Normalises a geometry for merging: un-indexed, flat normals where missing, no uvs. */
  prep(geometry) {
    const split = geometry.index ? geometry.toNonIndexed() : geometry;
    if (!split.attributes.normal) split.computeVertexNormals();
    split.deleteAttribute('uv');
    return split;
  }

  /** Bakes a built mesh's geometry into a merge list, in world space; the mesh itself never draws. */
  mergeInstead(mesh, list) {
    mesh.updateMatrixWorld(true);
    list.push(this.prep(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)));
  }

  /** Bakes a whole subtree (a positioned group) into a merge list. */
  mergeTreeInstead(root, list) {
    root.updateMatrixWorld(true);
    root.traverse(node => {
      if (node.isMesh) list.push(this.prep(node.geometry.clone().applyMatrix4(node.matrixWorld)));
    });
  }

  /** One mesh for many geometries, optionally with one shared ink outline. */
  addMerged(list, material, { outline = 0, shadows = true } = {}) {
    if (list.length === 0) return null;
    const mesh = new THREE.Mesh(mergeGeometries(list), material);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    this.scene.add(mesh);
    if (outline > 0) addOutline(mesh, outline);
    return mesh;
  }

  /** Adds a mesh to the scene and a fixed collider to the world, tagging the collider's surface. */
  addFixed(mesh, colliderDescription, surface) {
    if (mesh) this.scene.add(mesh);
    const collider = this.world.createCollider(colliderDescription);
    if (surface) this.surfaces.set(collider.handle, SURFACES[surface]);
    return collider;
  }

  /** A collider for a convex solid, with no mesh of its own (the visual goes into a merged batch). */
  addConvexCollider(points, surface) {
    const flat = new Float32Array(points.flatMap(point => [point.x, point.y, point.z]));
    return this.addFixed(null, RAPIER.ColliderDesc.convexHull(flat), surface);
  }

  /** A convex solid from world-space points, drawn and collided identically. */
  addConvex(points, color, surface, outline = 0.06) {
    const mesh = toonMesh(new ConvexGeometry(points), color, { outline });
    const flat = new Float32Array(points.flatMap(point => [point.x, point.y, point.z]));
    return this.addFixed(mesh, RAPIER.ColliderDesc.convexHull(flat), surface);
  }

  /** A box at a world position and rotation. */
  addBox(size, position, quaternion, color, surface, outline = 0.05) {
    const mesh = toonMesh(new THREE.BoxGeometry(size.x, size.y, size.z), color, { outline });
    mesh.position.copy(position);
    mesh.quaternion.copy(quaternion);
    const description = RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
      .setTranslation(position.x, position.y, position.z)
      .setRotation(quaternion);
    return this.addFixed(mesh, description, surface);
  }

  /** A ring of box colliders approximating a torus, since Rapier has no torus shape. */
  addRingColliders(center, quaternion, radius, tube, segments, surface) {
    const segmentLength = (2 * Math.PI * radius / segments) * 1.08;
    for (let index = 0; index < segments; index++) {
      const angle = (index / segments) * Math.PI * 2;
      const local = new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
      const position = local.applyQuaternion(quaternion).add(center);
      const rotation = quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle));
      const description = RAPIER.ColliderDesc.cuboid(tube, segmentLength / 2, tube)
        .setTranslation(position.x, position.y, position.z)
        .setRotation(rotation);
      this.addFixed(null, description, surface);
    }
  }

  /** A flat landing pad with a painted H, sitting on the given height. */
  addLandingPad(x, y, z, radius) {
    const thickness = 0.2;
    const pad = toonMesh(new THREE.CylinderGeometry(radius, radius, thickness, 20), COLORS.pad, { outline: 0.05 });
    pad.position.set(x, y + thickness / 2, z);
    const markMaterial = toonMaterial(COLORS.padMark);
    const barLength = radius * 1.1;
    const marks = [
      [radius * 0.12, barLength, -radius * 0.32, 0],
      [radius * 0.12, barLength, radius * 0.32, 0],
      [radius * 0.64, radius * 0.12, 0, 0],
    ];
    for (const [width, depth, offsetX, offsetZ] of marks) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(width, 0.02, depth), markMaterial);
      bar.position.set(offsetX, thickness / 2 + 0.01, offsetZ);
      pad.add(bar);
    }
    const description = RAPIER.ColliderDesc.cylinder(thickness / 2, radius).setTranslation(x, y + thickness / 2, z);
    this.addFixed(pad, description, 'metal');
  }

  // ---- The proving ground ----

  buildTerrain() {
    const geometry = new THREE.PlaneGeometry(WORLD.size, WORLD.size, WORLD.cells, WORLD.cells);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes.position;
    for (let index = 0; index < positions.count; index++) {
      positions.setY(index, terrainHeight(positions.getX(index), positions.getZ(index)));
    }
    const description = RAPIER.ColliderDesc.trimesh(new Float32Array(positions.array), new Uint32Array(geometry.index.array))
      .setFriction(0.8);
    this.terrainCollider = this.world.createCollider(description);

    // Split every triangle so each facet gets its own flat normal and colour: the low-poly look.
    const faceted = geometry.toNonIndexed();
    faceted.computeVertexNormals();
    const facetedPositions = faceted.attributes.position;
    const colors = new Float32Array(facetedPositions.count * 3);
    const color = new THREE.Color();
    for (let index = 0; index < facetedPositions.count; index += 3) {
      const x = (facetedPositions.getX(index) + facetedPositions.getX(index + 1) + facetedPositions.getX(index + 2)) / 3;
      const y = (facetedPositions.getY(index) + facetedPositions.getY(index + 1) + facetedPositions.getY(index + 2)) / 3;
      const z = (facetedPositions.getZ(index) + facetedPositions.getZ(index + 1) + facetedPositions.getZ(index + 2)) / 3;
      terrainColor(x, y, z, this.random, color);
      for (let corner = 0; corner < 3; corner++) color.toArray(colors, (index + corner) * 3);
    }
    faceted.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = toonMaterial(0xffffff, { vertexColors: true });
    this.addBloomTo(material);
    const mesh = new THREE.Mesh(faceted, material);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  /** Teaches the terrain shader to green the land in up to BLOOM_SLOTS circles (x, z, radius). */
  addBloomTo(material) {
    this.bloomUniform = { value: Array.from({ length: BLOOM_SLOTS }, () => new THREE.Vector3()) };
    material.onBeforeCompile = shader => {
      shader.uniforms.uBloom = this.bloomUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBloomWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvBloomWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vBloomWorld;\nuniform vec3 uBloom[${BLOOM_SLOTS}];`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${BLOOM_FRAGMENT}`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(0.25, 0.95, 0.8) * bloomRim * 0.9;');
    };
    material.customProgramCacheKey = () => 'terrain-bloom';
  }

  /** Greens the land in a circle around (x, z); slot is which of the bloom circles to use. */
  setBloom(slot, x, z, radius) {
    if (slot < BLOOM_SLOTS) this.bloomUniform.value[slot].set(x, z, radius);
  }

  /** Back to dust everywhere. */
  clearBlooms() {
    for (const bloom of this.bloomUniform.value) bloom.set(0, 0, 0);
  }

  /** A named place in the valley as { x, z } (with radius for mesas), for things built around it. */
  landmark(name) {
    const mesa = MESAS.find(entry => entry.name === name);
    if (mesa) return { x: mesa.at[0], z: mesa.at[1], radius: mesa.radius * 0.82 };
    const pad = BOOST_PADS.find(entry => entry.name === name);
    if (pad) return { x: pad.at[0], z: pad.at[1] };
    const places = {
      settlement: SETTLEMENT.center,
      marbles: MARBLES.at,
      salt: WORLD.salt.center,
      dishField: DISH_FARM.center,
      wreck: WRECK.at,
      fallenRing: FALLEN_RING.at,
      spire: SPIRE.at,
    };
    const [x, z] = places[name];
    return { x, z };
  }

  /** Where the old trade road runs across the canyon at a given z. */
  roadX(z) {
    return canyonPathX(z);
  }

  /** Height of the bare terrain at (x, z), ignoring everything built on it. */
  groundHeight(x, z) {
    return terrainHeight(x, z);
  }

  /** The very top of the Spire's crown. */
  spireTop() {
    const [x, z] = SPIRE.at;
    return new THREE.Vector3(x, terrainHeight(x, z) - 2 + SPIRE.height + SPIRE.crownRadius * 1.6, z);
  }

  /** How awake the Spire is (0..1): its crown flares and swells when the grid is whole. */
  awakenSpire(level) {
    this.spireAwakening = level;
    if (this.spireCrown) this.spireCrown.scale.setScalar(1 + level * 0.8);
  }

  buildStartArea() {
    const [x, z] = START_PAD.at;
    this.addBox(new THREE.Vector3(START_PAD.size, 0.06, START_PAD.size), new THREE.Vector3(x, 0, z), new THREE.Quaternion(), SURFACES.concrete.color, 'concrete', 0);
    // Painted start line
    const line = new THREE.Mesh(new THREE.BoxGeometry(START_PAD.size * 0.8, 0.01, 0.6), toonMaterial(COLORS.padMark));
    line.position.set(x, 0.035, z - START_PAD.size * 0.3);
    this.scene.add(line);
    for (const pad of GROUND_PADS) this.addLandingPad(pad.at[0], 0, pad.at[1], pad.radius);
  }

  buildRamps() {
    for (const ramp of RAMPS) {
      const height = ramp.length * Math.tan(THREE.MathUtils.degToRad(ramp.angleDegrees));
      const points = wedgePoints(ramp.width, ramp.length, 0, height);
      this.addConvex(placePoints(points, ramp.at, 0), COLORS.ramp, 'metal');
    }
  }

  buildGapJumps() {
    for (const jump of GAP_JUMPS) {
      const height = jump.takeoffLength * Math.tan(THREE.MathUtils.degToRad(jump.takeoffAngleDegrees));
      this.addConvex(placePoints(wedgePoints(jump.width, jump.takeoffLength, 0, height), jump.at, 0), COLORS.ramp, 'metal');
      // Landing slope: starts just below take-off height on the far side of the gap and runs down to the ground.
      const landingStart = jump.takeoffLength + jump.gap;
      const landing = wedgePoints(jump.width, jump.landingLength, height * 0.92, 0)
        .map(point => point.setZ(point.z - landingStart));
      this.addConvex(placePoints(landing, jump.at, 0), COLORS.landing, 'metal');
    }
  }

  buildTableTops() {
    for (const table of TABLE_TOPS) {
      const halfWidth = table.width / 2;
      const profile = [
        [0, 0],
        [-table.rampLength, table.height],
        [-(table.rampLength + table.topLength), table.height],
        [-(2 * table.rampLength + table.topLength), 0],
      ];
      const points = profile.flatMap(([z, y]) => [new THREE.Vector3(-halfWidth, y, z), new THREE.Vector3(halfWidth, y, z)]);
      this.addConvex(placePoints(points, table.at, 0), COLORS.tableTop, 'metal');
    }
  }

  /** A banked ring you can drive round flat out: a curved ramp profile on the inside, a back slope outside. */
  buildBowl() {
    const { center, innerRadius, width, height, backSlope, segments, radialSteps } = BOWL;
    const profile = [];
    for (let step = 0; step <= radialSteps; step++) {
      const fraction = step / radialSteps;
      profile.push([innerRadius + fraction * width, height * fraction * fraction]);
    }
    profile.push([innerRadius + width + backSlope, 0]);

    const vertices = [];
    const indices = [];
    const columns = profile.length;
    for (let segment = 0; segment <= segments; segment++) {
      const angle = (segment / segments) * Math.PI * 2;
      for (const [radius, y] of profile) {
        vertices.push(center[0] + Math.cos(angle) * radius, y, center[1] + Math.sin(angle) * radius);
      }
    }
    for (let segment = 0; segment < segments; segment++) {
      for (let column = 0; column < columns - 1; column++) {
        const a = segment * columns + column;
        const b = a + columns;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    const faceted = geometry.toNonIndexed();
    faceted.computeVertexNormals();
    const mesh = new THREE.Mesh(faceted, toonMaterial(COLORS.bowl, { side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    this.addFixed(mesh, RAPIER.ColliderDesc.trimesh(new Float32Array(vertices), new Uint32Array(indices)), 'concrete');
  }

  buildWashboard() {
    const { at, length, width, spacing, bumpHeight, bumpRadius } = WASHBOARD;
    const bumpCount = Math.floor(length / spacing);
    const geoms = [];
    const lyingDown = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    for (let index = 0; index < bumpCount; index++) {
      const z = at[1] - index * spacing;
      const y = bumpHeight - bumpRadius;
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(bumpRadius, bumpRadius, width, 10).rotateZ(Math.PI / 2));
      mesh.position.set(at[0], y, z);
      this.mergeInstead(mesh, geoms);
      const description = RAPIER.ColliderDesc.cylinder(width / 2, bumpRadius).setTranslation(at[0], y, z).setRotation(lyingDown);
      this.addFixed(null, description, 'rock');
    }
    this.addMerged(geoms, toonMaterial(COLORS.bump));
  }

  buildSurfaceLanes() {
    const { startZ, length, width, lanes } = SURFACE_LANES;
    for (const [surface, x] of lanes) {
      const position = new THREE.Vector3(x, 0, startZ + length / 2);
      this.addBox(new THREE.Vector3(width, 0.06, length), position, new THREE.Quaternion(), SURFACES[surface].color, surface, 0);
    }
  }

  buildMesas() {
    const geoms = [];
    for (const mesa of MESAS) {
      const [x, z] = mesa.at;
      const base = terrainHeight(x, z) - 4;
      const geometry = new THREE.CylinderGeometry(mesa.radius * 0.82, mesa.radius, mesa.height, mesa.sides);
      geometry.translate(x, base + mesa.height / 2, z);
      const points = pointsOf(geometry).map(point => point.add(jitter(this.random, mesa.radius * 0.05)));
      geoms.push(new ConvexGeometry(points));
      this.addConvexCollider(points, 'rock');
      if (mesa.pad) this.addLandingPad(x, base + mesa.height, z, Math.min(mesa.radius * 0.5, 6));
    }
    this.addMerged(geoms, toonMaterial(COLORS.mesa), { outline: 0.3 });
  }

  buildCuriosities() {
    // A ring hanging in the air to the north: why is it there? Fly through it.
    const ringCenter = new THREE.Vector3(...RING.center);
    const ring = toonMesh(new THREE.TorusGeometry(RING.radius, RING.tube, 8, 32), COLORS.ring, { outline: 0.12 });
    ring.material.emissive = new THREE.Color(COLORS.ring);
    ring.material.emissiveIntensity = 0.35;
    ring.position.copy(ringCenter);
    this.scene.add(ring);
    this.addRingColliders(ringCenter, new THREE.Quaternion(), RING.radius, RING.tube, RING.segments, 'metal');

    // A natural rock arch to the west, big enough to fly under.
    const [archX, archZ] = ARCH.at;
    const archGround = terrainHeight(archX, archZ) - 2;
    for (const side of [-1, 1]) {
      const pillarX = archX + side * ARCH.span / 2;
      this.addConvex(rockPoints(this.random, pillarX, archGround + ARCH.height / 2, archZ, 4, ARCH.height / 2 + 2, 4), COLORS.rock, 'rock', 0.12);
    }
    this.addConvex(rockPoints(this.random, archX, archGround + ARCH.height + 2, archZ, ARCH.span / 2 + 4, 2.5, 3.5), COLORS.rock, 'rock', 0.12);

    // An old radio mast with a blinking light on top.
    const [mastX, mastZ] = MAST.at;
    const mastGround = terrainHeight(mastX, mastZ) - 1;
    const mastGeometry = new THREE.CylinderGeometry(0.4, 2.4, MAST.height, 3);
    mastGeometry.translate(mastX, mastGround + MAST.height / 2, mastZ);
    this.addConvex(pointsOf(mastGeometry), COLORS.mast, 'metal', 0.08);
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), new THREE.MeshBasicMaterial({ color: COLORS.beacon, fog: false }));
    this.beacon.position.set(mastX, mastGround + MAST.height + 0.6, mastZ);
    this.scene.add(this.beacon);

    // A giant's tyre, half buried, from some machine nobody remembers.
    const [tyreX, tyreZ] = BURIED_TYRE.at;
    const tyreCenter = new THREE.Vector3(tyreX, terrainHeight(tyreX, tyreZ) + 2, tyreZ);
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.15, 0.6, 0));
    const tyre = toonMesh(new THREE.TorusGeometry(BURIED_TYRE.radius, BURIED_TYRE.tube, 8, BURIED_TYRE.segments), COLORS.tyre, { outline: 0.15 });
    tyre.position.copy(tyreCenter);
    tyre.quaternion.copy(tilt);
    this.scene.add(tyre);
    this.addRingColliders(tyreCenter, tilt, BURIED_TYRE.radius, BURIED_TYRE.tube, BURIED_TYRE.segments, 'rock');
  }

  scatterRocks() {
    const geoms = [];
    for (let index = 0; index < ROCK_COUNT; index++) {
      const angle = this.random() * Math.PI * 2;
      const distance = THREE.MathUtils.lerp(WORLD.basinRadius + 15, WORLD.rimStart - 100, this.random() ** 1.5);
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      if (z < WORLD.canyon.start && canyonCorridor(x, z) > 0.3) continue; // keep the road clear
      const size = THREE.MathUtils.lerp(1.2, 6.5, this.random() ** 2);
      const points = rockPoints(this.random, x, terrainHeight(x, z) + size * 0.25, z, size, size * 0.7, size);
      geoms.push(new ConvexGeometry(points));
      this.addConvexCollider(points, 'rock');
    }
    this.addMerged(geoms, toonMaterial(COLORS.rock), { outline: 0.1 });
  }

  /** Dry scrub: decoration only, drive straight through it. */
  scatterShrubs() {
    const geometry = faceted(new THREE.ConeGeometry(0.7, 1.3, 5).translate(0, 0.5, 0));
    const shrubs = new THREE.InstancedMesh(geometry, toonMaterial(COLORS.shrub), SHRUB_COUNT);
    shrubs.castShadow = true;
    const matrix = new THREE.Matrix4();
    const bowlCenter = new THREE.Vector2(...BOWL.center);
    let placed = 0;
    let guard = 0;
    while (placed < SHRUB_COUNT && guard++ < SHRUB_COUNT * 4) {
      const angle = this.random() * Math.PI * 2;
      const distance = THREE.MathUtils.lerp(150, WORLD.rimStart - 100, Math.sqrt(this.random()));
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      if (bowlCenter.distanceTo(new THREE.Vector2(x, z)) < BOWL.innerRadius + BOWL.width + BOWL.backSlope + 4) continue;
      if (z < WORLD.canyon.start && canyonCorridor(x, z) > 0.3) continue; // keep the road clear
      const scale = THREE.MathUtils.lerp(0.6, 1.6, this.random());
      matrix.compose(
        new THREE.Vector3(x, terrainHeight(x, z), z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.random() * Math.PI),
        new THREE.Vector3(scale, scale * THREE.MathUtils.lerp(0.7, 1.2, this.random()), scale),
      );
      shrubs.setMatrixAt(placed++, matrix);
    }
    shrubs.count = placed;
    this.scene.add(shrubs);
  }

  /** The valley wall: a ring of peaks outside the terrain rim, snow on the tall ones, wide clouds above. */
  buildHorizon() {
    const mountainGeoms = [];
    const snowGeoms = [];
    for (let index = 0; index < MOUNTAIN_COUNT; index++) {
      const angle = (index / MOUNTAIN_COUNT) * Math.PI * 2 + this.random() * 0.12;
      const distance = THREE.MathUtils.lerp(2650, 3150, this.random());
      const radius = THREE.MathUtils.lerp(180, 380, this.random());
      const height = THREE.MathUtils.lerp(150, 420, this.random());
      const mountain = new THREE.Mesh(faceted(new THREE.ConeGeometry(radius, height, 6)));
      mountain.position.set(Math.cos(angle) * distance, height / 2 - 20, Math.sin(angle) * distance);
      mountain.rotation.y = this.random() * Math.PI;
      this.mergeInstead(mountain, mountainGeoms);
      if (height > SNOW_HEIGHT) {
        const snowHeight = height * 0.28;
        const snow = new THREE.Mesh(faceted(new THREE.ConeGeometry(radius * 0.34, snowHeight, 6)));
        snow.position.set(mountain.position.x, mountain.position.y + height / 2 - snowHeight / 2, mountain.position.z);
        snow.rotation.y = mountain.rotation.y;
        this.mergeInstead(snow, snowGeoms);
      }
    }
    this.addMerged(mountainGeoms, toonMaterial(COLORS.mountain), { shadows: false });
    this.addMerged(snowGeoms, toonMaterial(COLORS.snow), { shadows: false });

    // High cirrus only: a desert sky carries no puffy clouds. Long pale streaks, far up, feathered.
    const cirrusMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          float along = smoothstep(0.0, 0.3, vUv.x) * (1.0 - smoothstep(0.7, 1.0, vUv.x));
          float across = smoothstep(0.0, 0.45, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
          float wisps = 0.6 + 0.4 * sin(vUv.x * 34.0 + vUv.y * 9.0) * sin(vUv.x * 13.0 - 1.7);
          float alpha = along * across * wisps * 0.34;
          gl_FragColor = vec4(vec3(0.99, 0.95, 0.88), alpha);
        }
      `,
    });
    const cirrusGeoms = [];
    for (let index = 0; index < CIRRUS_COUNT; index++) {
      const angle = this.random() * Math.PI * 2;
      const distance = THREE.MathUtils.lerp(700, 2600, this.random());
      const height = THREE.MathUtils.lerp(420, 580, this.random());
      const streak = new THREE.Mesh(new THREE.PlaneGeometry(THREE.MathUtils.lerp(280, 720, this.random()), THREE.MathUtils.lerp(22, 60, this.random())));
      streak.position.set(Math.cos(angle) * distance, height, Math.sin(angle) * distance);
      streak.rotation.set((this.random() - 0.5) * 0.1, angle + Math.PI / 2, (this.random() - 0.5) * 0.08);
      streak.updateMatrixWorld(true);
      // Baked directly (not mergeInstead): the shader reads uv, which prep() would strip.
      cirrusGeoms.push(streak.geometry.clone().applyMatrix4(streak.matrixWorld));
    }
    this.addMerged(cirrusGeoms, cirrusMaterial, { shadows: false });
  }

  /** Crates and barrels to knock over near the start. */
  buildProps() {
    const crateGeometry = new THREE.BoxGeometry(CRATE_SIZE, CRATE_SIZE, CRATE_SIZE);
    const rows = 4;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < rows - row; column++) {
        const x = 18 + (column - (rows - row - 1) / 2) * (CRATE_SIZE + 0.05);
        const y = CRATE_SIZE / 2 + row * CRATE_SIZE + 0.05;
        this.addProp(crateGeometry, COLORS.crate, RAPIER.ColliderDesc.cuboid(CRATE_SIZE / 2, CRATE_SIZE / 2, CRATE_SIZE / 2), CRATE_MASS, x, y, 6);
      }
    }
    const barrelGeometry = new THREE.CylinderGeometry(0.4, 0.4, 1.1, 10);
    for (let index = 0; index < 6; index++) {
      const x = -22 + (index % 3) * 1.0;
      const z = 6 + Math.floor(index / 3) * 1.0;
      this.addProp(barrelGeometry, COLORS.barrel, RAPIER.ColliderDesc.cylinder(0.55, 0.4), BARREL_MASS, x, 0.6, z);
    }
  }

  addProp(geometry, color, colliderDescription, mass, x, y, z) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z));
    this.world.createCollider(colliderDescription.setMass(mass).setFriction(0.7), body);
    const mesh = toonMesh(geometry, color, { outline: 0.03 });
    this.scene.add(mesh);
    this.props.push({ body, mesh });
  }

  // ---- Gobi landmarks ----

  /** The old trade road's furniture follows the canyon: watchtowers, the dead power line, waymark banners. */
  buildLandmarks() {
    const towerGeoms = [];
    const pylonGeoms = [];
    for (const mark of ROAD_MARKS) {
      if (mark.kind === 'tower') this.buildBeaconTower(canyonPathX(mark.z) + 30, mark.z, towerGeoms);
      if (mark.kind === 'pylonLine') {
        for (let z = mark.fromZ; z >= mark.toZ; z -= mark.every) this.buildPylon(canyonPathX(z) + mark.side, z, pylonGeoms);
      }
      if (mark.kind === 'banners') this.buildBanners(mark);
    }
    this.addMerged(towerGeoms, toonMaterial(COLORS.tower), { outline: 0.15 });
    this.addMerged(pylonGeoms, toonMaterial(COLORS.pylon), { outline: 0.08 });
    this.buildRelay();
    this.buildMarbles();
    this.buildPoplarGroves();
  }

  /** The Relay: a live gate straddling the trade road at the mid-road surge pad. Drive through it. */
  buildRelay() {
    const { z, halfWidth, postHeight } = RELAY;
    const x = canyonPathX(z);
    const dx = (canyonPathX(z + 10) - canyonPathX(z - 10)) / 20; // the road's local slope
    const yaw = Math.atan2(dx, 1); // the gate's beam lies across the road
    const glowMaterial = toonMaterial(COLORS.megastructureGlow, { emissive: COLORS.megastructureGlow, emissiveIntensity: 1.3 });
    const ground = (offsetX) => terrainHeight(x + offsetX, z);
    for (const side of [-1, 1]) {
      const post = toonMesh(new THREE.CylinderGeometry(0.35, 0.5, postHeight, 6), COLORS.megastructure, { outline: 0.08 });
      post.position.set(x + side * halfWidth, ground(side * halfWidth) + postHeight / 2, z);
      this.scene.add(post);
      this.addFixed(null, RAPIER.ColliderDesc.cylinder(postHeight / 2, 0.5).setTranslation(x + side * halfWidth, ground(side * halfWidth) + postHeight / 2, z), 'metal');
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 2 + 1.5, 0.5, 0.7), glowMaterial);
    beam.position.set(x, Math.min(ground(-halfWidth), ground(halfWidth)) + postHeight, z);
    beam.rotation.y = yaw;
    this.scene.add(beam);
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 2 + 3, 0.35, 0.5), toonMaterial(COLORS.megastructure));
    lintel.position.set(x, Math.min(ground(-halfWidth), ground(halfWidth)) + postHeight + 0.8, z);
    lintel.rotation.y = yaw;
    this.scene.add(lintel);
  }

  /** The giant's marbles: house-sized stone spheres half-buried in the southern meadows. */
  buildMarbles() {
    const { at, spread, count, minRadius, maxRadius } = MARBLES;
    const geoms = [];
    for (let index = 0; index < count; index++) {
      const angle = this.random() * Math.PI * 2;
      const distance = Math.sqrt(this.random()) * spread;
      const x = at[0] + Math.cos(angle) * distance;
      const z = at[1] + Math.sin(angle) * distance;
      const radius = THREE.MathUtils.lerp(minRadius, maxRadius, this.random());
      const ground = terrainHeight(x, z);
      const y = ground + radius * 0.55;
      const marble = new THREE.Mesh(faceted(new THREE.SphereGeometry(radius, 10, 7)));
      marble.position.set(x, y, z);
      this.mergeInstead(marble, geoms);
      this.addFixed(null, RAPIER.ColliderDesc.ball(radius * 0.92).setTranslation(x, y, z), 'rock');
    }
    this.addMerged(geoms, toonMaterial(COLORS.rock), { outline: 0.4 });
  }

  /** Journey-cloth waymarks along the road: tall poles, a small bright flag each, instanced for cheap. */
  buildBanners({ fromZ, toZ, every, side }) {
    const positions = [];
    for (let z = fromZ, index = 0; z >= toZ; z -= every, index++) {
      positions.push([canyonPathX(z) + (index % 2 === 0 ? -side : side), z]);
    }
    const poles = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.09, 0.12, 7, 5),
      toonMaterial(0x5a4632),
      positions.length,
    );
    const flags = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.6, 0.9, 0.06),
      toonMaterial(COLORS.megastructureGlow, { emissive: COLORS.megastructureGlow, emissiveIntensity: 0.9 }),
      positions.length,
    );
    const matrix = new THREE.Matrix4();
    positions.forEach(([x, z], index) => {
      const ground = terrainHeight(x, z);
      poles.setMatrixAt(index, matrix.makeTranslation(x, ground + 3.5, z));
      flags.setMatrixAt(index, matrix.makeTranslation(x + 0.85, ground + 6.2, z));
    });
    this.scene.add(poles, flags);
  }

  /** A rammed-earth watchtower: square, tapering, with a battlement ring on top. */
  buildBeaconTower(x, z, geoms) {
    const base = terrainHeight(x, z) - 1;
    const tower = pointsOf(faceted(new THREE.CylinderGeometry(2.1, 3.0, 12, 4).rotateY(Math.PI / 4).translate(x, base + 6, z)));
    geoms.push(new ConvexGeometry(tower));
    this.addConvexCollider(tower, 'rock');
    const cap = pointsOf(faceted(new THREE.CylinderGeometry(3.0, 2.3, 1.4, 4).rotateY(Math.PI / 4).translate(x, base + 12.6, z)));
    geoms.push(new ConvexGeometry(cap));
    this.addConvexCollider(cap, 'rock');
  }

  /** A dead transmission pylon: a tapered lattice mast with two crossarms, marching off to nowhere. */
  buildPylon(x, z, geoms) {
    const base = terrainHeight(x, z) - 1;
    const body = pointsOf(faceted(new THREE.CylinderGeometry(0.55, 1.3, 26, 4).rotateY(Math.PI / 4).translate(x, base + 13, z)));
    geoms.push(new ConvexGeometry(body));
    this.addConvexCollider(body, 'metal');
    for (const [level, span] of [[18, 6.5], [22, 4.5]]) {
      const arm = pointsOf(faceted(new THREE.BoxGeometry(span, 0.5, 0.5).translate(x, base + level, z)));
      geoms.push(new ConvexGeometry(arm));
      this.addConvexCollider(arm, 'metal');
    }
  }

  /** Desert poplars in autumn gold: clusters along the salt lake's shore. Decoration only — drive through them. */
  buildPoplarGroves() {
    const total = POPLAR_GROVES.reduce((sum, grove) => sum + grove.count, 0);
    const trunks = new THREE.InstancedMesh(
      faceted(new THREE.CylinderGeometry(0.22, 0.42, 4.4, 5).translate(0, 2.2, 0)),
      toonMaterial(COLORS.poplarTrunk), total,
    );
    const canopies = new THREE.InstancedMesh(faceted(new THREE.IcosahedronGeometry(2.0, 0)), toonMaterial(COLORS.poplarLeaf), total);
    trunks.castShadow = canopies.castShadow = true;
    const matrix = new THREE.Matrix4();
    let placed = 0;
    for (const grove of POPLAR_GROVES) {
      for (let index = 0; index < grove.count; index++) {
        const angle = this.random() * Math.PI * 2;
        const distance = Math.sqrt(this.random()) * 26;
        const x = grove.at[0] + Math.cos(angle) * distance;
        const z = grove.at[1] + Math.sin(angle) * distance;
        const scale = THREE.MathUtils.lerp(0.75, 1.5, this.random());
        const ground = terrainHeight(x, z);
        matrix.compose(new THREE.Vector3(x, ground, z), new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale));
        trunks.setMatrixAt(placed, matrix);
        matrix.compose(
          new THREE.Vector3(x, ground + 4.4 * scale, z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.random() * Math.PI),
          new THREE.Vector3(scale * THREE.MathUtils.lerp(0.8, 1.3, this.random()), scale * THREE.MathUtils.lerp(0.9, 1.6, this.random()), scale),
        );
        canopies.setMatrixAt(placed++, matrix);
      }
    }
    this.scene.add(trunks, canopies);
  }

  // ---- The colossal ----

  /** The things too big to argue with: the dish farm, the wreck, the fallen ring, and the Spire. */
  buildMegastructures() {
    this.buildDishFarm();
    this.buildWreck();
    this.buildFallenRing();
    this.buildSpire();
  }

  /** A broken section of the ringway, lying where it fell in the deep dunes, sandfalls pouring off it. */
  buildFallenRing() {
    const [x, z] = FALLEN_RING.at;
    const ground = terrainHeight(x, z);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(FALLEN_RING.radius, FALLEN_RING.tube, 12, 48, FALLEN_RING.arc),
      toonMaterial(COLORS.megastructure),
    );
    ring.position.set(x, ground - FALLEN_RING.tube * 1.6, z);
    ring.rotation.set(0.95, 0.55, 0.3);
    this.scene.add(ring);

    // Sandfalls: bright curtains of pouring sand hanging off the dune crests nearby.
    this.sandfallMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          float flow = fract(vUv.y * 3.0 + uTime * 0.35 + sin(vUv.x * 21.0) * 0.06);
          float bands = smoothstep(0.25, 0.5, flow) * (1.0 - smoothstep(0.55, 0.8, flow));
          float edges = smoothstep(0.0, 0.2, vUv.x) * (1.0 - smoothstep(0.8, 1.0, vUv.x))
            * smoothstep(0.0, 0.25, vUv.y);
          float alpha = bands * edges * 0.5;
          gl_FragColor = vec4(vec3(0.94, 0.78, 0.55) * (0.75 + 0.25 * bands), alpha);
        }
      `,
    });
    for (const fall of SANDFALLS) {
      const curtain = new THREE.Mesh(new THREE.PlaneGeometry(fall.width, fall.height), this.sandfallMaterial);
      const groundHere = terrainHeight(fall.at[0], fall.at[1]);
      curtain.position.set(fall.at[0], groundHere + fall.height / 2 - 6, fall.at[1]);
      curtain.rotation.y = fall.yaw;
      this.scene.add(curtain);
    }
  }

  /** Giant dead dishes in the deep dunes, still tipped toward the sun they were built to drink. */
  buildDishFarm() {
    const { center, spread, count, minRadius, maxRadius } = DISH_FARM;
    const pylonGeoms = [];
    const bowlGeoms = [];
    const lipGeoms = [];
    for (let index = 0; index < count; index++) {
      const angle = this.random() * Math.PI * 2;
      const distance = Math.sqrt(this.random()) * spread;
      const x = center[0] + Math.cos(angle) * distance;
      const z = center[1] + Math.sin(angle) * distance;
      const base = terrainHeight(x, z) - 2;
      const radius = THREE.MathUtils.lerp(minRadius, maxRadius, this.random());
      const pylonHeight = radius * 0.8;

      const dish = new THREE.Group();
      const pylon = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.09, radius * 0.14, pylonHeight, 8));
      pylon.position.y = pylonHeight / 2;
      dish.add(pylon);
      const bowl = new THREE.Mesh(faceted(new THREE.SphereGeometry(radius, 14, 6, 0, Math.PI * 2, 0, 0.5)));
      bowl.position.y = pylonHeight;
      bowl.rotation.set(0.55, 0, -0.25); // tipped sunward, frozen mid-drink
      if (index % 3 === 0) {
        const lip = new THREE.Mesh(new THREE.TorusGeometry(radius * Math.sin(0.5), radius * 0.02, 6, 28).rotateX(Math.PI / 2));
        lip.position.y = radius * Math.cos(0.5);
        bowl.add(lip);
      }
      dish.add(bowl);
      dish.position.set(x, base, z);
      dish.rotation.y = this.random() * 0.6 - 0.3;
      dish.updateMatrixWorld(true);
      this.mergeInstead(pylon, pylonGeoms);
      this.mergeInstead(bowl, bowlGeoms);
      if (index % 3 === 0) this.mergeInstead(bowl.children[0], lipGeoms);
      this.addFixed(null, RAPIER.ColliderDesc.cylinder(pylonHeight / 2, radius * 0.12).setTranslation(x, base + pylonHeight / 2, z), 'metal');
    }
    this.addMerged(pylonGeoms, toonMaterial(COLORS.megastructure), { shadows: false });
    this.addMerged(bowlGeoms, toonMaterial(COLORS.dish, { side: THREE.DoubleSide }), { shadows: false });
    this.addMerged(lipGeoms, toonMaterial(COLORS.megastructureGlow, { emissive: COLORS.megastructureGlow, emissiveIntensity: 0.7 }), { shadows: false });
  }

  /** A wrecked hull the size of a town block, half-swallowed by the western dune sea. */
  buildWreck() {
    const { at, radius, length, heading } = WRECK;
    const group = new THREE.Group();
    const hullGeometry = faceted(new THREE.CylinderGeometry(radius, radius * 0.85, length, 12, 1, true));
    hullGeometry.rotateZ(Math.PI / 2); // the hull lies on its side, axis along X
    group.add(new THREE.Mesh(hullGeometry, toonMaterial(COLORS.wreck, { side: THREE.DoubleSide })));
    for (const [offset, roll] of [[-length * 0.3, 0.1], [0, -0.06], [length * 0.32, 0.18]]) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.04, 2.2, 6, 28, 4.4).rotateY(Math.PI / 2), toonMaterial(COLORS.megastructure));
      rib.position.x = offset;
      rib.rotation.x = roll;
      group.add(rib);
    }
    const ground = terrainHeight(at[0], at[1]);
    group.position.set(at[0], ground + radius * 0.25, at[1]);
    group.rotation.set(0, heading, 0.1);
    this.scene.add(group);
  }

  /** One immense spire where the dead power line was always heading. Its crown still breathes. */
  buildSpire() {
    const [x, z] = SPIRE.at;
    const base = terrainHeight(x, z) - 2;
    const tower = new THREE.Mesh(
      faceted(new THREE.CylinderGeometry(SPIRE.topRadius, SPIRE.baseRadius, SPIRE.height, 6)),
      toonMaterial(COLORS.megastructure),
    );
    tower.position.set(x, base + SPIRE.height / 2, z);
    this.scene.add(tower);
    this.spireCrown = new THREE.Mesh(
      new THREE.SphereGeometry(SPIRE.crownRadius, 10, 8),
      toonMaterial(COLORS.megastructureGlow, { emissive: COLORS.megastructureGlow, emissiveIntensity: 1.6 }),
    );
    this.spireCrown.position.set(x, base + SPIRE.height + SPIRE.crownRadius * 0.6, z);
    this.scene.add(this.spireCrown);
    this.addFixed(null, RAPIER.ColliderDesc.cylinder(SPIRE.height / 2, SPIRE.baseRadius * 0.7).setTranslation(x, base + SPIRE.height / 2, z), 'metal');
  }

  // ---- The New Silk Road and its community ----

  /**
   * The elevated freight line, riding up and over the dunes on a smoothed profile: deck segments that
   * pitch with the ground, pylons where the ground falls away, portals where it vanishes into the
   * range, and pods that never stop for anyone.
   */
  buildSilkLine() {
    const { z, clearance, minHeight, segmentLength, from, to, podOffsets, podColors } = SILK_LINE;
    const concrete = toonMaterial(0xcfc3ae);
    const glowMaterial = toonMaterial(COLORS.megastructureGlow, { emissive: COLORS.megastructureGlow, emissiveIntensity: 0.8 });
    const count = Math.round((to - from) / segmentLength);

    // The profile: clear the highest ground in each segment, then smooth so the pods don't stair-step.
    const heights = [];
    for (let index = 0; index <= count; index++) {
      const x = from + index * segmentLength;
      heights.push(Math.max(minHeight, terrainHeight(x, z) + clearance));
    }
    for (let pass = 0; pass < 3; pass++) {
      for (let index = 1; index < count; index++) {
        heights[index] = Math.max(minHeight, (heights[index - 1] + heights[index] * 2 + heights[index + 1]) / 4);
      }
    }
    this.silkHeights = { from, segmentLength, heights };

    const deckGeoms = [];
    const stripGeoms = [];
    const pylonGeoms = [];
    for (let index = 0; index < count; index++) {
      const x = from + (index + 0.5) * segmentLength;
      const pitch = Math.atan2(heights[index + 1] - heights[index], segmentLength);
      const deck = new THREE.Mesh(new THREE.BoxGeometry(segmentLength + 2, 1.4, 9));
      deck.position.set(x, (heights[index] + heights[index + 1]) / 2, z);
      deck.rotation.z = pitch;
      this.mergeInstead(deck, deckGeoms);
      if (index % 2 === 0) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(segmentLength / 2, 0.18, 0.18));
        strip.position.set(0, 0.85, -4.3);
        deck.add(strip);
        this.mergeInstead(strip, stripGeoms);
      }
      const ground = terrainHeight(from + index * segmentLength, z) - 2;
      const pylonHeight = heights[index] - ground;
      if (pylonHeight > 5) {
        const px = from + index * segmentLength;
        const pylon = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.4, pylonHeight, 8));
        pylon.position.set(px, ground + pylonHeight / 2, z);
        this.mergeInstead(pylon, pylonGeoms);
        this.addFixed(null, RAPIER.ColliderDesc.cylinder(pylonHeight / 2, 1.9).setTranslation(px, ground + pylonHeight / 2, z), 'concrete');
      }
    }
    this.addMerged(deckGeoms, concrete);
    this.addMerged(stripGeoms, glowMaterial, { shadows: false });
    this.addMerged(pylonGeoms, concrete);
    // Where the line meets the valley wall it dives into a portal, not a dead end.
    for (const end of [from, to]) {
      const portal = toonMesh(new THREE.BoxGeometry(6, 22, 16), COLORS.megastructure, { outline: 0.3 });
      portal.position.set(end, terrainHeight(end, z) + 9, z);
      this.scene.add(portal);
    }

    podOffsets.forEach((offset, index) => {
      const pod = new THREE.Group();
      pod.add(toonMesh(new THREE.BoxGeometry(7, 2.6, 3.1), podColors[index % podColors.length], { outline: 0.1 }));
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.5, 2.6), glowMaterial);
      strip.position.x = 3.6;
      pod.add(strip);
      // Start each pod where its animation phase puts it, so nothing snaps on the first step.
      const span = to - from;
      const startX = from + ((offset % span) + span) % span;
      pod.position.set(startX, this.silkLineYAt(startX) + 2.1, z + (index % 2 === 0 ? -1.8 : 1.8));
      this.scene.add(pod);
      // Pods are real kinematic bodies: get in the way of the Silk Road and it will move *you*.
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(pod.position.x, pod.position.y, pod.position.z));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(3.5, 1.3, 1.55).setMass(8000), body);
      this.silkPods.push({ body, group: pod, offset, lane: pod.position.z });
    });
  }

  /** Advances the pod clock and claims each pod's next kinematic pose; Game calls this before world.step. */
  stepPods(dt) {
    this.podClock += dt;
    const span = SILK_LINE.to - SILK_LINE.from;
    for (const pod of this.silkPods) {
      const x = SILK_LINE.from + ((this.podClock * SILK_LINE.podSpeed + pod.offset) % span);
      const y = this.silkLineYAt(x) + 2.1;
      pod.body.setNextKinematicTranslation({ x, y, z: pod.lane });
    }
  }

  /** The deck's height above datum at x, interpolating the smoothed segment profile. */
  silkLineYAt(x) {
    const { from, segmentLength, heights } = this.silkHeights;
    const t = THREE.MathUtils.clamp((x - from) / segmentLength, 0, heights.length - 1.001);
    const index = Math.floor(t);
    return THREE.MathUtils.lerp(heights[index], heights[index + 1], t - index);
  }

  /** 拾风 — Scrapwind Yard: container homes, work canopies, string lights and a gate sign, north of the line. */
  buildSettlement() {
    const [centerX, centerZ] = SETTLEMENT.center;
    const ground = (x, z) => terrainHeight(x, z);
    const at = (local, y = 0) => new THREE.Vector3(centerX + local[0], ground(centerX + local[0], centerZ + local[1]) + y, centerZ + local[1]);
    const containersByColor = new Map(); // one merged mesh per paint colour
    const steelGeoms = [];
    const postGeoms = [];
    const roofGeoms = [];
    const solarGeoms = [];

    // Container buildings, two of them stacked.
    const containers = [
      { local: [-14, -6], size: [7, 2.8, 3], color: 0xb85c42, heading: 0.08 },
      { local: [-13.5, -1.6], size: [7, 2.8, 3], color: 0x3f8f8a, heading: -0.04 },
      { local: [-13.5, -1.6], size: [7, 2.8, 3], color: 0xd8d2c4, heading: 0.03, lift: 2.8 },
      { local: [12, -8], size: [6, 2.6, 3], color: 0xd8d2c4, heading: -0.5 },
      { local: [16, 2], size: [7, 2.8, 3], color: 0xb85c42, heading: 0.35 },
      { local: [-2, 14], size: [6, 2.6, 3], color: 0x3f8f8a, heading: 1.1 },
    ];
    for (const container of containers) {
      const size = new THREE.Vector3(...container.size);
      const position = at(container.local, size.y / 2 + (container.lift ?? 0));
      const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), container.heading);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z));
      mesh.position.copy(position);
      mesh.quaternion.copy(quaternion);
      if (!containersByColor.has(container.color)) containersByColor.set(container.color, []);
      this.mergeInstead(mesh, containersByColor.get(container.color));
      const description = RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setTranslation(position.x, position.y, position.z)
        .setRotation(quaternion);
      this.addFixed(null, description, 'metal');
    }

    // Work canopies: a flat roof on poles, one wearing solar tiles. (Vehicles charge at the Yard Relay, not here.)
    for (const [local, solar] of [[[-2, -2], true], [[8, 6], false]]) {
      const origin = at(local);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(6, 0.15, 5));
      roof.position.copy(origin).y += 3;
      this.mergeInstead(roof, roofGeoms);
      for (const [dx, dz] of [[-2.7, -2.2], [2.7, -2.2], [-2.7, 2.2], [2.7, 2.2]]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3, 6));
        pole.position.copy(origin).add(new THREE.Vector3(dx, 1.5, dz));
        this.mergeInstead(pole, steelGeoms);
      }
      if (solar) {
        for (const dx of [-1.5, 0, 1.5]) {
          const tile = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.05, 4.4));
          tile.position.copy(origin).add(new THREE.Vector3(dx, 3.15, 0));
          tile.rotation.z = 0.18;
          this.mergeInstead(tile, solarGeoms);
        }
      }
    }

    // The water tank, on legs.
    const tankOrigin = at([2, -14]);
    const tank = toonMesh(new THREE.CylinderGeometry(1.6, 1.6, 2.6, 10), 0x8a9496, { outline: 0.06 });
    tank.position.copy(tankOrigin).y += 3.4;
    this.scene.add(tank);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.2, 6));
      leg.position.copy(tankOrigin).add(new THREE.Vector3(dx, 1.1, dz));
      this.mergeInstead(leg, steelGeoms);
    }

    // String lights around the plaza.
    const poleTops = STRING_POLES.map(local => at(local, 3.6));
    this.addStringLights(poleTops);
    for (const top of poleTops) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 3.6, 6));
      pole.position.set(top.x, top.y - 1.8, top.z);
      this.mergeInstead(pole, postGeoms);
    }

    // The gate sign on the road in: 拾风, "gathering wind" — what the Yard calls itself.
    const signOrigin = at([-20, 6]);
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(4.6, 2.3, 0.15),
      new THREE.MeshBasicMaterial({ map: signTexture('拾风', 'SCRAPWIND YARD') }),
    );
    board.position.copy(signOrigin).y += 3.2;
    board.rotation.y = 0.9;
    this.scene.add(board);
    for (const dx of [-1.9, 1.9]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 4.4, 6));
      post.position.copy(signOrigin).add(new THREE.Vector3(dx, 2.2, 0));
      this.mergeInstead(post, postGeoms);
    }

    for (const [color, geoms] of containersByColor) this.addMerged(geoms, toonMaterial(color), { outline: 0.06 });
    this.addMerged(steelGeoms, toonMaterial(0x5f6a70));
    this.addMerged(postGeoms, toonMaterial(0x5a4632));
    this.addMerged(roofGeoms, toonMaterial(0xd8d2c4), { outline: 0.04 });
    this.addMerged(solarGeoms, toonMaterial(0x24344a));
  }

  /**
   * The fair circuit: packed earth laid round the fair ground, with whoops to bounce through, a
   * table-top to catch air, glowing gates to thread, and a start/finish line by the village gate.
   * The road is real surface: grippier and freer-rolling than the gravel around it.
   */
  buildFairTrack() {
    const { segments: count, width } = FAIR_TRACK;
    const geoms = [];
    for (let index = 0; index < count; index++) {
      const t0 = (index / count) * Math.PI * 2;
      const t1 = ((index + 1) / count) * Math.PI * 2;
      const [ax, az] = fairPoint(t0);
      const [bx, bz] = fairPoint(t1);
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      const length = Math.hypot(bx - ax, bz - az) + 1.5;
      const heading = Math.atan2(bx - ax, bz - az);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.08, length));
      mesh.position.set(mx, terrainHeight(mx, mz) + 0.04, mz);
      mesh.rotation.y = heading;
      this.mergeInstead(mesh, geoms);
      const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
      this.addFixed(null, RAPIER.ColliderDesc.cuboid(width / 2, 0.04, length / 2)
        .setTranslation(mx, terrainHeight(mx, mz) + 0.04, mz).setRotation(quaternion), 'road');
    }
    this.addMerged(geoms, toonMaterial(COLORS.road));

    // The spur from the village sign to the start line.
    const spur = [[70, 178], [35, 186], [0, 197]];
    const spurGeoms = [];
    for (let index = 0; index < spur.length - 1; index++) {
      const [ax, az] = spur[index];
      const [bx, bz] = spur[index + 1];
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      const length = Math.hypot(bx - ax, bz - az) + 2;
      const heading = Math.atan2(bx - ax, bz - az);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.08, length));
      mesh.position.set(mx, terrainHeight(mx, mz) + 0.04, mz);
      mesh.rotation.y = heading;
      this.mergeInstead(mesh, spurGeoms);
      const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
      this.addFixed(null, RAPIER.ColliderDesc.cuboid(width / 2, 0.04, length / 2)
        .setTranslation(mx, terrainHeight(mx, mz) + 0.04, mz).setRotation(quaternion), 'road');
    }
    this.addMerged(spurGeoms, toonMaterial(COLORS.road));

    for (const t of [0.18, 0.62]) this.buildWhoops(t);
    this.buildTrackTableTop(0.5);
    for (const t of [0.1, 0.4, 0.9]) this.buildTrackGate(t);
  }

  /** Whoops: a run of small lying cylinders across the road at circuit angle t. */
  buildWhoops(t) {
    const angle = t * Math.PI * 2;
    const [px, pz] = fairPoint(angle);
    const [tx, tz] = fairTangent(angle);
    const geoms = [];
    const heading = Math.atan2(tx, tz); // cylinders lie across the road: axis ⟂ travel
    const across = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, heading, Math.PI / 2));
    for (let index = 0; index < 5; index++) {
      const x = px + tx * index * 2.4;
      const z = pz + tz * index * 2.4;
      const ground = terrainHeight(x, z) + 0.08;
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, FAIR_TRACK.width, 10).rotateZ(Math.PI / 2));
      mesh.position.set(x, ground + 0.35, z);
      mesh.rotation.y = heading;
      this.mergeInstead(mesh, geoms);
      const position = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
      this.addFixed(null, RAPIER.ColliderDesc.cylinder(FAIR_TRACK.width / 2, 0.55)
        .setTranslation(x, ground + 0.35, z).setRotation(position.multiply(across)), 'rock');
    }
    this.addMerged(geoms, toonMaterial(COLORS.bump));
  }

  /** A table-top laid on the racing line at circuit angle t, for a lap with airtime in it. */
  buildTrackTableTop(t) {
    const angle = t * Math.PI * 2;
    const [px, pz] = fairPoint(angle);
    const [tx, tz] = fairTangent(angle);
    const heading = Math.atan2(-tx, -tz); // wedgePoints rise toward −Z; aim that way down the road
    const profile = [[0, 0], [-8, 2.2], [-20, 2.2], [-28, 0]];
    const points = profile.flatMap(([z, y]) => [new THREE.Vector3(-FAIR_TRACK.width / 2, y, z), new THREE.Vector3(FAIR_TRACK.width / 2, y, z)]);
    this.addConvex(placePoints(points, [px, pz], heading), COLORS.tableTop, 'metal');
  }

  /** A glowing gate straddling the road at circuit angle t: thread it on the racing line. */
  buildTrackGate(t) {
    const angle = t * Math.PI * 2;
    const [px, pz] = fairPoint(angle);
    const [tx, tz] = fairTangent(angle);
    const nx = tz;
    const nz = -tx; // across the road
    const geoms = [];
    const glowGeoms = [];
    const glowMaterial = toonMaterial(COLORS.megastructureGlow, { emissive: COLORS.megastructureGlow, emissiveIntensity: 1.2 });
    const beamHeading = Math.atan2(-nz, nx);
    for (const side of [-1, 1]) {
      const x = px + nx * side * (FAIR_TRACK.width / 2 + 0.6);
      const z = pz + nz * side * (FAIR_TRACK.width / 2 + 0.6);
      const ground = terrainHeight(x, z);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 7, 6));
      post.position.set(x, ground + 3.5, z);
      this.mergeInstead(post, geoms);
      this.addFixed(null, RAPIER.ColliderDesc.cylinder(3.5, 0.2).setTranslation(x, ground + 3.5, z), 'metal');
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(FAIR_TRACK.width + 2.4, 0.25, 0.3));
    beam.position.set(px, terrainHeight(px, pz) + 6.8, pz);
    beam.rotation.y = beamHeading;
    this.mergeInstead(beam, glowGeoms);
    this.addMerged(geoms, toonMaterial(COLORS.megastructure));
    this.addMerged(glowGeoms, glowMaterial, { shadows: false });
  }

  /**
   * The fair ground inside the circuit: a turning Ferris wheel whose gondolas stay level, a spinning
   * carousel, striped stalls, a big-top tent, and string lights everywhere. The Yard at play.
   */
  buildFairground() {
    const [cx, cz] = FAIR.center;
    const ground = (x, z) => terrainHeight(x, z);
    const steelGeoms = [];
    const woodGeoms = [];
    const stripeRedGeoms = [];
    const stripePaleGeoms = [];
    const tentGeoms = [];
    const glowMaterial = toonMaterial(COLORS.megastructureGlow, { emissive: COLORS.megastructureGlow, emissiveIntensity: 1.1 });
    const stripeRed = toonMaterial(COLORS.stripeRed);
    const stripePale = toonMaterial(COLORS.stripePale);

    // The Ferris wheel: a turning rim with gondolas that stay level, on two A-frames.
    const fx = cx - 50;
    const fz = cz;
    const root = new THREE.Group();
    root.position.set(fx, ground(fx, fz), fz);
    root.rotation.y = Math.PI / 2; // the wheel's plane faces north–south, so the village sees it full
    const wheel = new THREE.Group();
    wheel.position.y = 23;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(20, 0.45, 8, 40), glowMaterial.clone());
    rim.material.emissiveIntensity = 0.7;
    wheel.add(rim);
    const spokeGeoms = [];
    for (let index = 0; index < 8; index++) {
      const spoke = new THREE.BoxGeometry(0.28, 39.4, 0.28);
      spoke.rotateZ((index / 8) * Math.PI);
      spokeGeoms.push(this.prep(spoke));
    }
    wheel.add(new THREE.Mesh(mergeGeometries(spokeGeoms), toonMaterial(COLORS.megastructure)));
    this.ferrisGondolas = [];
    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      const gondola = new THREE.Group();
      gondola.position.set(Math.cos(angle) * 20, Math.sin(angle) * 20, 0);
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 1.4),
        toonMaterial(index % 2 === 0 ? COLORS.stripeRed : COLORS.tent));
      cabin.position.y = -1.3;
      gondola.add(cabin);
      wheel.add(gondola);
      this.ferrisGondolas.push(gondola);
    }
    root.add(wheel);
    this.ferrisWheel = wheel;
    // Supports are static: legs splay in the wheel's plane (world YZ after the root's turn) and
    // bake into the merged steel batch; the wheel itself stays an animated group of its own.
    for (const side of [-2, 2]) {
      for (const lean of [-0.3, 0.3]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 24, 0.5));
        leg.position.set(fx, ground(fx, fz) + 11.5, fz + lean * 11);
        leg.rotation.x = -lean;
        this.mergeInstead(leg, steelGeoms);
        this.addFixed(null, RAPIER.ColliderDesc.cuboid(0.25, 12, 0.25)
          .setTranslation(fx, ground(fx, fz) + 11.5, fz + lean * 11)
          .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -lean)), 'metal');
      }
    }
    this.scene.add(root);

    // The carousel: a platform that turns, cups that spin on top of that.
    const platform = new THREE.Group();
    const px = cx + 25;
    const pz = cz - 15;
    platform.position.set(px, ground(px, pz) + 0.2, pz);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(6, 6.2, 0.4, 16), toonMaterial(COLORS.booth));
    platform.add(disc);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 4.2, 8), toonMaterial(COLORS.megastructure));
    pole.position.y = 2.1;
    platform.add(pole);
    this.carouselCups = [];
    for (let index = 0; index < 6; index++) {
      const angle = (index / 6) * Math.PI * 2;
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.75, 0.95, 10),
        toonMaterial(index % 2 === 0 ? COLORS.stripeRed : COLORS.stripePale));
      cup.position.set(Math.cos(angle) * 4.2, 0.75, Math.sin(angle) * 4.2);
      platform.add(cup);
      this.carouselCups.push(cup);
    }
    this.carouselPlatform = platform;
    this.scene.add(platform);
    this.addFixed(null, RAPIER.ColliderDesc.cylinder(0.25, 6.2).setTranslation(px, ground(px, pz) + 0.25, pz), 'metal');

    // Stalls with striped awnings along the east side.
    for (let index = 0; index < 4; index++) {
      const sx = cx + 60;
      const sz = cz - 30 + index * 20;
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2, 1.8));
      body.position.set(sx, ground(sx, sz) + 1, sz);
      this.mergeInstead(body, woodGeoms);
      this.addFixed(null, RAPIER.ColliderDesc.cuboid(1.3, 1, 0.9).setTranslation(sx, ground(sx, sz) + 1, sz), 'metal');
      for (let stripe = 0; stripe < 3; stripe++) {
        const awning = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 2.2));
        awning.position.set(sx - 0.8 + stripe * 0.9, ground(sx, sz) + 2.35, sz - 0.4);
        awning.rotation.x = 0.25;
        this.mergeInstead(awning, stripe % 2 === 0 ? stripeRedGeoms : stripePaleGeoms);
      }
    }

    // The big top: a striped cone with a pennant, big enough to drive around, not through.
    const tx = cx - 10;
    const tz = cz + 45;
    const tent = new THREE.Mesh(faceted(new THREE.ConeGeometry(9, 8, 10).translate(tx, ground(tx, tz) + 4, tz)), toonMaterial(COLORS.tent));
    this.mergeInstead(tent, tentGeoms);
    const pennant = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 0.04), glowMaterial);
    pennant.position.set(tx, ground(tx, tz) + 8.4, tz);
    this.scene.add(pennant);
    this.addFixed(null, RAPIER.ColliderDesc.cylinder(4, 8.6).setTranslation(tx, ground(tx, tz) + 4, tz), 'metal');

    // Bunting poles in a ring, with string lights strung between them.
    const poleTops = [];
    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      const x = cx + Math.cos(angle) * 90;
      const z = cz + Math.sin(angle) * 90;
      const top = ground(x, z) + 4;
      poleTops.push(new THREE.Vector3(x, top, z));
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 4, 6));
      pole.position.set(x, top - 2, z);
      this.mergeInstead(pole, woodGeoms);
    }
    poleTops.push(poleTops[0].clone()); // close the ring
    this.addStringLights(poleTops);

    this.addMerged(steelGeoms, toonMaterial(COLORS.megastructure));
    this.addMerged(woodGeoms, toonMaterial(COLORS.booth), { outline: 0.05 });
    this.addMerged(stripeRedGeoms, stripeRed);
    this.addMerged(stripePaleGeoms, stripePale);
    this.addMerged(tentGeoms, toonMaterial(COLORS.tent), { outline: 0.3 });
  }

  /** Bulbs strung along a sagging wire through the given pole tops; the poles are the caller's. */
  addStringLights(poleTops) {
    const bulbs = [];
    for (let pole = 0; pole < poleTops.length - 1; pole++) {
      for (let step = 1; step < 12; step++) {
        const t = step / 12;
        const point = poleTops[pole].clone().lerp(poleTops[pole + 1], t);
        point.y -= Math.sin(Math.PI * t) * 1.1;
        bulbs.push(point);
      }
    }
    const material = toonMaterial(0xffd9a0, { emissive: 0xffd9a0, emissiveIntensity: 1.6 });
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 6, 4), material, bulbs.length);
    const matrix = new THREE.Matrix4();
    bulbs.forEach((point, index) => mesh.setMatrixAt(index, matrix.makeTranslation(point.x, point.y, point.z)));
    this.scene.add(mesh);
  }

  /**
   * The still places: shallow pools that hold the sky. No render targets — the water answers the
   * dome with almost the same maths, a hand mirror instead of a photograph. Ripples are a breath,
   * not a storm. A basalt monolith stands in each one, seams faintly lit.
   */
  buildPools() {
    this.poolMaterial = new THREE.ShaderMaterial({
      transparent: true,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          moonDirection: { value: MOON_DIRECTION },
          moonRadius: { value: MOON_RADIUS },
          moonPale: { value: new THREE.Color(MOON_PALE) },
          sunDirection: { value: SUN_DIRECTION },
          sunColor: { value: new THREE.Color(0xfff3d8) },
          zenithColor: { value: new THREE.Color(0x2e6ed4) },
          horizonColor: { value: new THREE.Color(0xffcf8e) },
          waterTint: { value: new THREE.Color(0x6fc8bc) },
        },
      ]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        varying vec2 vUv;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          vec4 mvPosition = viewMatrix * world;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform float uTime;
        uniform vec3 moonDirection;
        uniform float moonRadius;
        uniform vec3 moonPale;
        uniform vec3 sunDirection;
        uniform vec3 sunColor;
        uniform vec3 zenithColor;
        uniform vec3 horizonColor;
        uniform vec3 waterTint;
        varying vec2 vUv;
        varying vec3 vWorld;

        /** The sky the pool answers: the dome's gradient, the moon's disk, the sun's wash. */
        vec3 skyAnswer(vec3 dir) {
          float h = max(dir.y, 0.0);
          vec3 color = mix(horizonColor, zenithColor, smoothstep(0.0, 0.5, h));
          vec3 moonN = normalize(moonDirection);
          vec3 offset = dir - moonN * dot(dir, moonN);
          float disk = 1.0 - smoothstep(moonRadius - 0.003, moonRadius, length(offset));
          color = mix(color, moonPale * 1.25, disk * 0.9);
          float toMoon = max(dot(dir, moonN), 0.0);
          color += moonPale * pow(toMoon, 24.0) * 0.18;
          float toSun = max(dot(dir, normalize(sunDirection)), 0.0);
          color += sunColor * pow(toSun, 8.0) * 0.12;
          return color;
        }

        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float shore = 1.0 - smoothstep(0.72, 0.98, r);
          // A breath of ripple tilts the mirror; the sky smears, never breaks.
          vec3 view = normalize(vWorld - cameraPosition);
          vec3 mirrored = reflect(view, vec3(0.0, 1.0, 0.0));
          mirrored.y = abs(mirrored.y);
          float ripple = sin(vWorld.x * 0.9 + uTime * 0.6) * cos(vWorld.z * 1.1 - uTime * 0.45);
          mirrored = normalize(mirrored + vec3(ripple * 0.016, 0.0, sin(vWorld.x * 0.7 - uTime * 0.5) * 0.012));
          vec3 color = skyAnswer(mirrored);
          // Shallow at the shore: the tint of the ground beneath shows through.
          color = mix(waterTint * 0.8, color, smoothstep(1.0, 0.55, r));
          // The grid's edge: a faint teal rim where the water meets the land.
          color += vec3(0.25, 0.9, 0.8) * pow(max(0.0, 1.0 - abs(r - 0.94) * 16.0), 2.0) * 0.45;
          gl_FragColor = vec4(color, shore);
          #include <fog_fragment>
        }
      `,
    });

    const glowMaterial = toonMaterial(COLORS.megastructureGlow, { emissive: COLORS.megastructureGlow, emissiveIntensity: 1.1 });
    const slabMaterial = toonMaterial(COLORS.megastructure);
    for (const pool of POOLS) {
      const [cx, cz] = pool.at;
      const y = terrainHeight(cx, cz) + 0.05;
      // A wobbled blob, stretched along its heading, level as poured glass.
      const shape = new THREE.Shape();
      const corners = 16;
      for (let index = 0; index <= corners; index++) {
        const angle = (index / corners) * Math.PI * 2;
        const wobble = 1 + Math.sin(angle * 3 + pool.heading * 7) * 0.12 + Math.sin(angle * 5 + 2) * 0.07;
        const x = Math.cos(angle) * pool.radius * wobble;
        const z = Math.sin(angle) * pool.radius * wobble * pool.stretch;
        const px = x * Math.cos(pool.heading) - z * Math.sin(pool.heading);
        const pz = x * Math.sin(pool.heading) + z * Math.cos(pool.heading);
        if (index === 0) shape.moveTo(px, pz);
        else shape.lineTo(px, pz);
      }
      const geometry = new THREE.ShapeGeometry(shape, 24);
      geometry.rotateX(-Math.PI / 2);
      const poolMesh = new THREE.Mesh(geometry, this.poolMaterial);
      poolMesh.position.set(cx, y, cz);
      poolMesh.renderOrder = 1;
      this.scene.add(poolMesh);
      // Water under the wheels: a thin slab the tyres can sense.
      this.addFixed(null, RAPIER.ColliderDesc.cylinder(0.02, pool.radius * 0.8)
        .setTranslation(cx, y - 0.02, cz), 'water');
      // The monolith: standing, slightly off vertical, one lit seam.
      const mx = cx + Math.cos(pool.heading) * pool.radius * 0.35;
      const mz = cz + Math.sin(pool.heading) * pool.radius * 0.35;
      const slab = toonMesh(new THREE.BoxGeometry(1.4, 7, 0.6), slabMaterial, { outline: 0.06 });
      slab.position.set(mx, y + 2.9, mz);
      slab.rotation.y = pool.heading + 0.5;
      slab.rotation.z = 0.045;
      this.scene.add(slab);
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.07, 6.2, 0.02), glowMaterial);
      seam.position.set(0, 0, 0.31);
      slab.add(seam);
      const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, slab.rotation.y, slab.rotation.z));
      this.addFixed(null, RAPIER.ColliderDesc.cuboid(0.7, 3.5, 0.3)
        .setTranslation(mx, y + 2.9, mz).setRotation(quaternion), 'metal');
    }
  }

  /** Glowing hex plates that refill a vehicle's surge capacitors: the old grid, still generous. */
  buildBoostPads() {
    this.boostPadMaterial = toonMaterial(COLORS.boostPad, { emissive: COLORS.boostPad, emissiveIntensity: 1.3 });
    const baseGeoms = [];
    const glowGeoms = [];
    for (const pad of BOOST_PADS) {
      const x = pad.at ? pad.at[0] : pad.salt ? WORLD.salt.center[0]
        : pad.fairStart ? fairPoint(0)[0] : canyonPathX(pad.roadZ);
      const z = pad.at ? pad.at[1] : pad.salt ? WORLD.salt.center[1]
        : pad.fairStart ? fairPoint(0)[1] : pad.roadZ;
      const y = terrainHeight(x, z);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(pad.radius, pad.radius * 1.08, 0.12, 6));
      base.position.set(x, y + 0.06, z);
      this.mergeInstead(base, baseGeoms);
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(pad.radius * 0.72, pad.radius * 0.72, 0.06, 6));
      plate.position.set(x, y + 0.15, z);
      this.mergeInstead(plate, glowGeoms);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(pad.radius * 0.9, 0.1, 6, 24).rotateX(Math.PI / 2));
      ring.position.set(x, y + 0.16, z);
      this.mergeInstead(ring, glowGeoms);
      this.boostPads.push({ x, z, y, radius: pad.radius });
    }
    this.addMerged(baseGeoms, toonMaterial(COLORS.pad));
    this.addMerged(glowGeoms, this.boostPadMaterial, { shadows: false });
  }
}

/** The old trade road through the canyon: where the canyon floor's x wanders as it runs north (−z). */
function canyonPathX(z) {
  return 150 * Math.sin(z * 0.0011) + 60 * Math.sin(z * 0.0027 + 1.7);
}

/** A point on the fair circuit at angle t (t = 0 is the start/finish line by the village gate). */
export function fairPoint(t) {
  const r = FAIR_TRACK.baseRadius + FAIR_TRACK.wave * Math.sin(2 * t) + FAIR_TRACK.wave2 * Math.sin(3 * t + 1);
  return [FAIR_TRACK.center[0] + Math.sin(t) * r, FAIR_TRACK.center[1] - Math.cos(t) * r];
}

/** The circuit's unit travel direction at angle t, as [x, z]. */
export function fairTangent(t) {
  const e = 0.002;
  const [ax, az] = fairPoint(t - e);
  const [bx, bz] = fairPoint(t + e);
  const length = Math.hypot(bx - ax, bz - az);
  return [(bx - ax) / length, (bz - az) / length];
}

/** How deep (x, z) sits inside the canyon corridor: 1 on the road, 0 in the walls. */
function canyonCorridor(x, z) {
  return Math.exp(-(((x - canyonPathX(z)) / WORLD.canyon.width) ** 2));
}

/** Ground height of the bare terrain at (x, z), before any features sit on it. */
export function terrainHeight(x, z) {
  const distance = Math.hypot(x, z);

  // West: the dune sea — long sharp-crested ridges, big enough to surf and to get lost in.
  const duneMask = smoothstep(WORLD.duneSea.start, WORLD.duneSea.full, -x);
  const ridgePhase = (x * 0.8 + z * 0.6) * (Math.PI * 2 / WORLD.duneSea.wavelength) + Math.sin(z * 0.004) * 0.8;
  const duneSea = duneMask * (Math.pow(Math.abs(Math.sin(ridgePhase)), 0.75) * WORLD.duneSea.height
    + 8 * Math.sin(x * 0.006) * Math.cos(z * 0.005));

  // South: soft meadows with marsh dips sunk into them.
  const southMask = smoothstep(WORLD.south.start, WORLD.south.full, z);
  const meadow = southMask * (4 * Math.sin(x * 0.01 + 2) * Math.cos(z * 0.008)
    - 2.5 * Math.pow(Math.max(0, Math.sin(x * 0.017 - z * 0.013)), 2));

  // North: red rock rising, with the trade-road corridor carved through it and climbing gently.
  const northMask = smoothstep(-WORLD.canyon.start, -WORLD.canyon.full, -z);
  const corridor = canyonCorridor(x, z);
  const wallGrowth = smoothstep(-WORLD.canyon.start, WORLD.canyon.full, z);
  const wallHeight = WORLD.canyon.wallBase + (WORLD.canyon.wallFull - WORLD.canyon.wallBase) * wallGrowth;
  const canyon = northMask * (
    wallHeight * (1 - corridor) * (1 + 0.18 * Math.sin(x * 0.03) * Math.sin(z * 0.024))
    + corridor * wallGrowth * WORLD.canyon.floorRise
  );

  // East: rolling ground climbing toward the dish field.
  const eastRoll = smoothstep(WORLD.east.start, WORLD.east.full, x)
    * (WORLD.east.height + 6 * Math.sin(x * 0.008) * Math.sin(z * 0.006));

  // Everywhere ends at the valley wall: a jagged mountain ring.
  const rimT = smoothstep(WORLD.rimStart, WORLD.rimFull, Math.max(Math.abs(x), Math.abs(z)));
  const rim = rimT * (WORLD.rimHeight + 120 * Math.sin(Math.atan2(z, x) * 7 + 1) + 60 * Math.sin(x * 0.01) * Math.sin(z * 0.009));

  let height = duneSea + meadow + canyon + eastRoll + rim;

  // The salt pan is pressed dead flat into whatever was there.
  const [saltX, saltZ] = WORLD.salt.center;
  const saltMask = 1 - smoothstep(WORLD.salt.radius * 0.75, WORLD.salt.radius, Math.hypot(x - saltX, z - saltZ));
  height = THREE.MathUtils.lerp(height, WORLD.salt.height, saltMask);

  // The home basin flattens everything around the start.
  const basinMask = 1 - smoothstep(WORLD.basinRadius * 0.8, WORLD.basinRadius, distance);
  return THREE.MathUtils.lerp(height, 0, basinMask) + yardangHeight(x, z);
}

/** Yardangs: sharp-crested ridges the wind carved out of the hardpan, running east–west. */
function yardangHeight(x, z) {
  const nx = (x - YARDANGS.center[0]) / YARDANGS.radii[0];
  const nz = (z - YARDANGS.center[1]) / YARDANGS.radii[1];
  const within = 1 - smoothstep(0.7, 1, Math.hypot(nx, nz));
  if (within <= 0) return 0;
  const ridge = Math.pow(Math.max(0, Math.sin(z * 0.105)), 1.5) + 0.35 * Math.pow(Math.max(0, Math.sin(z * 0.105 + x * 0.02)), 2);
  return within * ridge * YARDANGS.height;
}

// The palette: a color script along the road — gold home, white salt, red canyon, pale ash east.
const DUNE_GOLD = new THREE.Color(0xe0b070);
const MEADOW_OLIVE = new THREE.Color(0xa89a5a);
const CANYON_RED = new THREE.Color(0xa8503c);
const ASH_PALE = new THREE.Color(0xb8b0a4);
const RIM_DARK = new THREE.Color(0x6e4438);
const SNOW = new THREE.Color(0xf5f2ee);

function terrainColor(x, y, z, random, target) {
  target.set(SURFACES.dirt.color);
  target.lerp(DUNE_GOLD, smoothstep(450, 900, -x));
  target.lerp(MEADOW_OLIVE, smoothstep(WORLD.south.start, WORLD.south.full, z) * 0.55);
  target.lerp(CANYON_RED, smoothstep(-WORLD.canyon.start, -900, -z) * THREE.MathUtils.clamp(y / 50, 0, 1));
  target.lerp(ASH_PALE, smoothstep(1700, 2300, x) * 0.7);
  const [saltX, saltZ] = WORLD.salt.center;
  const saltMask = 1 - smoothstep(WORLD.salt.radius * 0.7, WORLD.salt.radius, Math.hypot(x - saltX, z - saltZ));
  target.lerp(new THREE.Color(SURFACES.salt.color), saltMask);
  target.lerp(RIM_DARK, smoothstep(120, 260, y));
  target.lerp(SNOW, smoothstep(300, 380, y));
  // Yardang hardpan runs grey-red; dune crests catch the light.
  const nx = (x - YARDANGS.center[0]) / YARDANGS.radii[0];
  const nz = (z - YARDANGS.center[1]) / YARDANGS.radii[1];
  target.lerp(new THREE.Color(0x9a7a62), (1 - smoothstep(0.6, 1, Math.hypot(nx, nz))) * 0.5);
  const crest = THREE.MathUtils.clamp(y / 45, 0, 1) * 0.1;
  const speckle = (random() - 0.5) * 0.07;
  return target.offsetHSL(0, 0, crest + speckle);
}

/** What the tyres feel on the bare terrain at (x, y, z): salt, marsh mud, sea sand, high rock, else gravel. */
function terrainSurfaceAt(x, y, z) {
  const [saltX, saltZ] = WORLD.salt.center;
  if (Math.hypot(x - saltX, z - saltZ) < WORLD.salt.radius) return SURFACES.salt;
  if (z > WORLD.south.start && y < -1.2) return SURFACES.mud;
  if (smoothstep(WORLD.duneSea.start, WORLD.duneSea.full, -x) > 0.4) return SURFACES.sand;
  if (y > 22 && !(z < WORLD.canyon.start && canyonCorridor(x, z) > 0.5)) return SURFACES.rock;
  return SURFACES.dirt;
}

/** A wedge with its low edge across the origin, rising toward −Z: heights at the near and far edges. */
function wedgePoints(width, length, nearHeight, farHeight) {
  const half = width / 2;
  const points = [
    new THREE.Vector3(-half, 0, 0), new THREE.Vector3(half, 0, 0),
    new THREE.Vector3(-half, 0, -length), new THREE.Vector3(half, 0, -length),
  ];
  if (nearHeight > 0) points.push(new THREE.Vector3(-half, nearHeight, 0), new THREE.Vector3(half, nearHeight, 0));
  if (farHeight > 0) points.push(new THREE.Vector3(-half, farHeight, -length), new THREE.Vector3(half, farHeight, -length));
  return points;
}

/** Turns local feature points by a heading and moves them onto the ground at [x, z]. */
function placePoints(points, at, heading) {
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
  const ground = terrainHeight(at[0], at[1]);
  return points.map(point => point.clone().applyQuaternion(turn).add(new THREE.Vector3(at[0], ground, at[1])));
}

/** A lumpy boulder: a squashed, jittered icosahedron's corners, centred at (x, y, z). */
function rockPoints(random, x, y, z, radiusX, radiusY, radiusZ) {
  const shape = new THREE.IcosahedronGeometry(1, 0);
  return pointsOf(shape).map(point => new THREE.Vector3(
    x + point.x * radiusX * THREE.MathUtils.lerp(0.75, 1.15, random()),
    y + point.y * radiusY * THREE.MathUtils.lerp(0.75, 1.15, random()),
    z + point.z * radiusZ * THREE.MathUtils.lerp(0.75, 1.15, random()),
  ));
}

function pointsOf(geometry) {
  const positions = geometry.attributes.position;
  const points = [];
  for (let index = 0; index < positions.count; index++) points.push(new THREE.Vector3().fromBufferAttribute(positions, index));
  return points;
}

/** A painted sign board: Chinese title over a latin caption, on dark teal with a glowing frame. */
/** A painted board: big Chinese title over an English caption, in the Yard's teal-on-slate. */
export function signTexture(title, caption) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  context.fillStyle = '#20303a';
  context.fillRect(0, 0, 512, 256);
  context.strokeStyle = '#54e8d8';
  context.lineWidth = 10;
  context.strokeRect(14, 14, 484, 228);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#eaf6f2';
  context.font = 'bold 110px "Noto Sans CJK SC", "WenQuanYi Micro Hei", "PingFang SC", sans-serif';
  context.fillText(title, 256, 105);
  context.fillStyle = '#54e8d8';
  context.font = 'bold 42px sans-serif';
  context.fillText(caption, 256, 200);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function jitter(random, amount) {
  return new THREE.Vector3((random() - 0.5) * amount, 0, (random() - 0.5) * amount);
}

function smoothstep(edge0, edge1, value) {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Deterministic random numbers (mulberry32), so the world is laid out the same every time. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
