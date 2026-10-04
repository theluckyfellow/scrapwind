import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Controls } from './Controls.js';
import { Vehicle, handlingTuning } from './Vehicle.js';
import { Blueprint } from './Blueprint.js';
import { PRESETS, DEFAULT_PRESET } from './presets.js';
import { chassisTuning } from './Chassis.js';
import { wheelTuning } from './Wheel.js';
import { drivetrainTuning } from './Drivetrain.js';
import { batteryTuning } from './BatteryPack.js';
import { rotorTuning } from './Rotor.js';
import { flightTuning } from './FlightController.js';
import { TestTrack } from './TestTrack.js';
import { Sky } from './Sky.js';
import { PostFX } from './PostFX.js';
import { Dust } from './Dust.js';
import { Haze } from './Haze.js';
import { Sound } from './Sound.js';
import { Net } from './Net.js';
import * as api from './api.js';
import { Garage } from './Garage.js';
import { GarageMenu } from './GarageMenu.js';
import { ChaseCamera, cameraTuning } from './ChaseCamera.js';
import { Telemetry } from './Telemetry.js';
import { TuningPanel } from './TuningPanel.js';

const GRAVITY = -9.81;
const SPAWN_GROUND = new THREE.Vector3(0, 0.03, 30); // on the start pad
const SPAWN_HEADING = 0;          // radians; 0 faces north (−Z), toward the ramps
const FALL_LIMIT = -60;           // m; below this the vehicle is lost and respawns
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 6500;
const MAX_PIXEL_RATIO = 1.75; // a 4K screen at full ratio quadruples the post-processing cost for little gain
const LAST_DESIGN_KEY = 'scrapwind-last-design';
const ZERO = new THREE.Vector3();
const SPAWN_SLOT_SPACING = 4;     // m between drivers' spawn slots along the start pad
const REMOTE_SMOOTHING = 12;      // 1/s; how fast puppets chase their driver's latest pose
const NAME_TAG_LIFT = 2.6;        // m above a puppet's roof

// One-shot buttons while driving, and what they do.
const DRIVING_ACTIONS = {
  toggleRotors: game => game.vehicle.toggleRotors(),
  flipUpright: game => game.vehicle.flipUpright(),
  respawn: game => game.respawn(),
  toggleGarage: game => game.enterGarage(),
  toggleTelemetry: game => game.telemetry.toggleDetails(),
  toggleTuning: game => game.tuningPanel.toggle(),
};

/**
 * Game: owns the renderer, the proving ground's scene and physics world, the Garage, and whichever Vehicle is
 * out on the track. It starts in the garage; Test drive builds a Vehicle from the design and drops it on the
 * start pad, and Start or Esc goes back. main.js calls beginFrame() once per frame, step() once per fixed
 * physics step, then render(). It wires Controls into the Vehicle and keeps ChaseCamera, Sky and Telemetry
 * following it.
 */
export class Game {
  renderer;
  scene = new THREE.Scene();
  camera;
  world;
  track;
  sky;
  postfx;
  dust;
  garage;
  garageMenu;
  vehicle = null;
  mode = 'garage';
  controls;
  chaseCamera;
  telemetry;
  tuningPanel;
  net;
  remotes = new Map();           // playerId → { vehicle, tag, target { pos, quaternion, speed, flying } }
  elapsedSeconds = 0;

  constructor(canvas, hudElement, physicsStepSeconds) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(cameraTuning.baseFov, 1, CAMERA_NEAR, CAMERA_FAR);

    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = physicsStepSeconds;
    this.sky = new Sky(this.scene);
    this.track = new TestTrack(this.world, this.scene);
    this.postfx = new PostFX(this.renderer, this.scene, this.camera);
    this.dust = new Dust(this.scene);
    this.haze = new Haze(this.scene);
    this.sound = new Sound();

    this.controls = new Controls(window);
    this.chaseCamera = new ChaseCamera(this.camera, this.track);
    this.telemetry = new Telemetry(hudElement, this.scene);
    this.garage = new Garage(canvas, loadLastDesign(), {
      onChange: () => this.garageMenu?.refresh(),
      onHint: text => this.garageMenu?.setHint(text),
    });
    this.net = new Net(localStorage.getItem('scrapwind-user') ?? 'Drifter', {
      onRoster: (code, players) => this.syncRemotes(code, players),
      onLeft: id => this.removeRemote(id),
      onState: (id, state) => {
        const remote = this.remotes.get(id);
        if (remote) {
          remote.target.pos.set(...state.pos);
          remote.target.quaternion.set(...state.quaternion);
          remote.target.speed = state.speed;
          remote.target.flying = state.flying;
          remote.target.boosting = state.boosting;
        }
      },
      onDesign: id => this.refreshRemoteDesign(id),
      onStatus: () => this.garageMenu?.refreshMultiplayer(),
      onNotice: text => this.garageMenu?.setHint(text),
    });
    this.net.connect();
    this.garageMenu = new GarageMenu(document.body, this.garage, blueprint => this.startDrive(blueprint), this.net);
    this.tuningPanel = new TuningPanel([
      { title: 'Chassis', record: chassisTuning, onChange: () => this.vehicle?.applyMassTuning() },
      { title: 'Suspension and tyres', record: wheelTuning, onChange: () => this.vehicle?.refitSuspension() },
      { title: 'Steering', record: handlingTuning },
      { title: 'Drive and boost', record: drivetrainTuning },
      { title: 'Batteries', record: batteryTuning },
      { title: 'Rotors', record: rotorTuning },
      { title: 'Flight', record: flightTuning },
      { title: 'Camera', record: cameraTuning },
    ]);

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.enterGarage();
  }

  /** Reads input and handles one-shot buttons; once per frame, before the physics steps. */
  beginFrame() {
    this.controls.poll();
    if (this.mode !== 'drive') return;
    for (const [name, action] of Object.entries(DRIVING_ACTIONS)) {
      if (this.controls.pressed(name)) action(this);
    }
  }

  /** One fixed physics step on the proving ground (the garage doesn't simulate). */
  step(dt) {
    if (this.mode !== 'drive') return;
    this.track.stepPods(dt); // kinematic pods claim their next pose before the world steps
    this.vehicle.step(this.controls, this.track, dt);
    this.world.step();
    this.vehicle.afterPhysicsStep();
    const onPad = Boolean(this.track.boostPadAt(this.vehicle.drawnPosition()));
    if (onPad && !this.wasOnPad) this.sound.pad();
    this.wasOnPad = onPad;
    if (onPad) {
      this.vehicle.chargeFromPad(dt);
      this.telemetry.flashPad();
    }
    if (this.vehicle.altitude() < FALL_LIMIT) this.respawn();
  }

  /** Draws a frame; alpha (0..1) is how far we are between the last two physics steps. */
  render(alpha, frameSeconds) {
    this.elapsedSeconds += frameSeconds;
    if (this.mode === 'garage') {
      this.garage.update();
      this.postfx.target(this.garage.scene, this.garage.camera);
      this.postfx.clearSun();
      this.postfx.render();
      return;
    }
    this.vehicle.updateVisual(alpha, frameSeconds);
    this.track.updateVisuals(this.elapsedSeconds);
    this.emitDust(frameSeconds);

    const position = this.vehicle.drawnPosition();
    this.chaseCamera.update(
      position,
      this.vehicle.drawnQuaternion(),
      this.vehicle.speed(),
      this.controls.value('lookRight'),
      this.controls.value('lookUp'),
      frameSeconds,
      this.vehicle.boosting() ? 1 : 0,
    );
    this.sky.follow(this.camera.position, position);
    this.sky.updateTime(this.elapsedSeconds);
    this.haze.update(position, frameSeconds, (x, z) => this.track.heightAt(x, z));
    this.sound.update(this.vehicle, frameSeconds);
    this.telemetry.update(this.vehicle, this.controls, frameSeconds);
    this.postfx.target(this.scene, this.camera);
    this.postfx.updateSun(this.camera);
    this.postfx.render();
    this.net.sendState(this.vehicle, frameSeconds);
    this.updateRemotes(frameSeconds);
  }

  // ---- Multiplayer puppets ----

  /** Rebuilds the puppet fleet to match the room's roster; designs come with the roster. */
  syncRemotes(code, players) {
    if (code === null) {
      for (const id of [...this.remotes.keys()]) this.removeRemote(id);
      this.garageMenu?.refreshMultiplayer();
      return;
    }
    const wanted = new Set();
    for (const entry of players) {
      if (entry.id === this.net.myId || !entry.design) continue;
      wanted.add(entry.id);
      if (!this.remotes.has(entry.id)) this.spawnRemote(entry);
    }
    for (const id of [...this.remotes.keys()]) {
      if (!wanted.has(id)) this.removeRemote(id);
    }
    this.garageMenu?.refreshMultiplayer();
  }

  /** A puppet: the real Vehicle visuals over a kinematic body, driven by its owner's pose stream. */
  spawnRemote(entry) {
    const slot = entry.slot ?? 0;
    const spawn = SPAWN_GROUND.clone().add(new THREE.Vector3(slot * SPAWN_SLOT_SPACING, 0, 0));
    const vehicle = new Vehicle(this.world, Blueprint.fromJSON(entry.design), spawn, SPAWN_HEADING);
    vehicle.showAtRest(spawn);
    vehicle.chassis.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.scene.add(vehicle.visual());
    this.remotes.set(entry.id, {
      vehicle,
      tag: this.makeNameTag(entry.name),
      target: {
        pos: spawn.clone(),
        quaternion: new THREE.Quaternion(),
        speed: 0,
        flying: false,
        boosting: false,
      },
      rotorsShown: false,
    });
  }

  removeRemote(id) {
    const remote = this.remotes.get(id);
    if (!remote) return;
    remote.vehicle.dispose(this.world);
    remote.vehicle.visual().removeFromParent();
    remote.tag.removeFromParent();
    this.remotes.delete(id);
    this.garageMenu?.refreshMultiplayer();
  }

  /** Redraws a puppet when its owner re-sent their design (they rebuilt in the garage). */
  refreshRemoteDesign(id) {
    const entry = this.net.players.get(id);
    if (entry?.design && this.remotes.has(id)) {
      this.removeRemote(id);
      this.spawnRemote(entry);
    }
  }

  /** Chases each puppet's latest received pose with exponential smoothing, then draws it. */
  updateRemotes(frameSeconds) {
    const alpha = 1 - Math.exp(-REMOTE_SMOOTHING * frameSeconds);
    for (const remote of this.remotes.values()) {
      const { vehicle, target } = remote;
      const position = vehicle.drawnPosition();
      position.lerp(target.pos, alpha);
      const quaternion = vehicle.drawnQuaternion().slerp(target.quaternion, alpha);
      vehicle.chassis.placeAt(position, quaternion);
      vehicle.updateVisual(1, frameSeconds);
      for (const wheel of vehicle.wheels()) {
        wheel.spinSpeed = target.speed / wheel.model.radius;
      }
      if (target.flying !== remote.rotorsShown) {
        remote.rotorsShown = target.flying;
        for (const rotor of vehicle.rotors()) rotor.setDeployed(target.flying);
      }
      remote.tag.position.copy(position).add(new THREE.Vector3(0, NAME_TAG_LIFT, 0));
    }
  }

  /** A floating name plate over another driver's build. */
  makeNameTag(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgba(22, 38, 44, 0.85)';
    context.fillRect(0, 0, 256, 64);
    context.fillStyle = '#7fe8d8';
    context.font = 'bold 34px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(name.slice(0, 20), 128, 34);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.scale.set(2.4, 0.6, 1);
    sprite.renderOrder = 5;
    this.scene.add(sprite);
    return sprite;
  }

  /** Feeds the dust: tyre billows, the rotor downwash ring when flying low, capacitor sparks on boost. */
  emitDust(frameSeconds) {
    for (const source of this.vehicle.dustSources()) this.dust.emit(source, frameSeconds);
    if (this.vehicle.flying()) {
      const position = this.vehicle.drawnPosition();
      const altitude = position.y - this.track.heightAt(position.x, position.z);
      if (altitude < 5) {
        this.dust.emit({
          point: new THREE.Vector3(position.x, this.track.heightAt(position.x, position.z), position.z),
          color: 0xd8b98a,
          intensity: THREE.MathUtils.clamp(1 - altitude / 5, 0, 1) * 0.8,
          spark: false,
          velocity: ZERO,
        }, frameSeconds);
      }
    }
    this.dust.update(frameSeconds);
  }

  /** Builds the design as a real vehicle on the start pad (offset by room slot) and hands over the controls. */
  startDrive(blueprint) {
    if (this.vehicle) this.vehicle.dispose(this.world);
    const slot = this.net.room !== null ? this.net.mySlot : 0;
    const spawn = SPAWN_GROUND.clone().add(new THREE.Vector3(slot * SPAWN_SLOT_SPACING, 0, 0));
    this.vehicle = new Vehicle(this.world, blueprint.clone(), spawn, SPAWN_HEADING);
    this.scene.add(this.vehicle.visual());
    storeLastDesign(blueprint);
    this.mode = 'drive';
    this.garage.deactivate();
    this.garageMenu.hide();
    this.telemetry.setVisible(true);
    this.chaseCamera.reset();
    this.net.sendDesign(blueprint.toJSON()); // so everyone else's puppet of you is current
  }

  /** Back to the workshop; the vehicle on the track is taken away. */
  enterGarage() {
    if (this.vehicle) {
      this.vehicle.dispose(this.world);
      this.vehicle = null;
    }
    this.mode = 'garage';
    this.telemetry.setVisible(false);
    this.garage.activate();
    this.garageMenu.show();
  }

  respawn() {
    this.vehicle.reset();
    this.chaseCamera.reset();
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height);
    this.postfx.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.garage.resize(width, height);
  }
}

function loadLastDesign() {
  try {
    const saved = localStorage.getItem(LAST_DESIGN_KEY);
    if (saved) return Blueprint.fromJSON(saved);
  } catch {
    // A missing or unreadable save just means starting from the starter design.
  }
  return Blueprint.fromJSON(PRESETS[DEFAULT_PRESET]);
}

function storeLastDesign(blueprint) {
  try {
    localStorage.setItem(LAST_DESIGN_KEY, JSON.stringify(blueprint.toJSON()));
  } catch {
    // Not being able to remember the design is fine.
  }
}
