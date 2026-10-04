import * as THREE from 'three';
import { Relay, beamMaterial } from './Relay.js';
import { PowerArc } from './PowerArc.js';
import { ChargeSpark } from './ChargeSpark.js';
import { readStored, writeStored } from './storage.js';
import { mergeStaticMeshes } from './toon.js';

// The old grid: thirteen relays across the valley, linked as a tree from home. The Yard's relay is the
// one the village kept alive (`awake`): its plate is where everyone charges. Every other relay costs
// charge to wake (watt-hours drained from the vehicle parked on its plate), and can only be woken once a
// linked neighbour is lit, because power has to come from somewhere; the Spire needs all the others.
// Sites are named landmarks the TestTrack knows; `perch` relays sit on top of something (a mesa) and
// are meant to be reached by air.
const RELAYS = [
  { id: 'yard', title: '拾风站', name: 'Yard Relay', awake: true, site: track => offset(track.landmark('settlement'), -6, -34), links: ['watcher', 'needle', 'marbles', 'salt', 'road', 'dunes'] },
  { id: 'watcher', title: '望台', name: "Watcher's Crown", cost: 600, perch: true, site: track => track.landmark('watcherMesa'), links: ['yard'] },
  { id: 'needle', title: '针峰', name: 'The Needle', cost: 700, perch: true, site: track => track.landmark('needleMesa'), links: ['yard'] },
  { id: 'marbles', title: '石珠', name: 'Marble Meadow', cost: 500, site: track => offset(track.landmark('marbles'), -60, -90), links: ['yard'] },
  { id: 'salt', title: '盐心', name: 'Salt Heart', cost: 800, site: track => offset(track.landmark('salt'), 0, 22), links: ['yard', 'dishes'] },
  { id: 'dishes', title: '听天', name: 'Sky Listeners', cost: 1300, site: track => offset(track.landmark('dishField'), -320, 0), links: ['salt'] },
  { id: 'road', title: '古道', name: 'Old Road', cost: 700, site: track => ({ x: track.roadX(-700) + 20, z: -700 }), links: ['yard', 'gate'] },
  { id: 'gate', title: '关', name: 'The Gate', cost: 1100, site: track => ({ x: track.roadX(-1370) + 20, z: -1370 }), links: ['road', 'spire'] },
  { id: 'dunes', title: '沙海', name: 'Sand Sea', cost: 1000, site: track => offset(track.landmark('dunePad'), 0, 24), links: ['yard', 'island', 'wreck'] },
  { id: 'island', title: '孤岛', name: 'Lone Island', cost: 900, perch: true, site: track => track.landmark('islandMesa'), links: ['dunes'] },
  { id: 'wreck', title: '残舟', name: 'The Wreck', cost: 1300, site: track => offset(track.landmark('wreck'), 110, -70), links: ['dunes', 'ring'] },
  { id: 'ring', title: '断环', name: 'Broken Ring', cost: 1700, site: track => offset(track.landmark('fallenRing'), 170, 40), links: ['wreck'] },
  { id: 'spire', title: '天柱', name: 'The Spire', cost: 3000, finale: true, site: track => ({ x: track.roadX(-2280) + 24, z: -2280 }), links: ['gate'] },
];

const STORAGE_KEY = 'scrapwind-grid';
const PARK_SPEED = 2.5;            // m/s; a relay only takes charge from a vehicle that has stopped on its plate
const FEED_SECONDS = 9;            // a relay drinks its whole cost in about this long, however big it is
const NEAR_DISTANCE = 70;          // m; inside this the HUD shows the relay's panel
const BLOOM_RADIUS = 240;          // m the land greens around a lit relay...
const BLOOM_SECONDS = 24;          // ...spreading out over this long
const FINALE_BLOOM_RADIUS = 520;
const ARC_COLOR = 0x5ff0e0;
const SPIRE_BEAM_LENGTH = 2800;
const SPIRE_BEAM_RADIUS = 10;
const SPARK_ROOF_HEIGHT = 1.6;     // m above the vehicle's centre where the charging spark leaves it
const CLEAR_GROUND = 0.6;          // m: a ground relay needs bare terrain (nothing built) under its plate and mast

/**
 * Grid: the valley's dead power grid and the player's work bringing it back. Owns the Relays, the
 * PowerArcs between lit ones and the ChargeSpark that shows a relay drinking; decides which relays can be woken; takes charge from a Vehicle parked on a
 * relay's plate; lights relays (yours or a crewmate's, from Net); greens the land around lit relays
 * through the TestTrack; remembers progress; and stages the finale when the Spire wakes (with Sky).
 * Game calls charge() every physics step and update() every frame; GridCompass reads it for the HUD.
 */
export class Grid {
  track;
  sky;
  relays = [];
  byId = new Map();
  arcs = new Map();          // "from>to" → PowerArc
  progress = {};             // relay id → watt-hours delivered so far
  blooms = [];               // [{ relay, age, radius }] in light order: one terrain bloom slot each
  chargingRelay = null;      // the relay taking charge this step, for the spark and the hum
  chargeRate = 0;            // 0..1 of full charging speed this step
  stationRelay = null;       // the lit relay charging the vehicle this step
  stationWatts = 0;          // how fast it is charging the vehicle
  finishedAt = null;
  spireBeam = null;
  awakening = 0;             // 0..1, eases up after the Spire wakes
  spark = new ChargeSpark();
  group = new THREE.Group();
  onLit = null;              // (relay, { quiet, by, count, total }) after a relay wakes
  saveTimer = null;

  constructor(track, sky, scene, world) {
    this.track = track;
    this.sky = sky;
    for (const definition of RELAYS) {
      const { station, towerOffset } = this.placeRelay(definition);
      const relay = new Relay(definition, station, towerOffset, world);
      this.relays.push(relay);
      this.byId.set(definition.id, relay);
      this.group.add(relay.group);
    }
    // Thirteen masts' worth of plinths, bells and plates in a few draw calls; crowns, glows and beams stay live.
    mergeStaticMeshes(this.group, { keep: node => node.userData.dynamic === true });
    this.group.add(this.spark.group);
    scene.add(this.group);
    this.load();
  }

  total() { return this.relays.length; }
  litCount() { return this.relays.filter(relay => relay.isLit()).length; }
  finished() { return this.byId.get('spire').isLit(); }
  relayList() { return this.relays; }

  /** Can this relay be woken now? A lit neighbour feeds it; the Spire wants every other relay lit. */
  canLight(relay) {
    if (relay.isLit()) return false;
    if (relay.definition.finale) return this.relays.every(other => other === relay || other.isLit());
    return relay.definition.links.some(id => this.byId.get(id)?.isLit());
  }

  /** Watt-hours delivered to a relay so far. */
  delivered(relay) {
    return this.progress[relay.id()] ?? 0;
  }

  /**
   * One physics step of a vehicle and the grid: parked on an unlit relay's plate it feeds the relay;
   * parked on a lit one it is fed. Returns what's happening there, or null when it's on no plate.
   */
  charge(vehicle, dt) {
    this.chargingRelay = null;
    this.chargeRate = 0;
    this.stationRelay = null;
    this.stationWatts = 0;
    const position = vehicle.drawnPosition();
    const relay = this.relays.find(candidate => candidate.covers(position));
    if (!relay) return null;
    if (relay.isLit()) {
      const added = vehicle.chargeFromRelay(dt);
      if (added > 0) {
        this.stationRelay = relay;
        this.stationWatts = (added * 3600) / dt;
      }
      return { kind: 'station', relay };
    }
    if (!this.canLight(relay)) return { kind: 'locked', relay };
    if (vehicle.speed() > PARK_SPEED) return { kind: 'moving', relay };
    const wanted = relay.definition.cost - this.delivered(relay);
    const watts = (relay.definition.cost * 3600) / FEED_SECONDS;
    const given = vehicle.dischargeInto(Math.min((watts * dt) / 3600, wanted));
    if (given <= 0) return { kind: 'empty', relay };
    this.progress[relay.id()] = this.delivered(relay) + given;
    this.chargingRelay = relay;
    this.chargeRate = watts > 0 ? (given * 3600) / (watts * dt) : 0;
    if (this.delivered(relay) >= relay.definition.cost - 1e-6) this.light(relay.id());
    else this.saveSoon();
    return { kind: 'charging', relay };
  }

  /** Wakes a relay: arcs to its lit neighbours, the land greens, and the news goes out. */
  light(id, { quiet = false, by = null } = {}) {
    const relay = this.byId.get(id);
    if (!relay || relay.isLit()) return false;
    relay.setState('lit');
    this.progress[id] = relay.definition.cost ?? 0;
    for (const neighbourId of relay.definition.links) {
      const neighbour = this.byId.get(neighbourId);
      if (neighbour?.isLit()) this.connect(neighbour, relay, quiet);
    }
    // Relays that link here can now be woken too.
    this.refreshStates();
    this.blooms.push({ relay, age: quiet ? BLOOM_SECONDS : 0, radius: relay.definition.finale ? FINALE_BLOOM_RADIUS : BLOOM_RADIUS });
    if (!quiet) relay.celebrate();
    if (relay.definition.finale) this.wakeSpire(quiet);
    if (this.finished() && !this.finishedAt) this.finishedAt = new Date().toISOString();
    this.save();
    this.onLit?.(relay, { quiet, by, count: this.litCount(), total: this.total() });
    return true;
  }

  /** Forgets all progress: every relay goes dark and the land goes back to dust. */
  reset() {
    for (const arc of this.arcs.values()) {
      arc.mesh.removeFromParent();
      arc.mesh.geometry.dispose();
      arc.mesh.material.dispose();
    }
    this.arcs.clear();
    this.progress = {};
    this.blooms = [];
    this.finishedAt = null;
    this.awakening = 0;
    if (this.spireBeam) this.spireBeam.visible = false;
    for (const relay of this.relays) relay.setState('dark');
    this.refreshStates();
    this.track.clearBlooms();
    this.track.awakenSpire(0);
    this.sky.setAwakening(0);
    this.lightAwakeRelays();
    this.save();
  }

  /** The relay nearest a point within the HUD's reach, with how it stands. */
  nearby(position) {
    let best = null;
    for (const relay of this.relays) {
      const distance = Math.hypot(position.x - relay.station.x, position.z - relay.station.z);
      if (distance < NEAR_DISTANCE && (!best || distance < best.distance)) best = { relay, distance };
    }
    if (!best) return null;
    return {
      ...best,
      lit: best.relay.isLit(),
      canLight: this.canLight(best.relay),
      delivered: this.delivered(best.relay),
      cost: best.relay.definition.cost,
      charging: best.relay === this.chargingRelay,
      onPlate: best.relay.covers(position),
      stationWatts: best.relay === this.stationRelay ? this.stationWatts : 0,
      litNeeded: best.relay.definition.finale ? this.total() - 1 - this.litCount() : 0,
    };
  }

  /** The nearest lit relay, where a vehicle running low can charge; null if none is lit. */
  nearestCharger(position) {
    let best = null;
    for (const relay of this.relays) {
      if (!relay.isLit()) continue;
      const distance = Math.hypot(position.x - relay.station.x, position.z - relay.station.z);
      if (!best || distance < best.distance) best = { relay, distance };
    }
    return best;
  }

  /** Animates relays, arcs, blooms, the charging spark and the finale; Game calls this every frame. */
  update(elapsedSeconds, frameSeconds, vehicle) {
    for (const relay of this.relays) relay.update(elapsedSeconds, frameSeconds, relay === this.chargingRelay);
    for (const arc of this.arcs.values()) {
      arc.intensity = 1 + this.awakening * 1.5;
      arc.update(elapsedSeconds, frameSeconds);
    }
    this.blooms.forEach((bloom, index) => {
      bloom.age = Math.min(bloom.age + frameSeconds, BLOOM_SECONDS);
      const spread = 1 - (1 - bloom.age / BLOOM_SECONDS) ** 2;
      this.track.setBloom(index, bloom.relay.station.x, bloom.relay.station.z, bloom.radius * spread);
    });
    this.updateSpark(vehicle);
    if (this.finished() && this.awakening < 1) {
      this.awakening = Math.min(this.awakening + frameSeconds / 6, 1);
      this.sky.setAwakening(this.awakening);
      this.track.awakenSpire(this.awakening);
    }
    if (this.spireBeam) this.spireBeam.material.uniforms.uTime.value = elapsedSeconds;
  }

  // ---- Inner workings ----

  /** Waiting relays pulse amber; dark ones have no way to be fed yet. */
  refreshStates() {
    for (const relay of this.relays) {
      if (relay.isLit()) continue;
      relay.setState(this.canLight(relay) ? 'waiting' : 'dark');
    }
  }

  connect(from, to, quiet) {
    const key = `${from.id()}>${to.id()}`;
    if (this.arcs.has(key) || this.arcs.has(`${to.id()}>${from.id()}`)) return;
    const arc = new PowerArc(from.crownTop, to.crownTop, ARC_COLOR);
    if (quiet) arc.complete();
    this.arcs.set(key, arc);
    this.group.add(arc.mesh);
  }

  /** The spark between the vehicle's roof and a crown: up into a relay it feeds, or down from one charging it. */
  updateSpark(vehicle) {
    const relay = this.chargingRelay ?? this.stationRelay;
    if (!relay || !vehicle) {
      this.spark.hide();
      return;
    }
    const roof = vehicle.drawnPosition().add(new THREE.Vector3(0, SPARK_ROOF_HEIGHT, 0));
    if (relay === this.chargingRelay) this.spark.show(roof, relay.crownTop, this.chargeRate);
    else this.spark.show(relay.crownTop, roof, 1);
  }

  /** The finale: the Spire's crown flares and fires a beam at the moon; the sky answers. */
  wakeSpire(quiet) {
    if (!this.spireBeam) {
      const top = this.track.spireTop();
      const geometry = new THREE.CylinderGeometry(SPIRE_BEAM_RADIUS, SPIRE_BEAM_RADIUS * 0.6, SPIRE_BEAM_LENGTH, 20, 1, true);
      geometry.translate(0, SPIRE_BEAM_LENGTH / 2, 0);
      this.spireBeam = new THREE.Mesh(geometry, beamMaterial(0xc8fff4, 2.4));
      this.spireBeam.position.copy(top);
      this.spireBeam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.sky.moonDirection());
      this.spireBeam.frustumCulled = false;
      this.spireBeam.renderOrder = 2;
      this.group.add(this.spireBeam);
    }
    this.spireBeam.visible = true;
    if (quiet) {
      this.awakening = 1;
      this.sky.setAwakening(1);
      this.track.awakenSpire(1);
    }
  }

  /** Where a relay goes: perched on its landmark, or on the nearest bare ground with room for its mast. */
  placeRelay(definition) {
    const site = definition.site(this.track);
    if (definition.perch) {
      const reach = Math.min((site.radius ?? 10) * 0.55, 7);
      const station = new THREE.Vector3(site.x, this.track.heightAt(site.x, site.z), site.z);
      return { station, towerOffset: new THREE.Vector3(reach, 0, 0) };
    }
    const towerOffset = new THREE.Vector3(7, 0, 0);
    for (let ring = 0; ring < 12; ring++) {
      const tries = ring === 0 ? 1 : ring * 6;
      for (let index = 0; index < tries; index++) {
        const angle = (index / tries) * Math.PI * 2;
        const x = site.x + Math.cos(angle) * ring * 8;
        const z = site.z + Math.sin(angle) * ring * 8;
        if (this.isBare(x, z) && this.isBare(x + towerOffset.x, z + towerOffset.z)) {
          const ground = this.track.groundHeight(x, z);
          towerOffset.y = this.track.groundHeight(x + towerOffset.x, z + towerOffset.z) - ground;
          return { station: new THREE.Vector3(x, ground, z), towerOffset };
        }
      }
    }
    return { station: new THREE.Vector3(site.x, this.track.heightAt(site.x, site.z), site.z), towerOffset };
  }

  isBare(x, z) {
    return this.track.heightAt(x, z) - this.track.groundHeight(x, z) < CLEAR_GROUND;
  }

  /** Relays that are awake from the start; called on load and reset, before anything else is lit. */
  lightAwakeRelays() {
    for (const relay of this.relays) {
      if (relay.definition.awake) this.light(relay.id(), { quiet: true });
    }
  }

  load() {
    const saved = readStored(STORAGE_KEY, null); // read before lighting anything: light() saves
    this.lightAwakeRelays();
    if (!saved || typeof saved !== 'object') {
      this.refreshStates();
      return;
    }
    for (const [id, value] of Object.entries(saved.progress ?? {})) {
      if (this.byId.has(id) && Number.isFinite(value)) this.progress[id] = Math.max(value, 0);
    }
    this.finishedAt = typeof saved.finishedAt === 'string' ? saved.finishedAt : null;
    // Light in table order so every arc finds its already-lit neighbour; no fanfare for old news.
    const lit = new Set(Array.isArray(saved.lit) ? saved.lit : []);
    for (const definition of RELAYS) {
      if (lit.has(definition.id)) this.light(definition.id, { quiet: true });
    }
    this.refreshStates();
  }

  save() {
    writeStored(STORAGE_KEY, {
      lit: this.relays.filter(relay => relay.isLit()).map(relay => relay.id()),
      progress: this.progress,
      finishedAt: this.finishedAt,
    });
  }

  /** Charging progress is saved a few times a second at most, not every physics step. */
  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
  }
}

function offset(site, dx, dz) {
  return { ...site, x: site.x + dx, z: site.z + dz };
}
