// Part 1 asset loading. Nothing in this module reads or changes simulation events.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

// Sizes are DISPLAY units; the original simulation distances remain untouched.
export const MODEL_FILES = {
  sedan: { file: 'campus_sedan.glb', axis: 'z', size: 3.8 },
  hatchback: { file: 'campus_hatchback.glb', axis: 'z', size: 3.5 },
  suv: { file: 'campus_suv.glb', axis: 'z', size: 3.9 },
  ev: { file: 'campus_ev.glb', axis: 'z', size: 3.8 },
  van: { file: 'campus_van.glb', axis: 'z', size: 4.1 },
  barrier: { file: 'barrier_gate.glb', axis: 'x', size: 3.8 },
  lamp: { file: 'light_pole.glb', axis: 'y', size: 5.8 },
  tree: { file: 'campus_tree.glb', axis: 'y', size: 7 },
  bush: { file: 'campus_bush.glb', axis: 'y', size: 1.2 },
  bench: { file: 'bench.glb', axis: 'x', size: 2.4 },
  cone: { file: 'traffic_cone.glb', axis: 'y', size: 0.75 },
  sign: { file: 'parking_sign.glb', axis: 'y', size: 2.4 },
};

export class AssetManager {
  constructor(report = () => {}) {
    this.report = report;
    this.models = new Map(); this.textures = new Map(); this.hdris = new Map();
    this.failures = []; this.loaded = 0; this.completed = 0; this.total = 23;
    this.gltf = new GLTFLoader(); this.hdr = new RGBELoader();
    this.textureLoader = new THREE.TextureLoader();
  }

  async loadOne(label, load, fallback) {
    let timer;
    try {
      // A stalled file must not prevent the rest of the scene from opening.
      const value = await Promise.race([load(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('20 second timeout')), 20000);
      })]);
      this.loaded++;
      return value;
    } catch (error) {
      this.failures.push(`${label}: ${error.message}`);
      console.warn(`Using built-in fallback for ${label}`, error.message);
      return fallback();
    } finally {
      clearTimeout(timer); this.completed++;
      this.report({ done: this.completed, total: this.total, loaded: this.loaded,
        missing: this.failures.length, current: label });
    }
  }

  async loadAll() {
    const tasks = [];
    for (const [key, spec] of Object.entries(MODEL_FILES)) {
      tasks.push(async () => {
        const model = await this.loadOne(spec.file,
          async () => (await this.gltf.loadAsync(`assets/models/${spec.file}`)).scene,
          () => fallbackModel(key));
        model.name = `asset-${key}`;
        // A configurable yaw is useful when replacing a model facing another direction.
        model.rotation.y += spec.yaw ?? 0;
        model.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());
        const scale = spec.size / Math.max(size[spec.axis], 0.001);
        const normalized = new THREE.Group();
        model.scale.multiplyScalar(scale);
        model.position.sub(bounds.getCenter(new THREE.Vector3()).multiplyScalar(scale));
        model.position.y += size.y * scale / 2;
        normalized.add(model);
        normalized.traverse(child => {
          if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
        });
        normalized.updateMatrixWorld(true); this.models.set(key, normalized);
      });
    }
    for (const surface of ['asphalt', 'concrete', 'grass']) {
      for (const map of ['color', 'normal', 'roughness']) {
        tasks.push(async () => {
          const key = `${surface}_${map}`;
          const texture = await this.loadOne(`${key}.jpg`,
            () => this.textureLoader.loadAsync(`assets/textures/${key}.jpg`),
            () => fallbackTexture(surface, map));
          texture.colorSpace = map === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          this.textures.set(key, texture);
        });
      }
    }
    for (const name of ['day', 'sunset']) {
      tasks.push(async () => {
        const texture = await this.loadOne(`${name}.hdr`,
          () => this.hdr.loadAsync(`assets/hdri/${name}.hdr`), () => fallbackSky(name));
        texture.mapping = THREE.EquirectangularReflectionMapping;
        this.hdris.set(name, texture);
      });
    }
    // Six concurrent requests are enough for a local server and avoid a large burst.
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < tasks.length) { const task = tasks[next++]; await task(); }
    }));
    return this;
  }

  cloneModel(key) { return this.models.get(key).clone(true); }

  surface(name, repeatX = 1, repeatY = 1) {
    const maps = {};
    for (const [suffix, slot] of [['color', 'map'], ['normal', 'normalMap'], ['roughness', 'roughnessMap']]) {
      const texture = this.textures.get(`${name}_${suffix}`).clone();
      texture.repeat.set(repeatX, repeatY); texture.anisotropy = 4;
      maps[slot] = texture;
    }
    return new THREE.MeshPhysicalMaterial({ ...maps, roughness: 0.85, metalness: 0,
      normalScale: new THREE.Vector2(0.3, 0.3), clearcoat: 0 });
  }
}

// These small stand-ins guarantee that a missing model never creates a blank lot.
function fallbackModel(kind) {
  const group = new THREE.Group();
  const material = color => new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
  function box(x, y, z, sx, sy, sz, color) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material(color));
    mesh.position.set(x, y, z); group.add(mesh); return mesh;
  }
  if (['sedan', 'hatchback', 'suv', 'ev', 'van'].includes(kind)) {
    box(0, 0.5, 0, 1.1, 0.45, 2, kind === 'ev' ? 0x379577 : 0xa9beca).name = 'body';
    box(0, 0.85, -0.1, 0.85, 0.4, 1, 0x243d4b).name = 'glass';
    for (const x of [-0.55, 0.55]) for (const z of [-0.6, 0.6]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.16, 10), material(0x151b20));
      wheel.geometry.rotateZ(Math.PI / 2); wheel.name = `wheel-${z > 0 ? 'front' : 'back'}-${x > 0 ? 'left' : 'right'}`; wheel.position.set(x, 0.25, z); group.add(wheel);
    }
  } else if (kind === 'tree' || kind === 'bush') {
    if (kind === 'tree') box(0, 1.2, 0, 0.25, 2.4, 0.25, 0x675444);
    for (let i = 0; i < 3; i++) {
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(kind === 'tree' ? 1.4 : 0.7, 1), material(0x476943));
      crown.position.set((i - 1) * 0.5, kind === 'tree' ? 2.5 + i * 0.4 : 0.5, 0); group.add(crown);
    }
  } else if (kind === 'lamp') {
    box(0, 2.5, 0, 0.15, 5, 0.15, 0x4b5357); box(0.6, 5, 0, 1.4, 0.15, 0.4, 0xd2d8ce);
  } else if (kind === 'barrier') {
    box(0, 0.6, 0, 0.5, 1.2, 0.5, 0x465866);
    const pivot = new THREE.Group(); pivot.name = 'ArmPivot'; pivot.position.y = 1.2; group.add(pivot);
    const arm = box(1.7, 0, 0, 3.4, 0.13, 0.16, 0xebd8bb); pivot.add(arm);
  } else if (kind === 'bench') {
    box(0, 0.55, 0, 2, 0.16, 0.7, 0x996b43); box(0, 0.95, 0.3, 2, 0.7, 0.12, 0x996b43);
    for (const x of [-0.7, 0.7]) box(x, 0.25, 0, 0.12, 0.5, 0.65, 0x35444b);
  } else if (kind === 'cone') {
    const mesh = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.75, 12), material(0xe8752e));
    mesh.position.y = 0.4; group.add(mesh); box(0, 0.04, 0, 0.65, 0.08, 0.65, 0x26313a);
  } else {
    box(0, 1, 0, 0.1, 2, 0.1, 0x747d81); box(0, 1.8, 0, 0.9, 0.8, 0.08, 0x235996);
  }
  return group;
}

function fallbackTexture(surface, map) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(128, 128);
  const base = { asphalt: [63, 68, 73], concrete: [155, 151, 140], grass: [78, 99, 53] }[surface];
  for (let i = 0; i < pixels.data.length; i += 4) {
    const n = (Math.sin(i * 19.13) * 437.1) % 1;
    const rgb = map === 'normal' ? [128 + n * 5, 128 + n * 5, 254]
      : map === 'roughness' ? [210 + n * 20, 210 + n * 20, 210 + n * 20] : base.map(c => c + n * 14);
    pixels.data.set([...rgb, 255], i);
  }
  ctx.putImageData(pixels, 0, 0); return new THREE.CanvasTexture(canvas);
}

function fallbackSky(name) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
  const ctx = canvas.getContext('2d'), gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, name === 'day' ? '#6c9fbf' : '#293454');
  gradient.addColorStop(0.48, name === 'day' ? '#d6dfe0' : '#e1a778');
  gradient.addColorStop(1, '#343a36'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 512, 256);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}
