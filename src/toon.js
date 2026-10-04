import * as THREE from 'three';
import { mergeVertices, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Toon look helpers: hard-stepped lighting and ink outlines, shared by everything in the world.

// Brightness of each light step, darkest to brightest. Few, hard steps give the Killer7 graphic look.
const LIGHT_STEPS = [0.45, 0.75, 1.0];
export const OUTLINE_COLOR = 0x241a14;
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

/** Frees the GPU memory of everything under an object that was built for one-off use (shared materials survive). */
export function disposeTree(object) {
  object.traverse(child => {
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material && !isSharedMaterial(material)) material.dispose();
    }
  });
}

function isSharedMaterial(material) {
  return [...outlineMaterials.values()].includes(material);
}

/**
 * Bakes every still mesh under `root` into one mesh per material, outlines included: a pile of small
 * parts becomes a handful of draw calls. Meshes for which `keep(mesh)` is true (or that sit under a kept
 * object) stay as they are: anything that moves, changes colour or must stay separate. Meshes for which
 * `pickable(mesh)` is true are merged but left in place, hidden, so raycasts (the garage's mount picking)
 * still find them. Transparent and custom-shader meshes always stay as they are.
 */
export function mergeStaticMeshes(root, { keep = () => false, pickable = () => false } = {}) {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const buckets = new Map();   // material key → { material, castShadow, receiveShadow, geometries }
  const merged = [];
  root.traverse(object => {
    if (!object.isMesh || object.isInstancedMesh || !isMergeable(object, root, keep)) return;
    const key = `${materialKey(object.material)}|${object.castShadow}|${object.receiveShadow}`;
    if (!buckets.has(key)) {
      buckets.set(key, { material: object.material, castShadow: object.castShadow, receiveShadow: object.receiveShadow, geometries: [] });
    }
    buckets.get(key).geometries.push(bakedGeometry(object, toRoot));
    merged.push(object);
  });
  for (const object of merged) {
    if (pickable(object)) {
      object.visible = false;
      continue;
    }
    // Children that weren't merged (a kept part hanging off a merged one) move up, keeping their place.
    for (const child of [...object.children]) {
      if (!merged.includes(child)) object.parent.attach(child);
    }
    object.removeFromParent();
    object.geometry.dispose();
  }
  for (const bucket of buckets.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(bucket.geometries), bucket.material);
    mesh.castShadow = bucket.castShadow;
    mesh.receiveShadow = bucket.receiveShadow;
    root.add(mesh);
    for (const geometry of bucket.geometries) geometry.dispose();
  }
  return buckets.size;
}

function isMergeable(object, root, keep) {
  const material = object.material;
  if (Array.isArray(material) || material.transparent || material.isShaderMaterial) return false;
  for (let node = object; node && node !== root; node = node.parent) {
    if (keep(node) || !node.visible) return false;
  }
  return true;
}

/** Meshes with equal-looking materials can share one; outline materials are shared instances already. */
function materialKey(material) {
  if (isSharedMaterial(material)) return material.uuid;
  return [
    material.type, material.color?.getHexString(), material.emissive?.getHexString(), material.emissiveIntensity,
    material.side, material.vertexColors, material.gradientMap?.uuid,
  ].join(':');
}

/** A copy of a mesh's geometry in the root's space, reduced to the attributes every merge partner has. */
function bakedGeometry(object, toRoot) {
  let geometry = object.geometry.clone();
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal' && !(name === 'color' && object.material.vertexColors)) geometry.deleteAttribute(name);
  }
  if (geometry.index) geometry = geometry.toNonIndexed();
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  geometry.morphAttributes = {};
  return geometry.applyMatrix4(toRoot.clone().multiply(object.matrixWorld));
}
