import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Toon look helpers: hard-stepped lighting and ink outlines, shared by everything in the world.

// Brightness of each light step, darkest to brightest. Few, hard steps give the Killer7 graphic look.
const LIGHT_STEPS = [0.45, 0.75, 1.0];
const OUTLINE_COLOR = 0x241a14;
export const OUTLINE_THICKNESS = 0.035;

const gradientMap = makeGradientMap(LIGHT_STEPS);
const outlineMaterials = new Map(); // one shared material per thickness

/** A flat-coloured material that lights in hard steps instead of smooth gradients. */
export function toonMaterial(color, options = {}) {
  return new THREE.MeshToonMaterial({ color, gradientMap, ...options });
}

/** A toon-shaded mesh with an ink outline that casts and receives shadows. */
export function toonMesh(geometry, color, { outline = OUTLINE_THICKNESS, shadows = true, material } = {}) {
  const mesh = new THREE.Mesh(geometry, material ?? toonMaterial(color));
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  if (outline > 0) addOutline(mesh, outline);
  return mesh;
}

/** Splits a geometry so every face has its own flat normal: the low-poly look on round shapes. */
export function faceted(geometry) {
  const split = geometry.index ? geometry.toNonIndexed() : geometry;
  split.computeVertexNormals();
  return split;
}

/**
 * Gives a mesh an ink outline by drawing an inflated, inside-out copy of it behind it.
 * The copy gets averaged normals so box corners inflate as one piece instead of splitting open.
 */
export function addOutline(mesh, thickness = OUTLINE_THICKNESS) {
  const shell = mesh.geometry.clone();
  for (const name of Object.keys(shell.attributes)) {
    if (name !== 'position') shell.deleteAttribute(name);
  }
  const smoothShell = mergeVertices(shell);
  smoothShell.computeVertexNormals();

  const outline = new THREE.Mesh(smoothShell, outlineMaterial(thickness));
  outline.castShadow = false;
  outline.receiveShadow = false;
  mesh.add(outline);
  return outline;
}

function outlineMaterial(thickness) {
  if (!outlineMaterials.has(thickness)) {
    const material = new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide });
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `vec3 transformed = position + normal * ${thickness.toFixed(4)};`,
      );
    };
    material.customProgramCacheKey = () => `outline-${thickness}`;
    outlineMaterials.set(thickness, material);
  }
  return outlineMaterials.get(thickness);
}

function makeGradientMap(steps) {
  const data = new Uint8Array(steps.map(step => Math.round(step * 255)));
  const texture = new THREE.DataTexture(data, steps.length, 1, THREE.RedFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
