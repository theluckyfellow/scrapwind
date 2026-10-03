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
const CAMERA_FAR = 5000;
const MAX_PIXEL_RATIO = 2;
const LAST_DESIGN_KEY = 'scrapwind-last-design';

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
  garage;
  garageMenu;
  vehicle = null;
  mode = 'garage';
  controls;
  chaseCamera;
  telemetry;
  tuningPanel;
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

    this.controls = new Controls(window);
    this.chaseCamera = new ChaseCamera(this.camera, this.track);
    this.telemetry = new Telemetry(hudElement, this.scene);
    this.garage = new Garage(canvas, loadLastDesign(), {
      onChange: () => this.garageMenu?.refresh(),
      onHint: text => this.garageMenu?.setHint(text),
    });
    this.garageMenu = new GarageMenu(document.body, this.garage, blueprint => this.startDrive(blueprint));
    this.tuningPanel = new TuningPanel([
      { title: 'Chassis', record: chassisTuning, onChange: () => this.vehicle?.applyMassTuning() },
      { title: 'Suspension and tyres', record: wheelTuning, onChange: () => this.vehicle?.refitSuspension() },
      { title: 'Steering', record: handlingTuning },
      { title: 'Brakes', record: drivetrainTuning },
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
    this.vehicle.step(this.controls, this.track, dt);
    this.world.step();
    this.vehicle.afterPhysicsStep();
    if (this.vehicle.altitude() < FALL_LIMIT) this.respawn();
  }

  /** Draws a frame; alpha (0..1) is how far we are between the last two physics steps. */
  render(alpha, frameSeconds) {
    this.elapsedSeconds += frameSeconds;
    if (this.mode === 'garage') {
      this.garage.update();
      this.garage.render(this.renderer);
      return;
    }
    this.vehicle.updateVisual(alpha, frameSeconds);
    this.track.updateVisuals(this.elapsedSeconds);

    const position = this.vehicle.drawnPosition();
    this.chaseCamera.update(
      position,
      this.vehicle.drawnQuaternion(),
      this.vehicle.speed(),
      this.controls.value('lookRight'),
      this.controls.value('lookUp'),
      frameSeconds,
    );
    this.sky.follow(this.camera.position, position);
    this.telemetry.update(this.vehicle, this.controls, frameSeconds);
    this.renderer.render(this.scene, this.camera);
  }

  /** Builds the design as a real vehicle on the start pad and hands over the controls. */
  startDrive(blueprint) {
    if (this.vehicle) this.vehicle.dispose(this.world);
    this.vehicle = new Vehicle(this.world, blueprint.clone(), SPAWN_GROUND, SPAWN_HEADING);
    this.scene.add(this.vehicle.visual());
    storeLastDesign(blueprint);
    this.mode = 'drive';
    this.garage.deactivate();
    this.garageMenu.hide();
    this.telemetry.setVisible(true);
    this.chaseCamera.reset();
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
