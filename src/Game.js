import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Controls } from './Controls.js';
import { Vehicle, handlingTuning } from './Vehicle.js';
import { chassisTuning } from './Chassis.js';
import { wheelTuning } from './Wheel.js';
import { drivetrainTuning } from './Drivetrain.js';
import { rotorTuning } from './Rotor.js';
import { flightTuning } from './FlightController.js';
import { TestTrack } from './TestTrack.js';
import { Sky } from './Sky.js';
import { ChaseCamera, cameraTuning } from './ChaseCamera.js';
import { Telemetry } from './Telemetry.js';
import { TuningPanel } from './TuningPanel.js';

const GRAVITY = -9.81;
const SPAWN_POSITION = new THREE.Vector3(0, 1.3, 30);
const SPAWN_HEADING = 0;          // radians; 0 faces north (−Z), toward the ramps
const FALL_LIMIT = -60;           // m; below this the buggy is lost and respawns
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 5000;
const MAX_PIXEL_RATIO = 2;

// One-shot buttons and what they do.
const BUTTON_ACTIONS = {
  toggleRotors: game => game.vehicle.toggleRotors(),
  flipUpright: game => game.vehicle.flipUpright(),
  respawn: game => game.respawn(),
  toggleTelemetry: game => game.telemetry.toggleDetails(),
  toggleTuning: game => game.tuningPanel.toggle(),
};

/**
 * Game: owns the renderer, the scene, the physics world and everything in them.
 * main.js calls beginFrame() once per frame, step() once per fixed physics step, then render().
 * It wires Controls into the Vehicle, keeps the ChaseCamera and Sky following it, and feeds Telemetry.
 */
export class Game {
  renderer;
  scene = new THREE.Scene();
  camera;
  world;
  track;
  sky;
  vehicle;
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
    this.vehicle = new Vehicle(this.world, SPAWN_POSITION, SPAWN_HEADING);
    this.scene.add(this.vehicle.visual());

    this.controls = new Controls(window);
    this.chaseCamera = new ChaseCamera(this.camera, this.track);
    this.telemetry = new Telemetry(hudElement, this.scene);
    this.tuningPanel = new TuningPanel([
      { title: 'Chassis', record: chassisTuning, onChange: () => this.vehicle.applyMassTuning() },
      { title: 'Suspension and tyres', record: wheelTuning },
      { title: 'Steering', record: handlingTuning },
      { title: 'Engine and brakes', record: drivetrainTuning },
      { title: 'Rotors', record: rotorTuning },
      { title: 'Flight', record: flightTuning },
      { title: 'Camera', record: cameraTuning },
    ]);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** Reads input and handles one-shot buttons; once per frame, before the physics steps. */
  beginFrame() {
    this.controls.poll();
    for (const [name, action] of Object.entries(BUTTON_ACTIONS)) {
      if (this.controls.pressed(name)) action(this);
    }
  }

  /** One fixed physics step. */
  step(dt) {
    this.vehicle.step(this.controls, this.track, dt);
    this.world.step();
    this.vehicle.afterPhysicsStep();
    if (this.vehicle.altitude() < FALL_LIMIT) this.respawn();
  }

  /** Draws a frame; alpha (0..1) is how far we are between the last two physics steps. */
  render(alpha, frameSeconds) {
    this.elapsedSeconds += frameSeconds;
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
  }
}
