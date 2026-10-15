// Shared facility construction for the working replay and the two-level preview.
import * as THREE from 'three';
import { createLighting } from './lighting.js?v=parklab-20261016';

const cube = new THREE.BoxGeometry(1, 1, 1);
const kindColor = { Normal: 0x899093, EV: 0x398965, Reserved: 0x346ba5 };
const metal = new THREE.MeshStandardMaterial({ color: 0x59626b, roughness: 0.35, metalness: 0.75 });
const white = new THREE.MeshStandardMaterial({ color: 0xe8e4d5, roughness: 0.8 });
const glass = new THREE.MeshPhysicalMaterial({ color: 0x88b3c6, roughness: 0.06,
  metalness: 0, transmission: 0.4, transparent: true, opacity: 0.75, thickness: 0.08 });

function box(parent, x, y, z, sx, sy, sz, material) {
  const mesh = new THREE.Mesh(cube, material); mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz);
  mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh;
}

// Repeated geometry is sent to the GPU in one batch, instead of one draw per copy.
function boxes(parent, transforms, material) {
  const mesh = new THREE.InstancedMesh(cube, material, transforms.length);
  const object = new THREE.Object3D();
  transforms.forEach(([x, y, z, sx, sy, sz, yaw = 0], i) => {
    object.position.set(x, y, z); object.scale.set(sx, sy, sz); object.rotation.set(0, yaw, 0);
    object.updateMatrix(); mesh.setMatrixAt(i, object.matrix);
  });
  mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh;
}

export { boxes as addInstancedBoxes };

function instances(parent, assets, name, placements) {
  const source = assets.models.get(name); source.updateMatrixWorld(true);
  source.traverse(part => {
    if (!part.isMesh) return;
    const batch = new THREE.InstancedMesh(part.geometry, part.material, placements.length);
    const object = new THREE.Object3D(), matrix = new THREE.Matrix4();
    placements.forEach(([x, y, z, yaw = 0, scale = 1], i) => {
      object.position.set(x, y, z); object.rotation.set(0, yaw, 0); object.scale.setScalar(scale);
      object.updateMatrix(); matrix.multiplyMatrices(object.matrix, part.matrixWorld); batch.setMatrixAt(i, matrix);
    });
    batch.castShadow = batch.receiveShadow = true; batch.name = `instances-${name}`; parent.add(batch);
  });
}

function label(parent, text, x, y, z, width, height, ground = false) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f0ede0';
  ctx.font = 'bold 62px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 256, 64);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: texture, transparent: true,
    roughness: 0.85, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
  mesh.position.set(x, y, z);
  if (ground) { mesh.rotation.x = -Math.PI / 2; mesh.rotation.z = Math.PI; }
  else mesh.rotation.y = Math.PI;
  parent.add(mesh); return mesh;
}

export function createWorld(scene, renderer, camera, assets) {
  const lighting = createLighting(scene, renderer, camera, assets);
  const asphalt = assets.surface('asphalt', 9, 30), concrete = assets.surface('concrete', 10, 24);
  const grass = assets.surface('grass', 60, 60);
  lighting.registerWet(asphalt);
  const terrain = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), grass);
  terrain.rotation.x = -Math.PI / 2; terrain.position.y = -0.25; terrain.receiveShadow = true;
  scene.add(terrain);

  const surroundings = new THREE.Group(); surroundings.name = 'surroundings'; scene.add(surroundings);
  const road = assets.surface('asphalt', 70, 4); lighting.registerWet(road);
  box(surroundings, 0, -0.05, -65, 300, 0.2, 13, road);
  box(surroundings, 0, -0.02, -56, 300, 0.25, 4, concrete);
  box(surroundings, 0, -0.02, -74, 300, 0.25, 3, concrete);
  const markings = [];
  for (let x = -145; x < 150; x += 7) markings.push([x, 0.07, -65, 3, 0.015, 0.1]);
  for (let x = -4; x < 5; x += 1.1) markings.push([x, 0.075, -65, 0.55, 0.015, 12]);
  boxes(surroundings, markings, white);
  const trees = [], bushes = [], streetLamps = [];
  for (let i = 0; i < 17; i++) {
    const x = -128 + i * 16;
    trees.push([x, 0, 65 + (i % 3) * 5, i * 0.73, 0.8 + (i % 4) * 0.09]);
    if (Math.abs(x) > 60) trees.push([x, 0, -42, i * 0.5, 0.9]);
    bushes.push([x, 0, -50, i * 0.6, 1.4]);
    if (i % 2 === 0) streetLamps.push([x, 0, -54, Math.PI / 2]);
  }
  instances(surroundings, assets, 'tree', trees);
  instances(surroundings, assets, 'bush', bushes);
  instances(surroundings, assets, 'lamp', streetLamps);

  // A distant, deliberately inexpensive skyline anchors the facility in a town.
  const buildings = [], windows = [];
  for (let i = 0; i < 22; i++) {
    const x = -150 + i * 14, height = 12 + (i * 7) % 22, z = 90 + (i % 3) * 12;
    buildings.push([x, height / 2, z, 10, height, 12]);
    for (let floor = 3; floor < height - 1; floor += 3) {
      for (let col = -3; col <= 3; col += 3) windows.push([x + col, floor, z - 6.02, 1.2, 1.4, 0.04]);
    }
  }
  boxes(surroundings, buildings, new THREE.MeshStandardMaterial({ color: 0x8d9294, roughness: 0.9 }));
  const windowMaterial = new THREE.MeshStandardMaterial({ color: 0x536977, emissive: 0xffc887, emissiveIntensity: 0.1 });
  const windowMesh = boxes(surroundings, windows, windowMaterial); lighting.registerLamp(windowMesh);
  return { lighting, asphalt, concrete, assets };
}

function charger(parent, x, y, z) {
  box(parent, x, y + 0.7, z, 0.5, 1.4, 0.45, white);
  const screen = new THREE.MeshStandardMaterial({ color: 0x173e38, emissive: 0x34c999, emissiveIntensity: 0.4 });
  box(parent, x, y + 0.94, z - 0.24, 0.3, 0.3, 0.03, screen);
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(x + 0.25, y + 1.05, z), new THREE.Vector3(x + 0.7, y + 0.65, z - 0.2),
    new THREE.Vector3(x + 0.55, y + 0.2, z - 0.35), new THREE.Vector3(x + 0.35, y + 0.65, z - 0.25),
  ]);
  const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.035, 6, false), metal); parent.add(cable);
  label(parent, '⚡', x, y + 0.42, z - 0.245, 0.35, 0.32);
}

function booth(parent, material) {
  box(parent, 9, 1.35, -41, 3.4, 2.7, 3.1, material);
  box(parent, 9, 2.9, -41, 4, 0.23, 3.7, metal);
  box(parent, 9, 1.8, -42.57, 2.6, 1.2, 0.04, glass);
  box(parent, 7.27, 1.8, -41, 0.04, 1.2, 2.2, glass);
  label(parent, 'PARKING', 9, 2.65, -42.61, 2.8, 0.4);
  label(parent, 'ENTRY  /  EXIT', 0, 0.12, -39, 6, 1, true);
}

export function decorateLegacyLot(group, layout, positions, world) {
  const { assets, concrete, lighting } = world;
  // Keep every old car/spot coordinate unchanged. Decorations stay outside the lanes.
  box(group, 0, -0.04, -5, 34, 0.1, 102, concrete);
  booth(group, concrete);
  const rails = [], poles = [], stops = [], bollards = [];
  for (let z = -52; z <= 44; z += 4) {
    for (const x of [-16, 16]) poles.push([x, 0.7, z, 0.09, 1.4, 0.09]);
  }
  for (const x of [-16, 16]) for (const y of [0.5, 1.15]) rails.push([x, y, -4, 0.06, 0.06, 98]);
  for (const y of [0.5, 1.15]) rails.push([0, y, 44, 32, 0.06, 0.06]);
  layout.forEach((spot, i) => {
    const p = positions[i]; stops.push([Math.sign(p.x) * 10.8, 0.16, p.z, 0.25, 0.22, 1.7]);
    if (spot.kind === 'EV') charger(group, Math.sign(p.x) * 12.3, 0, p.z);
  });
  for (let x = -4; x <= 4; x += 2) if (x !== -2 && x !== 2) bollards.push([x, 0.45, -44.5, 0.18, 0.9, 0.18]);
  boxes(group, [...rails, ...poles, ...bollards], metal); boxes(group, stops, white);
  instances(group, assets, 'bench', [[-14, 0, -38, Math.PI / 2], [-14, 0, 37, Math.PI / 2]]);
  instances(group, assets, 'cone', [[5, 0, -45], [6, 0, -45], [7, 0, -45]]);
  instances(group, assets, 'sign', [[12, 0, -47, 0]]);
  label(group, 'P', 12, 1.95, -47.15, 0.65, 0.65);
  const lamps = [[-14.8, 0, -30], [-14.8, 0, 8], [14.8, 0, -12, Math.PI], [14.8, 0, 32, Math.PI]];
  instances(group, assets, 'lamp', lamps);
  const lampMaterial = new THREE.MeshStandardMaterial({ color: 0xffe2aa, emissive: 0xffdb8c, emissiveIntensity: 0.1 });
  lamps.forEach(([x, y, z]) => lighting.registerLamp(box(group, x, y + 5.5, z, 0.45, 0.07, 0.6, lampMaterial)));
}

export function buildFacilityPreview(scene, layout, world, showcase = true) {
  const group = new THREE.Group(); group.name = 'two-level-facility'; scene.add(group);
  const levelHeight = 6, levels = [...new Set(layout.map(s => s.level ?? 1))].sort();
  const byLevel = levels.map(level => layout.filter(s => (s.level ?? 1) === level));
  const upperSlabs = [], sensors = [], roofObjects = [];
  const positions = new Map(), spotMeshes = [];
  const sensorMaterial = new THREE.MeshStandardMaterial({ color: 0x41ff8c, emissive: 0x41ff8c, emissiveIntensity: 2 });
  const sensorGeometry = new THREE.SphereGeometry(0.14, 8, 6);
  levels.forEach((level, row) => {
    const y = (level - 1) * levelHeight;
    const slab = box(group, 0, y - 0.22, 3, 35, 0.4, 70, world.concrete);
    if (level > 1) upperSlabs.push(slab);
    const markings = [], rails = [];
    byLevel[row].forEach((spot, index) => {
      const x = index % 2 ? 8 : -8, z = -24 + Math.floor(index / 2) * 4;
      positions.set(spot.index, new THREE.Vector3(x, y + 0.1, z));
      const paint = new THREE.MeshStandardMaterial({ color: kindColor[spot.kind], roughness: 0.83 });
      spotMeshes.push(box(group, x, y + 0.025, z, 6.6, 0.03, 3.5, paint));
      markings.push([x, y + 0.05, z - 1.8, 6.7, 0.02, 0.06], [Math.sign(x) * 10.6, y + 0.15, z, 0.2, 0.2, 2]);
      label(group, `${spot.index}${spot.kind === 'EV' ? ' ⚡' : spot.kind === 'Reserved' ? ' R' : ''}`, x, y + 0.075, z, 2.5, 1, true);
      if (spot.kind === 'EV') charger(group, Math.sign(x) * 12.2, y, z);
      const sensor = new THREE.Mesh(sensorGeometry, sensorMaterial); sensor.position.set(x, y + 2.2, z);
      sensor.userData.spotIndex = spot.index; group.add(sensor); sensors.push(sensor);
    });
    for (let z = -28; z < 34; z += 6) markings.push([0, y + 0.05, z, 0.08, 0.02, 2.5]);
    for (const x of [-17, 17]) rails.push([x, y + 0.6, x > 0 ? -1 : 3, 0.18, 1.2, x > 0 ? 62 : 70]);
    boxes(group, markings, white); boxes(group, rails, world.concrete);
    label(group, `LEVEL ${level}`, 0, y + 0.08, -29, 7, 1.5, true);
  });
  const columns = [];
  for (const x of [-14, 14]) for (let z = -27; z <= 33; z += 15) columns.push([x, 5.5, z, 0.65, 11, 0.65]);
  boxes(group, columns, world.concrete);
  const roof = box(group, 0, 11.6, 3, 36, 0.35, 72, world.concrete); roofObjects.push(roof);

  // A side ramp rises from the forecourt to the upper rear cross-aisle.
  if (levels.length > 1) {
    const rampGeometry = new THREE.BufferGeometry();
    rampGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      19, 0, -8, 23, 0, -8, 19, 6, 32, 23, 0, -8, 23, 6, 32, 19, 6, 32,
    ], 3));
    rampGeometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1], 2));
    rampGeometry.computeVertexNormals();
    const ramp = new THREE.Mesh(rampGeometry, world.asphalt); ramp.material.side = THREE.DoubleSide;
    ramp.castShadow = ramp.receiveShadow = true; group.add(ramp);
    box(group, 18, 5.9, 34, 10, 0.2, 4, world.concrete);
    for (const x of [18.8, 23.2]) {
      const rail = box(group, x, 3.5, 12, 0.18, 0.8, 40.45, world.concrete);
      rail.rotation.x = -Math.atan2(6, 40);
    }
    box(group, 21, -0.05, -25, 5, 0.15, 34, world.asphalt);
  }
  box(group, 0, -0.05, -42, 50, 0.15, 15, world.asphalt);
  booth(group, world.concrete);
  const entrance = addGate(group, world.assets, -3.7), exit = addGate(group, world.assets, 0.3);
  instances(group, world.assets, 'cone', [[-6, 0, -45], [-7, 0, -45], [7, 0, -45]]);
  instances(group, world.assets, 'bench', [[-18, 0, -35], [-18, 0, 30]]);
  instances(group, world.assets, 'lamp', [[-22, 0, -34], [-22, 0, 30], [26, 0, -34], [26, 0, 30]]);
  // Model showcase is outside the 50 bays. It is explicitly not simulated traffic.
  if (showcase) ['sedan', 'hatchback', 'suv', 'ev', 'van'].forEach((name, i) => {
    const model = world.assets.cloneModel(name); model.position.set(-14 + i * 6, 0, -49); group.add(model);
  });
  if (showcase) label(group, 'ASSET SHOWCASE / NOT SIMULATED', 0, 0.09, -51.8, 25, 0.9, true);
  return { group, sensors, positions, levels, spotMeshes, entrance, exit,
    setCutaway: value => [...upperSlabs, ...roofObjects].forEach(mesh => { mesh.visible = !value; }) };
}

// Place the moving pivot above a lane; normalization may have shifted the model root.
export function addGate(parent, assets, x) {
  const model = assets.cloneModel('barrier'); parent.add(model); model.updateMatrixWorld(true);
  const pivot = model.getObjectByName('ArmPivot');
  const local = model.worldToLocal(pivot.getWorldPosition(new THREE.Vector3()));
  model.position.set(x - local.x, -local.y + 1.2, -42 - local.z);
  return pivot;
}
