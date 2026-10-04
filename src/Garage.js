import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Vehicle } from './Vehicle.js';
import { WHEELS, BATTERIES, BOOSTERS, ROTORS, BALLASTS, GYROS, TUBE_RADIUS, wheelHubPosition, rotorHubPosition } from './catalog.js';
import { toonMesh, toonMaterial } from './toon.js';

const GRID = 0.05;              // m; mount points snap to this along tubes and across the floor
const FLOOR_TOP = 0.015;        // m, the floor pan's surface in chassis space
const CLICK_SLOP = 5;           // px a press may move and still count as a click, not an orbit
const TURNTABLE_TOP = 0.08;     // m
const TURNTABLE_RADIUS = 4.4;
const VALID_COLOR = 0x6fe36f;
const INVALID_COLOR = 0xff4a3a;
const GHOST_OPACITY = 0.5;
const BACKGROUND_COLOR = 0x2b3138;
const STAGE = new THREE.Vector3(0, TURNTABLE_TOP, 0);

const MODELS = { wheel: WHEELS, battery: BATTERIES, surge: BOOSTERS, rotor: ROTORS, ballast: BALLASTS, gyro: GYROS };

/** A solid box part sits its own half-size off the surface along the mount normal. */
const boxOffset = (mount, model) => {
  const half = model.size.map(size => size / 2);
  return mount.position.map((value, axis) => value + mount.normal[axis] * half[axis]);
};

// How each kind of part sits relative to the mount point picked on the frame.
const PART_OFFSETS = {
  wheel: mount => mount.position,
  rotor: mount => mount.position,
  battery: boxOffset,
  surge: boxOffset,
  ballast: boxOffset,
  gyro: boxOffset,
};

/** A plain box the part's own size, for ghosts of the solid box parts. */
const ghostBox = (model, position, rideHeight, material) => {
  const box = new THREE.Mesh(new THREE.BoxGeometry(...model.size), material);
  box.position.set(...position);
  return [box];
};

// Ghost shapes for each kind of part, drawn where it would go.
const GHOST_SHAPES = {
  wheel: (model, position, rideHeight, material) => {
    const hub = wheelHubPosition(model, position, rideHeight);
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(model.radius, model.radius, model.width, 16).rotateZ(Math.PI / 2), material);
    tyre.position.set(...hub);
    return [tyre, strut(position, hub, material)];
  },
  battery: ghostBox,
  ballast: ghostBox,
  surge: (model, position, rideHeight, material) => {
    const radius = Math.min(model.size[0], model.size[2]) / 2;
    const can = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, model.size[1], 12), material);
    can.position.set(...position);
    return [can];
  },
  gyro: (model, position, rideHeight, material) => {
    const radius = Math.min(model.size[0], model.size[2]) / 2;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), material);
    ball.position.set(...position);
    return [ball];
  },
  rotor: (model, position, rideHeight, material) => {
    const hub = rotorHubPosition(model, position);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(model.bladeRadius, model.bladeRadius, 0.03, 24), material);
    disc.position.set(hub[0], hub[1] + 0.18, hub[2]);
    return [disc, strut(position, hub, material)];
  },
};

/**
 * Garage: the builder's workshop. Shows the Blueprint as a real Vehicle standing still on a turntable, orbits
 * the camera round it with the mouse, draws a ghost of the selected part wherever the pointer finds frame to
 * bolt it to, and turns clicks into Blueprint edits (right-click takes a part off). GarageMenu drives it from
 * the side panels; Game renders it while in the garage.
 */
export class Garage {
  scene = new THREE.Scene();
  camera;
  orbit;
  world;                         // a private physics world for the preview; never stepped
  canvas;
  blueprint;
  vehicle = null;
  tool = null;                   // { part, modelKey } while placing, else null
  mirror = true;
  rotorsOut = false;
  rebuildPending = false;
  candidate = null;              // { position, reason } where the tool would place right now
  ghost = new THREE.Group();
  ghostMaterials = {
    valid: new THREE.MeshBasicMaterial({ color: VALID_COLOR, transparent: true, opacity: GHOST_OPACITY, depthWrite: false }),
    invalid: new THREE.MeshBasicMaterial({ color: INVALID_COLOR, transparent: true, opacity: GHOST_OPACITY, depthWrite: false }),
  };
  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  pressedAt = null;
  active = false;
  onChange;                      // called after every edit, so the menu can refresh
  onHint;                        // called with a short sentence about what the pointer is doing

  constructor(canvas, blueprint, { onChange, onHint }) {
    this.canvas = canvas;
    this.blueprint = blueprint;
    this.onChange = onChange;
    this.onHint = onHint;
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
    this.camera.position.set(6.8, 3.4, 7.6);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.set(0, 0.9, 0);
    this.orbit.enableDamping = true;
    this.orbit.enablePan = false;
    this.orbit.minDistance = 3.5;
    this.orbit.maxDistance = 16;
    this.orbit.maxPolarAngle = 1.48;
    this.orbit.enabled = false;

    this.buildWorkshop();
    this.scene.add(this.ghost);

    canvas.addEventListener('pointermove', event => this.handlePointerMove(event));
    canvas.addEventListener('pointerdown', event => this.handlePointerDown(event));
    canvas.addEventListener('pointerup', event => this.handlePointerUp(event));
    canvas.addEventListener('contextmenu', event => this.handleContextMenu(event));
    window.addEventListener('keydown', event => this.handleKey(event));
    this.rebuild();
  }

  /** Starts listening to the mouse and keyboard; Game calls this on entering the garage. */
  activate() {
    this.active = true;
    this.orbit.enabled = true;
    this.rebuildNow();
  }

  deactivate() {
    this.active = false;
    this.orbit.enabled = false;
    this.clearTool();
  }

  setBlueprint(blueprint) {
    this.blueprint = blueprint;
    this.clearTool();
    this.rebuild();
  }

  /** Picks a part to place; picking the same one again puts it down. */
  selectTool(part, modelKey) {
    const same = this.tool?.part === part && this.tool?.modelKey === modelKey;
    this.tool = same ? null : { part, modelKey };
    this.candidate = null;
    this.clearGhost();
    this.vehicle?.showPanels(!this.tool);
    this.onHint(this.tool ? 'Click the frame to mount it. Right-click a part to take it off. Esc to stop.' : null);
    this.onChange();
  }

  clearTool() {
    if (!this.tool) return;
    this.tool = null;
    this.candidate = null;
    this.clearGhost();
    this.vehicle?.showPanels(true);
    this.onHint(null);
    this.onChange();
  }

  currentTool() { return this.tool; }
  mirroring() { return this.mirror; }
  showingRotorsOut() { return this.rotorsOut; }

  setMirror(mirror) {
    this.mirror = mirror;
    this.onChange();
  }

  setRotorsOut(out) {
    this.rotorsOut = out;
    this.rebuild();
  }

  /**
   * Asks for the preview to be rebuilt from the Blueprint after a change. The stats refresh at once; the
   * rebuild itself waits for the next frame, so dragging a slider costs one rebuild a frame, not one an event.
   */
  rebuild() {
    this.rebuildPending = true;
    this.onChange();
  }

  /** Rebuilds the preview right now. */
  rebuildNow() {
    this.rebuildPending = false;
    if (this.vehicle) this.vehicle.dispose(this.world);
    this.vehicle = new Vehicle(this.world, this.blueprint, STAGE, 0);
    this.vehicle.showAtRest(STAGE, this.rotorsOut);
    this.vehicle.showPanels(!this.tool);
    this.scene.add(this.vehicle.visual());
    this.onChange();
  }

  update() {
    if (this.rebuildPending) this.rebuildNow();
    if (this.active) this.orbit.update();
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  handlePointerMove(event) {
    if (!this.active || !this.tool) return;
    this.aim(event);
    const hit = this.raycaster.intersectObjects(this.vehicle.mountSurfaces(), false)[0];
    if (!hit) {
      this.candidate = null;
      this.clearGhost();
      return;
    }
    const model = MODELS[this.tool.part][this.tool.modelKey];
    const position = PART_OFFSETS[this.tool.part](this.mountPointFrom(hit), model).map(round);
    const reason = this.blueprint.canPlace(this.tool.part, this.tool.modelKey, position, this.mirror);
    this.candidate = { position, reason };
    this.showGhost(model, position, reason);
    this.onHint(reason ?? 'Click to mount.');
  }

  handlePointerDown(event) {
    this.pressedAt = { x: event.clientX, y: event.clientY };
  }

  handlePointerUp(event) {
    if (!this.active || event.button !== 0 || !this.pressedAt) return;
    const moved = Math.hypot(event.clientX - this.pressedAt.x, event.clientY - this.pressedAt.y);
    this.pressedAt = null;
    if (moved > CLICK_SLOP || !this.tool || !this.candidate || this.candidate.reason) return;
    this.blueprint.addMount(this.tool.part, this.tool.modelKey, this.candidate.position, this.mirror);
    this.clearGhost();
    this.rebuild();
  }

  /** Right-click takes the part under the pointer (and its mirror twin) off the design. */
  handleContextMenu(event) {
    if (!this.active) return;
    event.preventDefault();
    this.aim(event);
    const hit = this.raycaster.intersectObjects(this.vehicle.partVisuals(), true)[0];
    const part = hit ? this.vehicle.partOwning(hit.object) : null;
    if (!part) return;
    this.blueprint.removeMount(part.mountId);
    this.rebuild();
  }

  handleKey(event) {
    if (!this.active || event.target instanceof HTMLInputElement) return;
    if (event.code === 'Escape') this.clearTool();
    if (event.code === 'KeyM') this.setMirror(!this.mirror);
  }

  aim(event) {
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  /** Where on the frame the pointer is: snapped along a tube (or across the floor), and which way is out. */
  mountPointFrom(hit) {
    const toLocal = this.vehicle.visual().matrixWorld.clone().invert();
    const point = hit.point.clone().applyMatrix4(toLocal);
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).transformDirection(toLocal);
    const surface = hit.object.userData.mountSurface;

    if (surface.kind === 'floor') {
      return { position: [snap(point.x), FLOOR_TOP, snap(point.z)], normal: [0, 1, 0] };
    }
    const start = new THREE.Vector3(...surface.start);
    const axis = new THREE.Vector3(...surface.end).sub(start);
    const length = axis.length();
    axis.normalize();
    const along = THREE.MathUtils.clamp(snap(point.clone().sub(start).dot(axis)), 0, length);
    const outward = dominantAxis(normal.addScaledVector(axis, -normal.dot(axis)));
    const onTube = start.addScaledVector(axis, along).addScaledVector(outward, TUBE_RADIUS);
    return { position: onTube.toArray(), normal: outward.toArray() };
  }

  showGhost(model, position, reason) {
    this.clearGhost();
    const material = reason ? this.ghostMaterials.invalid : this.ghostMaterials.valid;
    const positions = [position];
    if (this.mirror && Math.abs(position[0]) > 0.05) positions.push([-position[0], position[1], position[2]]);
    for (const spot of positions) {
      for (const mesh of GHOST_SHAPES[this.tool.part](model, spot, this.blueprint.rideHeight, material)) this.ghost.add(mesh);
    }
    this.ghost.position.copy(this.vehicle.visual().position);
  }

  clearGhost() {
    for (const child of [...this.ghost.children]) {
      child.geometry.dispose();
      this.ghost.remove(child);
    }
  }

  buildWorkshop() {
    this.scene.background = new THREE.Color(BACKGROUND_COLOR);
    this.scene.fog = new THREE.Fog(BACKGROUND_COLOR, 18, 60);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 48).rotateX(-Math.PI / 2), toonMaterial(0x6f6a62));
    floor.receiveShadow = true;
    this.scene.add(floor);
    const turntable = toonMesh(new THREE.CylinderGeometry(TURNTABLE_RADIUS, TURNTABLE_RADIUS, TURNTABLE_TOP, 64), 0x3a3f44, { outline: 0.03 });
    turntable.position.y = TURNTABLE_TOP / 2;
    this.scene.add(turntable);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(TURNTABLE_RADIUS - 0.15, 0.03, 4, 64).rotateX(Math.PI / 2), toonMaterial(0xf2d14b));
    ring.position.y = TURNTABLE_TOP + 0.005;
    this.scene.add(ring);

    // A timber back wall and posts: a workshop somebody built by hand.
    const wall = toonMesh(new THREE.BoxGeometry(30, 9, 0.4), 0x6b4a33, { outline: 0.05 });
    wall.position.set(0, 4.5, -12);
    this.scene.add(wall);
    for (const x of [-9, -3, 3, 9]) {
      const post = toonMesh(new THREE.BoxGeometry(0.5, 9, 0.5), 0x4a3324, { outline: 0.04 });
      post.position.set(x, 4.5, -11.6);
      this.scene.add(post);
    }
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(30, 0.5, 0.05), toonMaterial(0xe2582c));
    stripe.position.set(0, 2.2, -11.78);
    this.scene.add(stripe);

    this.scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x5a4636, 1.3));
    const key = new THREE.DirectionalLight(0xfff0d8, 2.4);
    key.position.set(6, 11, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
    key.shadow.bias = -0.0005;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7fd6ff, 1.1);
    rim.position.set(-7, 5, -8);
    this.scene.add(rim);
  }
}

/** A thin rod between a mount point and a hub, for ghosts. */
function strut(from, to, material) {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const length = Math.max(start.distanceTo(end), 0.01);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, length, 6), material);
  rod.position.lerpVectors(start, end, 0.5);
  rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(start).normalize());
  return rod;
}

/** The world axis (±X, ±Y or ±Z) a direction is closest to. */
function dominantAxis(direction) {
  const components = direction.toArray().map(Math.abs);
  const axis = components.indexOf(Math.max(...components));
  const result = new THREE.Vector3();
  result.setComponent(axis, Math.sign(direction.getComponent(axis)) || 1);
  return result;
}

function snap(value) {
  return Math.round(value / GRID) * GRID;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
