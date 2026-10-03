import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { toonMesh, toonMaterial, faceted } from './toon.js';

/** Ground types: grip multiplies the tyre's grip; rolling resistance is a fraction of the tyre's load. */
export const SURFACES = {
  dirt: { name: 'Dirt', grip: 1.0, rollingResistance: 0.02, color: 0xc9915c },
  sand: { name: 'Sand', grip: 0.72, rollingResistance: 0.07, color: 0xf0cf8f },
  mud: { name: 'Mud', grip: 0.45, rollingResistance: 0.1, color: 0x6e4c35 },
  rock: { name: 'Rock', grip: 1.1, rollingResistance: 0.012, color: 0x9c7462 },
  concrete: { name: 'Concrete', grip: 1.05, rollingResistance: 0.012, color: 0xcfc3ae },
  metal: { name: 'Scrap metal', grip: 0.85, rollingResistance: 0.012, color: 0x7d8a8c },
};

// World shape. The middle is a flat proving ground; dunes roll outward into a high rim at the edge.
const TERRAIN_SIZE = 1400;       // m square
const TERRAIN_CELLS = 140;       // 10 m facets
const BASIN_RADIUS = 200;        // flat ground in the middle
const DUNE_FULL_RADIUS = 340;    // dunes reach full height here
const SAND_RADIUS = 230;         // past this the terrain counts as sand
const RIM_START = 540;           // the ground climbs into a rim from here to the edge
const RIM_HEIGHT = 70;
const SEED = 20261003;

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
const SURFACE_LANES = { startZ: 62, length: 95, width: 16, lanes: [['concrete', -27], ['sand', -9], ['mud', 9], ['rock', 27]] };
const START_PAD = { at: [0, 30], size: 24 };
const GROUND_PADS = [{ at: [55, 25], radius: 5 }, { at: [-55, 25], radius: 5 }];
const MESAS = [
  { at: [-210, -170], radius: 24, height: 28, sides: 9, pad: true },
  { at: [70, -290], radius: 13, height: 48, sides: 7, pad: true },
  { at: [-60, 270], radius: 7, height: 70, sides: 6, pad: true },
  { at: [270, -70], radius: 30, height: 18, sides: 10, pad: false },
  { at: [-340, 60], radius: 40, height: 34, sides: 11, pad: false },
];
const RING = { center: [0, 34, -240], radius: 14, tube: 1.4, segments: 24 };
const ARCH = { at: [-150, 125], span: 26, height: 15 };
const MAST = { at: [185, -160], height: 42 };
const BURIED_TYRE = { at: [205, 215], radius: 9, tube: 3.2, segments: 18 };
const ROCK_COUNT = 90;
const SHRUB_COUNT = 320;
const MOUNTAIN_COUNT = 28;
const CLOUD_COUNT = 16;
const CRATE_SIZE = 1.2;
const CRATE_MASS = 40;
const BARREL_MASS = 30;
const BEACON_PERIOD_SECONDS = 1.6;

const COLORS = {
  ramp: 0x3f8f8a,
  landing: 0x4f8a9a,
  tableTop: 0x4a7f8f,
  bowl: 0xcdbb9e,
  bump: 0x8a6f5e,
  mesa: 0xb8643c,
  rock: 0xa0705a,
  pad: 0x2f3a3c,
  padMark: 0xf2d14b,
  ring: 0x7fe0d0,
  mast: 0x9a4a32,
  tyre: 0x2a2522,
  crate: 0xb07a45,
  barrel: 0xd0503a,
  shrub: 0x7d8a3c,
  mountain: 0xa07080,
  cloud: 0xfff6ea,
  beacon: 0xff4a3a,
};

/**
 * TestTrack: the proving ground. Builds the terrain, ramps, jumps, the banked bowl, the bumps, surface lanes,
 * mesas with landing pads and a few curiosities on the horizon, each as a mesh with a matching Rapier collider.
 * Wheels ask it what is under them (probeGround), ChaseCamera asks how high the ground is (heightAt),
 * and Game asks it to keep its loose props and blinking lights drawn (updateVisuals).
 */
export class TestTrack {
  world;
  scene;
  random = seededRandom(SEED);
  terrainCollider;
  surfaces = new Map();  // collider handle → SURFACES entry
  props = [];            // [{ body, mesh }] loose things that get knocked about
  beacon;

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
    this.scatterRocks();
    this.scatterShrubs();
    this.buildHorizon();
    this.buildProps();
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

  /** Height of the highest fixed ground at (x, z), ignoring vehicles and loose props. */
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
  }

  surfaceAt(collider, point) {
    if (collider.handle === this.terrainCollider.handle) {
      return Math.hypot(point.x, point.z) > SAND_RADIUS ? SURFACES.sand : SURFACES.dirt;
    }
    return this.surfaces.get(collider.handle) ?? SURFACES.dirt;
  }

  // ---- Building blocks ----

  /** Adds a mesh to the scene and a fixed collider to the world, tagging the collider's surface. */
  addFixed(mesh, colliderDescription, surface) {
    if (mesh) this.scene.add(mesh);
    const collider = this.world.createCollider(colliderDescription);
    if (surface) this.surfaces.set(collider.handle, SURFACES[surface]);
    return collider;
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
    const geometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_CELLS, TERRAIN_CELLS);
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
    const mesh = new THREE.Mesh(faceted, toonMaterial(0xffffff, { vertexColors: true }));
    mesh.receiveShadow = true;
    this.scene.add(mesh);
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
    const geometry = new THREE.CylinderGeometry(bumpRadius, bumpRadius, width, 10);
    geometry.rotateZ(Math.PI / 2);
    const lyingDown = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    for (let index = 0; index < bumpCount; index++) {
      const z = at[1] - index * spacing;
      const y = bumpHeight - bumpRadius;
      const mesh = toonMesh(geometry, COLORS.bump, { outline: 0.03 });
      mesh.position.set(at[0], y, z);
      const description = RAPIER.ColliderDesc.cylinder(width / 2, bumpRadius).setTranslation(at[0], y, z).setRotation(lyingDown);
      this.addFixed(mesh, description, 'rock');
    }
  }

  buildSurfaceLanes() {
    const { startZ, length, width, lanes } = SURFACE_LANES;
    for (const [surface, x] of lanes) {
      const position = new THREE.Vector3(x, 0, startZ + length / 2);
      this.addBox(new THREE.Vector3(width, 0.06, length), position, new THREE.Quaternion(), SURFACES[surface].color, surface, 0);
    }
  }

  buildMesas() {
    for (const mesa of MESAS) {
      const [x, z] = mesa.at;
      const base = terrainHeight(x, z) - 4;
      const geometry = new THREE.CylinderGeometry(mesa.radius * 0.82, mesa.radius, mesa.height, mesa.sides);
      geometry.translate(x, base + mesa.height / 2, z);
      const points = pointsOf(geometry).map(point => point.add(jitter(this.random, mesa.radius * 0.05)));
      this.addConvex(points, COLORS.mesa, 'rock', 0.25);
      if (mesa.pad) this.addLandingPad(x, base + mesa.height, z, Math.min(mesa.radius * 0.5, 6));
    }
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
    for (let index = 0; index < ROCK_COUNT; index++) {
      const angle = this.random() * Math.PI * 2;
      const distance = THREE.MathUtils.lerp(BASIN_RADIUS + 15, RIM_START + 60, this.random());
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      const size = THREE.MathUtils.lerp(1.2, 6.5, this.random() ** 2);
      const points = rockPoints(this.random, x, terrainHeight(x, z) + size * 0.25, z, size, size * 0.7, size);
      this.addConvex(points, COLORS.rock, 'rock', 0.05 + size * 0.015);
    }
  }

  /** Dry scrub: decoration only, drive straight through it. */
  scatterShrubs() {
    const geometry = faceted(new THREE.ConeGeometry(0.7, 1.3, 5).translate(0, 0.5, 0));
    const shrubs = new THREE.InstancedMesh(geometry, toonMaterial(COLORS.shrub), SHRUB_COUNT);
    shrubs.castShadow = true;
    const matrix = new THREE.Matrix4();
    const bowlCenter = new THREE.Vector2(...BOWL.center);
    let placed = 0;
    while (placed < SHRUB_COUNT) {
      const angle = this.random() * Math.PI * 2;
      const distance = THREE.MathUtils.lerp(150, RIM_START + 80, Math.sqrt(this.random()));
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      if (bowlCenter.distanceTo(new THREE.Vector2(x, z)) < BOWL.innerRadius + BOWL.width + BOWL.backSlope + 4) continue;
      const scale = THREE.MathUtils.lerp(0.6, 1.6, this.random());
      matrix.compose(
        new THREE.Vector3(x, terrainHeight(x, z), z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.random() * Math.PI),
        new THREE.Vector3(scale, scale * THREE.MathUtils.lerp(0.7, 1.2, this.random()), scale),
      );
      shrubs.setMatrixAt(placed++, matrix);
    }
    this.scene.add(shrubs);
  }

  /** Distant mountains and clouds: scenery only, there to make the horizon worth looking at. */
  buildHorizon() {
    const mountainMaterial = toonMaterial(COLORS.mountain);
    for (let index = 0; index < MOUNTAIN_COUNT; index++) {
      const angle = (index / MOUNTAIN_COUNT) * Math.PI * 2 + this.random() * 0.15;
      const distance = THREE.MathUtils.lerp(950, 1300, this.random());
      const radius = THREE.MathUtils.lerp(120, 240, this.random());
      const height = THREE.MathUtils.lerp(90, 230, this.random());
      const mountain = new THREE.Mesh(faceted(new THREE.ConeGeometry(radius, height, 6)), mountainMaterial);
      mountain.position.set(Math.cos(angle) * distance, height / 2 - 10, Math.sin(angle) * distance);
      mountain.rotation.y = this.random() * Math.PI;
      this.scene.add(mountain);
    }

    const cloudMaterial = toonMaterial(COLORS.cloud, { fog: false });
    for (let index = 0; index < CLOUD_COUNT; index++) {
      const cloud = new THREE.Group();
      const puffs = 3 + Math.floor(this.random() * 4);
      for (let puff = 0; puff < puffs; puff++) {
        const size = THREE.MathUtils.lerp(14, 30, this.random());
        const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0), cloudMaterial);
        mesh.position.set(puff * size * 0.9, this.random() * 6, this.random() * 12);
        mesh.scale.y = 0.55;
        cloud.add(mesh);
      }
      const angle = this.random() * Math.PI * 2;
      const distance = THREE.MathUtils.lerp(250, 1000, this.random());
      cloud.position.set(Math.cos(angle) * distance, THREE.MathUtils.lerp(170, 280, this.random()), Math.sin(angle) * distance);
      cloud.rotation.y = this.random() * Math.PI;
      this.scene.add(cloud);
    }
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
}

/** Ground height of the bare terrain at (x, z), before any features sit on it. */
export function terrainHeight(x, z) {
  const distance = Math.hypot(x, z);
  const duneAmount = smoothstep(BASIN_RADIUS, DUNE_FULL_RADIUS, distance);
  const dunes = 7 * Math.sin(x * 0.021 + 1.3) * Math.cos(z * 0.017)
    + 4 * Math.sin((x + z) * 0.043)
    + 2.5 * Math.sin(x * 0.09 - z * 0.05);
  const rim = smoothstep(RIM_START, TERRAIN_SIZE / 2, Math.max(Math.abs(x), Math.abs(z))) * RIM_HEIGHT;
  return duneAmount * (dunes + 6) + rim;
}

function terrainColor(x, y, z, random, target) {
  const distance = Math.hypot(x, z);
  const sandiness = smoothstep(BASIN_RADIUS - 20, SAND_RADIUS + 40, distance);
  const rimness = smoothstep(RIM_START - 40, TERRAIN_SIZE / 2, Math.max(Math.abs(x), Math.abs(z)));
  target.set(SURFACES.dirt.color).lerp(new THREE.Color(SURFACES.sand.color), sandiness).lerp(new THREE.Color(0xd4845a), rimness);
  const crest = THREE.MathUtils.clamp((y - 4) / 14, 0, 1) * 0.08;
  const speckle = (random() - 0.5) * 0.07;
  return target.offsetHSL(0, 0, crest + speckle);
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
