import * as THREE from 'three';
import { BODIES, TUBE_RADIUS, frameTubes, ringCorners } from './catalog.js';
import { toonMesh, toonMaterial, OUTLINE_COLOR, mergeStaticMeshes } from './toon.js';

const FRAME_COLOR = 0x2d2a28;
const FLOOR_COLOR = 0x4a4d50;
const GLASS_COLOR = 0x2b4a5f;
const TRIM_COLOR = 0x26292b;
const HEADLIGHT_COLOR = 0xfff2c0;
const TAIL_LIGHT_COLOR = 0xff5a4a;
const ROBOT_COLOR = 0xe8e4d8;
const ROBOT_JOINT_COLOR = 0x3a3f44;
const VISOR_COLOR = 0x5fd8ff;
const OUTSET = 0.045;          // panels sit just outside the tubes they cover
const FLOOR_TOP = 0.015;
const JOINT_RADIUS = 0.05;
const GLASS_OPACITY = 0.55;
const GHOST_OPACITY = 0.16;    // panels ghost to this while parts are being placed
const UP = new THREE.Vector3(0, 1, 0);

// One builder per panel slot: given the body and the chosen style, returns the meshes for that slot.
const PANEL_BUILDERS = {
  nose: (body, style, materials) => {
    if (style === 'none') return [];
    const first = body.rings[0];
    const face = faceQuad(first, -OUTSET);
    const meshes = [skin([face], style === 'grille' ? materials.trim : materials.paint)];
    meshes.push(...lamps(first, -1, materials.headlight));
    if (style === 'splitter') {
      const width = 2 * first.bottomHalfWidth + 0.12;
      meshes.push(boxMesh([width, 0.04, 0.4], [0, first.bottom - 0.02, first.z - 0.12], materials.trim));
    }
    return meshes;
  },
  hood: (body, style, materials) => {
    if (style === 'none') return [];
    const meshes = [skin(topQuads(body, body.hood), materials.paint)];
    if (style === 'vented') {
      const [from, to] = body.hood;
      const ring = body.rings[Math.round((from + to) / 2)];
      meshes.push(boxMesh([ring.topHalfWidth * 0.8, 0.06, 0.35], [0, ring.top + OUTSET + 0.03, ring.z], materials.trim));
    }
    return meshes;
  },
  roof: (body, style, materials) => {
    if (style === 'none') return [];
    if (style === 'glass') return [skin(topQuads(body, [body.windshield[0], body.roof[1]]), materials.glass, false)];
    return [skin(topQuads(body, body.windshield), materials.glass, false), skin(topQuads(body, body.roof), materials.paint)];
  },
  sides: (body, style, materials) => {
    if (style === 'none') return [];
    const whole = [0, body.rings.length - 1];
    const meshes = [];
    for (const side of [-1, 1]) {
      if (style === 'skirts') meshes.push(skin(sideQuads(body, whole, side, 0, 0.3), materials.paint));
      if (style === 'panels') meshes.push(skin(sideQuads(body, whole, side, 0, 1), materials.paint));
      if (style === 'doors') {
        const cabin = [body.windshield[0], body.roof[1]];
        meshes.push(skin(sideQuads(body, [0, cabin[0]], side, 0, 1), materials.paint));
        meshes.push(skin(sideQuads(body, cabin, side, 0, 0.5), materials.paint));
        meshes.push(skin(sideQuads(body, cabin, side, 0.5, 1), materials.glass, false));
        meshes.push(skin(sideQuads(body, [cabin[1], whole[1]], side, 0, 1), materials.paint));
      }
    }
    return meshes;
  },
  tail: (body, style, materials) => {
    if (style === 'none') return [];
    const last = body.rings.at(-1);
    const meshes = [skin([faceQuad(last, OUTSET)], materials.paint), skin(topQuads(body, body.deck), materials.paint)];
    meshes.push(...lamps(last, 1, materials.tailLight));
    if (style === 'ducktail') {
      const left = cornerPoint(last, 'top', -1);
      const right = cornerPoint(last, 'top', 1);
      const lift = new THREE.Vector3(0, 0.14, 0.12);
      meshes.push(skin([[left, right, right.clone().add(lift), left.clone().add(lift)]], materials.paint));
    }
    return meshes;
  },
  wing: (body, style, materials) => {
    if (style === 'none') return [];
    const last = body.rings.at(-1);
    const height = style === 'high' ? 0.5 : 0.2;
    const width = 2 * last.topHalfWidth + 0.1;
    const y = last.top + OUTSET + height;
    const z = last.z - 0.22;
    const meshes = [boxMesh([width, 0.05, 0.42], [0, y, z], materials.paint)];
    for (const side of [-1, 1]) {
      meshes.push(boxMesh([0.05, height, 0.12], [side * width * 0.3, y - height / 2, z], materials.trim));
      meshes.push(boxMesh([0.03, 0.22, 0.5], [side * width / 2, y + 0.05, z], materials.trim));
    }
    return meshes;
  },
};

/**
 * Bodywork: what you see of a Blueprint's body. The frame tubes, the floor pan, the body panels in their
 * slots (painted, glass or trim) and the robot driver. Chassis carries it through the world; the Garage
 * raycasts against its tubes and floor pan (mountSurfaces) to find where a part can bolt on.
 */
export class Bodywork {
  group = new THREE.Group();
  panelGroup = new THREE.Group();
  mountSurfaces = [];   // meshes parts can be mounted on; userData says which tube or the floor
  panelMaterials = [];  // this body's own paint/glass/trim materials, ghosted while placing parts

  constructor(blueprint) {
    const body = BODIES[blueprint.bodyKey];
    this.buildFrame(body);
    this.buildFloor(body);
    this.buildPanels(body, blueprint.panels, blueprint.paint);
    this.buildDriver(body);
    this.group.add(this.panelGroup);
    // Dozens of tubes, joints and panels become a few draw calls. The tubes stay behind, hidden, for the
    // garage to pick mount points on; the floor stays whole (it is a pick target with ink lines of its own);
    // the panels merge among themselves so the garage can still hide them.
    mergeStaticMeshes(this.panelGroup);
    mergeStaticMeshes(this.group, {
      keep: node => node === this.panelGroup || node.userData.mountSurface?.kind === 'floor',
      pickable: mesh => this.mountSurfaces.includes(mesh),
    });
  }

  /** Shows the panels, or ghosts them translucent so the frame can be seen and clicked while placing parts. */
  showPanels(visible) {
    for (const material of this.panelMaterials) {
      material.opacity = visible ? material.userData.baseOpacity : GHOST_OPACITY;
      material.transparent = !visible || material.userData.baseTransparent;
      material.depthWrite = visible && material.userData.baseDepthWrite;
    }
    this.panelGroup.traverse(node => {
      if (node.userData.ghostsWithPanels) node.visible = visible;
    });
  }

  buildFrame(body) {
    for (const { start, end } of frameTubes(body)) {
      const from = new THREE.Vector3(...start);
      const to = new THREE.Vector3(...end);
      const length = from.distanceTo(to);
      if (length < 0.01) continue;
      const tube = toonMesh(new THREE.CylinderGeometry(TUBE_RADIUS, TUBE_RADIUS, length, 6), FRAME_COLOR, { outline: 0.012 });
      tube.position.lerpVectors(from, to, 0.5);
      tube.quaternion.setFromUnitVectors(UP, to.clone().sub(from).normalize());
      tube.userData.mountSurface = { kind: 'tube', start, end };
      this.mountSurfaces.push(tube);
      this.group.add(tube);
    }
    const jointGeometry = new THREE.IcosahedronGeometry(JOINT_RADIUS, 0);
    for (const ring of body.rings) {
      for (const corner of Object.values(ringCorners(ring))) {
        const joint = toonMesh(jointGeometry, FRAME_COLOR, { outline: 0 });
        joint.position.set(...corner);
        this.group.add(joint);
      }
    }
  }

  buildFloor(body) {
    const quads = [];
    for (let index = 0; index < body.rings.length - 1; index++) {
      const [here, next] = [body.rings[index], body.rings[index + 1]];
      quads.push([
        new THREE.Vector3(-here.bottomHalfWidth, FLOOR_TOP, here.z),
        new THREE.Vector3(here.bottomHalfWidth, FLOOR_TOP, here.z),
        new THREE.Vector3(next.bottomHalfWidth, FLOOR_TOP, next.z),
        new THREE.Vector3(-next.bottomHalfWidth, FLOOR_TOP, next.z),
      ]);
    }
    const floor = skin(quads, toonMaterial(FLOOR_COLOR, { side: THREE.DoubleSide }));
    floor.receiveShadow = true;
    floor.userData.mountSurface = { kind: 'floor' };
    this.mountSurfaces.push(floor);
    this.group.add(floor);
  }

  buildPanels(body, panels, paint) {
    const materials = {
      paint: toonMaterial(new THREE.Color(paint), { side: THREE.DoubleSide }),
      glass: toonMaterial(GLASS_COLOR, { side: THREE.DoubleSide, transparent: true, opacity: GLASS_OPACITY, depthWrite: false }),
      trim: toonMaterial(TRIM_COLOR, { side: THREE.DoubleSide }),
      headlight: toonMaterial(HEADLIGHT_COLOR, { emissive: HEADLIGHT_COLOR, emissiveIntensity: 0.7 }),
      tailLight: toonMaterial(TAIL_LIGHT_COLOR, { emissive: TAIL_LIGHT_COLOR, emissiveIntensity: 0.6 }),
    };
    for (const material of Object.values(materials)) {
      material.userData.baseOpacity = material.opacity;
      material.userData.baseTransparent = material.transparent;
      material.userData.baseDepthWrite = material.depthWrite;
      this.panelMaterials.push(material);
    }
    for (const [slot, style] of Object.entries(panels)) {
      for (const mesh of PANEL_BUILDERS[slot](body, style, materials)) {
        // Ink lines and outline shells stay solid when the panel ghosts; they hide with it instead.
        for (const child of mesh.children) child.userData.ghostsWithPanels = true;
        this.panelGroup.add(mesh);
      }
    }
  }

  /** A little robot at the wheel: everyone drives electric now, and robots drive too. */
  buildDriver(body) {
    const [x, , z] = body.seat;
    const parts = [
      [[0.5, 0.18, 0.5], [x, 0.09, z], 0x4a3b33],
      [[0.5, 0.6, 0.1], [x, 0.4, z + 0.25], 0x4a3b33],
      [[0.4, 0.46, 0.28], [x, 0.43, z], ROBOT_COLOR],
      [[0.14, 0.12, 0.14], [x, 0.72, z], ROBOT_JOINT_COLOR],
      [[0.3, 0.24, 0.28], [x, 0.9, z], ROBOT_COLOR],
    ];
    for (const [size, position, color] of parts) {
      this.group.add(boxMesh(size, position, toonMaterial(color)));
    }
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.07, 0.02), toonMaterial(VISOR_COLOR, { emissive: VISOR_COLOR, emissiveIntensity: 0.9 }));
    visor.position.set(x, 0.92, z - 0.15);
    this.group.add(visor);
    const antenna = toonMesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 4), ROBOT_JOINT_COLOR, { outline: 0 });
    antenna.position.set(x + 0.09, 1.12, z + 0.05);
    this.group.add(antenna);
  }
}

/** A flat-shaded mesh from quads [a, b, c, d], with ink lines along its edges. */
function skin(quads, material, inked = true) {
  const positions = [];
  for (const [a, b, c, d] of quads) {
    for (const point of [a, b, c, a, c, d]) positions.push(point.x, point.y, point.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = !material.transparent;
  mesh.receiveShadow = true;
  if (inked) mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), new THREE.LineBasicMaterial({ color: OUTLINE_COLOR })));
  return mesh;
}

function boxMesh(size, position, material) {
  const mesh = toonMesh(new THREE.BoxGeometry(...size), null, { material, outline: 0.015 });
  mesh.position.set(...position);
  return mesh;
}

/** A pair of lamps on a ring's face; direction −1 faces forward, +1 back. */
function lamps(ring, direction, material) {
  const height = ring.bottom + (ring.top - ring.bottom) * 0.7;
  return [-1, 1].map(side => {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.05), material);
    lamp.position.set(side * ring.bottomHalfWidth * 0.62, height, ring.z + direction * (OUTSET + 0.02));
    return lamp;
  });
}

/** A ring corner pushed out to where the panels sit. */
function cornerPoint(ring, level, side) {
  const halfWidth = level === 'top' ? ring.topHalfWidth : ring.bottomHalfWidth;
  const y = level === 'top' ? ring.top + OUTSET : ring.bottom;
  return new THREE.Vector3(side * (halfWidth + OUTSET), y, ring.z);
}

/** A point on a ring's side, `fraction` of the way from its bottom rail to its top rail. */
function sidePoint(ring, side, fraction) {
  const halfWidth = THREE.MathUtils.lerp(ring.bottomHalfWidth, ring.topHalfWidth, fraction) + OUTSET;
  return new THREE.Vector3(side * halfWidth, THREE.MathUtils.lerp(ring.bottom, ring.top + OUTSET, fraction), ring.z);
}

/** The whole cross-section of a ring, nudged forward (−) or back (+) along z. */
function faceQuad(ring, zOffset) {
  return [cornerPoint(ring, 'bottom', -1), cornerPoint(ring, 'bottom', 1), cornerPoint(ring, 'top', 1), cornerPoint(ring, 'top', -1)]
    .map(point => point.setZ(point.z + zOffset));
}

function topQuads(body, [from, to]) {
  const quads = [];
  for (let index = from; index < to; index++) {
    const [here, next] = [body.rings[index], body.rings[index + 1]];
    quads.push([cornerPoint(here, 'top', -1), cornerPoint(here, 'top', 1), cornerPoint(next, 'top', 1), cornerPoint(next, 'top', -1)]);
  }
  return quads;
}

function sideQuads(body, [from, to], side, fromFraction, toFraction) {
  const quads = [];
  for (let index = from; index < to; index++) {
    const [here, next] = [body.rings[index], body.rings[index + 1]];
    quads.push([
      sidePoint(here, side, fromFraction), sidePoint(next, side, fromFraction),
      sidePoint(next, side, toFraction), sidePoint(here, side, toFraction),
    ]);
  }
  return quads;
}
