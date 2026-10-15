// Lot geometry and pickable bays. The event log is never edited here.
import * as T from 'three';
import { decorateLegacyLot, addInstancedBoxes, addGate, buildFacilityPreview } from './scene.js?v=parklab-20261016';
import { prepareCars } from './cars.js?v=parklab-20261016';

const cube = new T.BoxGeometry(1, 1, 1);
const colors = { Normal: 0x7d8b94, EV: 0x337e5b, Reserved: 0x366ea5 };
export const freeLight = new T.MeshStandardMaterial({ color: 0x41ff8c, emissive: 0x41ff8c, emissiveIntensity: 2 });
export const busyLight = new T.MeshStandardMaterial({ color: 0xff4444, emissive: 0xff4444, emissiveIntensity: 2 });
const white = new T.MeshStandardMaterial({ color: 0xebe8dc, roughness: 0.75 });
function box(parent, x, y, z, sx, sy, sz, material) {
  const mesh = new T.Mesh(cube, material); mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz);
  mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
function text(parent, value, x, z, width = 2, height = 0.9) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.font = 'bold 36px system-ui';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(value, 128, 32);
  const texture = new T.CanvasTexture(canvas); texture.colorSpace = T.SRGBColorSpace;
  const material = new T.MeshStandardMaterial({ map: texture, transparent: true, depthWrite: false, roughness: 0.8 });
  const mesh = new T.Mesh(new T.PlaneGeometry(width, height), material);
  mesh.rotation.set(-Math.PI / 2, 0, Math.PI); mesh.position.set(x, 0.13, z); parent.add(mesh);
}
function openLot(scene, log, world) {
  const group = new T.Group(); scene.add(group);
  const positions = new Map(log.layout.map(s => [s.index, new T.Vector3(s.index % 2 ? 8 : -8, 0.1, -34 + s.distance * 0.26)]));
  decorateLegacyLot(group, log.layout, log.layout.map(s => positions.get(s.index)), world);
  box(group, 0, -0.06, -5, 29, 0.16, 99, world.asphalt);
  const lines = [], spotMeshes = [], sensors = [];
  for (let z = -39; z < 36; z += 4) lines.push([0, 0.06, z, 0.09, 0.02, 1.8]);
  for (const spot of log.layout) {
    const p = positions.get(spot.index);
    spotMeshes.push(box(group, p.x, 0.055, p.z, 7, 0.035, 2.35,
      new T.MeshStandardMaterial({ color: colors[spot.kind], roughness: 0.8 })));
    lines.push([p.x, 0.08, p.z - 1.2, 7, 0.02, 0.045]);
    text(group, `${spot.index}${spot.kind === 'EV' ? ' ⚡' : spot.kind === 'Reserved' ? ' R' : ''}`, p.x, p.z);
    const sensor = new T.Mesh(new T.SphereGeometry(0.19, 8, 6), freeLight);
    sensor.position.set(Math.sign(p.x) * 12, 1.9, p.z); group.add(sensor); sensors.push(sensor);
  }
  addInstancedBoxes(group, lines, white);
  text(group, 'IN ↑', -2, -44, 3, 1.2); text(group, 'OUT ↓', 2, -44, 3, 1.2);
  text(group, 'WAIT', -9, -43, 4, 1.2);
  return { group, sensors, positions, spotMeshes,
    entrance: addGate(group, world.assets, -3.7), exit: addGate(group, world.assets, 0.3), setCutaway() {} };
}

export function createLot(scene, name, log, world) {
  const twoLevels = log.layout.some(s => (s.level ?? 1) > 1);
  const lot = twoLevels ? buildFacilityPreview(scene, log.layout, world, false) : openLot(scene, log, world);
  Object.assign(lot, { name, data: log.modes[name], twoLevels }); lot.group.name = `lot-${name}`;
  lot.cars = prepareCars(lot.data, lot.positions, name, twoLevels);
  lot.spotMeshes.forEach((mesh, i) => {
    const spot = log.layout[i]; mesh.userData.selection = { type: 'spot', lot, spot };
    lot.sensors[i].userData.selection = mesh.userData.selection;
  });
  for (const item of lot.cars) if (name === 'Smart' && item.route) {
    const points = item.route.positions.map(p => p.clone().add(new T.Vector3(0, 0.06, 0)));
    const geometry = new T.BufferGeometry().setFromPoints(points);
    item.routeLine = new T.Line(geometry, new T.LineBasicMaterial({ color: 0x5bffff,
      transparent: true, opacity: 0.65, blending: T.AdditiveBlending }));
    item.routeLine.visible = false; lot.group.add(item.routeLine);
  }
  lot.panel = document.createElement('article'); lot.panel.id = `panel-${name}`;
  const fields = ['Parked now', 'Occupancy', 'Turned away', 'Price / hour', 'Revenue earned', 'Avg search'];
  lot.panel.innerHTML = `<div class="title"><h2>${name}</h2><span class="badge" hidden>HIGH PRICE</span></div>
    <div class="stats">${fields.map(f => `<div><span>${f}</span><b>0</b></div>`).join('')}</div>
    <p class="muted extra" hidden></p><canvas class="chart" role="img" aria-label="${name} occupancy; dashed line is the price threshold"></canvas>`;
  document.getElementById('dashboards').appendChild(lot.panel);
  return lot;
}

export function updateSensors(lot, minute, layout) {
  const occupied = new Set(lot.data.cars.filter(c => c.outcome === 'parked' &&
    c.assign_time <= minute && minute < c.leave_time).map(c => c.spot_index));
  lot.sensors.forEach((sensor, i) => { sensor.material = occupied.has(layout[i].index) ? busyLight : freeLight; });
}
