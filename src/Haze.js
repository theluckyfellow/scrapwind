import * as THREE from 'three';

// Drifting sheets of dust haze: enormous, faint sprites that slide downwind and wrap around the
// player. They are what makes the air visible — the liminal part of the light.
const SHEET_COUNT = 16;
const DRIFT = new THREE.Vector3(-2.2, 0, 0.9); // m/s the haze slides downwind
const WRAP_RADIUS = 700;                        // m; a sheet farther than this re-enters on the far side
const MIN_SIZE = 120;
const SIZE_SPAN = 160;
const MIN_LIFT = 9;
const LIFT_SPAN = 24;
const MAX_OPACITY = 0.055;

/**
 * Haze: a pool of giant soft dust sheets adrift over the proving ground. Game moves them with the
 * wind each frame and hands them a height function so they float a little above the terrain.
 * Pure atmosphere; they never collide, cast or receive.
 */
export class Haze {
  sheets = [];

  constructor(scene) {
    const texture = hazeTexture();
    for (let index = 0; index < SHEET_COUNT; index++) {
      const material = new THREE.SpriteMaterial({
        map: texture,
        color: 0xeacfa8,
        transparent: true,
        opacity: MAX_OPACITY * (0.6 + Math.random() * 0.4),
        depthWrite: false,
      });
      const sheet = new THREE.Sprite(material);
      const size = MIN_SIZE + Math.random() * SIZE_SPAN;
      sheet.scale.set(size, size * 0.4, 1);
      sheet.userData.lift = MIN_LIFT + Math.random() * LIFT_SPAN;
      sheet.position.set((Math.random() - 0.5) * 1400, 20, (Math.random() - 0.5) * 1400);
      scene.add(sheet);
      this.sheets.push(sheet);
    }
  }

  /** Slides every sheet downwind, wraps the strays back across the focus, and floats them over the ground. */
  update(center, dt, heightAt) {
    for (const sheet of this.sheets) {
      sheet.position.addScaledVector(DRIFT, dt);
      const dx = sheet.position.x - center.x;
      const dz = sheet.position.z - center.z;
      if (Math.hypot(dx, dz) > WRAP_RADIUS) {
        sheet.position.x = center.x - dx + (Math.random() - 0.5) * 60;
        sheet.position.z = center.z - dz + (Math.random() - 0.5) * 60;
      }
      sheet.position.y = heightAt(sheet.position.x, sheet.position.z) + sheet.userData.lift;
    }
  }
}

/** A soft round puff with a slightly ragged edge, drawn once and shared by every sheet. */
function hazeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(64, 64, 8, 64, 64, 62);
  gradient.addColorStop(0, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.4)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
