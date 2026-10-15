// Presentation only: every position is a function of the saved event time.
import * as T from 'three';

export const EXIT_MINUTES = 1; // Visual drive after release; adds no occupancy or fee.
const GAP = 4.6; // Display units, including the car body.
const clamp = T.MathUtils.clamp;
const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const v = (x, y, z) => new T.Vector3(x, y, z);
export const releaseTime = c => c.leave_time ?? c.give_up_time ?? c.price_refusal_time;
export const waitEnd = c => c.search_start ?? c.assign_time ?? releaseTime(c);
export const exitDuration = c => c.exit_time != null ? Math.max(0.001, c.exit_time - releaseTime(c)) : EXIT_MINUTES;
const colors = {
  Normal: [0xe5e9e9, 0xb1bbc2, 0x68727d, 0xd1c6b2, 0x738792],
  EV: [0x36ae82, 0x27745c, 0x87c4a5], Reserved: [0x3277bd, 0x253f70, 0x80a8d2],
};
// A stable integer hash chooses appearance; it never consumes Python's random stream.
function hash(id) { return Math.imul(Number(id) + 17, 2654435761) >>> 0; }
export function modelName(c) {
  return c.kind === 'EV' ? 'ev' : c.kind === 'Reserved' ? 'suv'
    : ['sedan', 'hatchback', 'van'][hash(c.car_id) % 3];
}

// Curves are sampled once. A weighted time table makes corners/gates slower.
// Normalizing that table keeps both endpoint timestamps exactly as recorded.
export function makePath(points) {
  const clean = points.filter((p, i) => !i || p.distanceTo(points[i - 1]) > 0.001);
  if (clean.length < 2) clean.push(clean[0].clone().add(v(0, 0, 0.001)));
  const curve = new T.CatmullRomCurve3(clean, false, 'centripetal');
  const count = Math.max(80, clean.length * 16), positions = curve.getSpacedPoints(count);
  const minY = Math.min(...clean.map(p => p.y)), maxY = Math.max(...clean.map(p => p.y));
  for (const p of positions) {
    // Cubic curves can overshoot vertically; keep wheels on the decks and ramp.
    p.y = clamp(p.y, minY, maxY);
    if (maxY > 3 && minY < 1 && p.x > 19 && p.x < 23) p.y = 0.1 + clamp((p.z + 8) / 40, 0, 1) * 6;
  }
  const times = [0], distances = [0];
  for (let i = 1; i <= count; i++) {
    const delta = positions[i].clone().sub(positions[i - 1]);
    const previous = i > 1 ? positions[i - 1].clone().sub(positions[i - 2]) : delta;
    const turn = delta.lengthSq() && previous.lengthSq() ? delta.angleTo(previous) : 0;
    const gate = Math.exp(-Math.pow((positions[i].z + 42) / 2.5, 2));
    const end = i > count * 0.92 || i < count * 0.06 ? 0.5 : 0;
    distances.push(distances[i - 1] + delta.length());
    times.push(times[i - 1] + delta.length() * (1 + turn * 8 + gate * 1.3 + end));
  }
  const total = times[count]; times.forEach((t, i) => { times[i] = t / total; });
  function at(fraction) {
    const f = clamp(fraction, 0, 1);
    let lo = 1, hi = count;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < f) lo = mid + 1; else hi = mid; }
    const i = lo, t = (f - times[i - 1]) / Math.max(1e-9, times[i] - times[i - 1]);
    const direction = positions[i].clone().sub(positions[i - 1]).normalize();
    return { position: positions[i - 1].clone().lerp(positions[i], t), direction,
      distance: T.MathUtils.lerp(distances[i - 1], distances[i], t) };
  }
  return { at, positions, length: distances[count] };
}

// Allocate stable waiting places by interval overlap: no jumps when another car leaves.
export function prepareCars(data, positions, mode, twoLevels = false) {
  const queueUntil = [], items = [];
  for (const c of data.cars) {
    const end = waitEnd(c), waited = end > c.arrival + 1e-8;
    let queue = -1;
    if (waited) {
      queue = queueUntil.findIndex(t => t <= c.arrival);
      if (queue < 0) queue = queueUntil.length;
      queueUntil[queue] = end;
    }
    const entrance = v(-1.8, 0.1, -45);
    // Extend away from the road for unusually long queues; the small apron is illustrative.
    const waiting = v(-12 + (queue % 4) * 2.6, 0.1, -47 - Math.floor(queue / 4) * 2.8);
    const start = waited ? waiting : entrance;
    const item = { data: c, mesh: null, routeLine: null, queue, name: modelName(c) };
    item.approach = makePath([entrance, v(-3, 0.1, -45.5), start]);
    if (c.outcome !== 'parked') {
      if (c.search_start != null) {
        item.route = makePath([start, v(-1.8, 0.1, -40), v(-1.8, 0.1, 15),
          v(0, 0.1, 17), v(1.8, 0.1, 15), v(1.8, 0.1, -38), start]);
      }
      item.exitRoute = makePath([start, v(-1.8, 0.1, -40), v(0, 0.1, -38.5), v(1.8, 0.1, -40), v(1.8, 0.1, -55)]);
    } else {
      const p = positions.get(c.spot_index), points = [start, v(-1.8, 0.1, -42), v(-1.8, 0.1, -36)];
      if (mode === 'Normal') {
        const laps = 1 + hash(c.car_id) % 2;
        for (let lap = 0; lap < laps; lap++) {
          const turn = 8 + (hash(c.car_id + lap) % 15);
          points.push(v(-1.8, 0.1, turn), v(-1, 0.1, turn + 1.5), v(1, 0.1, turn + 1.5),
            v(1.8, 0.1, turn), v(1.8, 0.1, -34), v(1, 0.1, -36), v(-1, 0.1, -36), v(-1.8, 0.1, -34));
        }
      }
      if (twoLevels && p.y > 3) {
        // Forecourt -> ramp -> upper rear cross-aisle. Height follows the ramp.
        points.push(v(0, 0.1, -35), v(20, 0.1, -35), v(21, 0.1, -12),
          v(21, 0.1, -8), v(21, 6.1, 32), v(20, 6.1, 34), v(2, 6.1, 34), v(-1.8, 6.1, 31));
      }
      const y = p.y, approachZ = twoLevels && y > 3 ? p.z + 2 : p.z - 2;
      points.push(v(-1.8, y, approachZ), v(-1.8, y, p.z), v(Math.sign(p.x) * 4, y, p.z), p.clone());
      item.route = makePath(points);
      const exit = [p.clone(), v(Math.sign(p.x) * 4, y, p.z), v(1.8, y, p.z)];
      if (twoLevels && y > 3) exit.push(v(1.8, y, 31), v(3, y, 34), v(20, y, 34),
        v(21, 6.1, 32), v(21, 0.1, -8), v(21, 0.1, -33), v(18, 0.1, -36), v(1.8, 0.1, -38));
      exit.push(v(1.8, 0.1, -42), v(1.8, 0.1, -55));
      item.exitRoute = makePath(exit); item.spot = p;
    }
    items.push(item);
  }
  return items;
}

export function poseAt(item, time) {
  const c = item.data, release = releaseTime(c), end = waitEnd(c);
  if (time < c.arrival || time >= release + exitDuration(c)) return { visible: false, state: time < c.arrival ? 'Not arrived' : 'Departed' };
  let path, fraction, duration, state;
  if (time < end) {
    duration = Math.min(0.25, (end - c.arrival) / 2);
    path = item.approach; fraction = (time - c.arrival) / duration; state = 'Waiting';
  } else if (time >= release) {
    path = item.exitRoute; duration = exitDuration(c); fraction = (time - release) / duration;
    state = c.outcome === 'parked' ? 'Leaving' : 'Turned away';
  } else if (c.outcome !== 'parked' || time < c.park_start) {
    path = item.route; duration = (c.park_start ?? release) - end;
    fraction = (time - end) / Math.max(duration, 1e-9); state = 'Searching';
  } else return { visible: true, state: 'Parked', position: item.spot.clone(),
    direction: v(Math.sign(item.spot.x), 0, 0), distance: item.route.length, speed: 0, steering: 0 };
  const point = path.at(fraction), ahead = path.at(fraction + 0.002), behind = path.at(fraction - 0.002);
  if (state === 'Leaving' && item.route) point.distance += item.route.length;
  const speed = fraction >= 1 ? 0 : (ahead.distance - behind.distance) / (0.004 * duration * 60);
  const angle = Math.atan2(ahead.direction.x, ahead.direction.z) - Math.atan2(behind.direction.x, behind.direction.z);
  const steering = clamp(Math.atan2(Math.sin(angle), Math.cos(angle)) * 5, -0.5, 0.5);
  return { ...point, visible: true, state, speed, steering, path, fraction, duration,
    braking: Math.abs(steering) > 0.12 || Math.abs(point.position.z + 42) < 3 || fraction > 0.94 };
}

// Snapshot-based following: seeking backwards gives the exact same display.
// Corrections taper at event boundaries; logged deadlines take priority over spacing.
// This is a visual aid, not a collision-free traffic simulation.
export function applyFollowing(items) {
  const moving = items.filter(i => i.pose.visible && i.pose.path && i.pose.speed > 0.01);
  for (const item of moving) {
    const p = item.pose; let correction = 0;
    for (const other of items) {
      if (item === other || !other.pose.visible) continue;
      const q = other.pose;
      if (Math.abs(p.position.y - q.position.y) > 0.7 || p.direction.dot(q.direction) < 0.85) continue;
      const delta = q.position.clone().sub(p.position), forward = delta.dot(p.direction);
      const lateral = delta.clone().addScaledVector(p.direction, -forward).length();
      if (forward > 0.001 && forward < GAP && lateral < 0.85) correction = Math.max(correction, GAP - forward);
    }
    if (correction) {
      const taper = smooth(p.fraction / 0.06) * smooth((1 - p.fraction) / 0.09);
      const shift = correction / Math.max(1, p.path.length) * taper;
      const adjusted = p.path.at(Math.max(0, p.fraction - shift));
      if (p.state === 'Leaving' && item.route) adjusted.distance += item.route.length;
      item.pose = { ...p, ...adjusted, braking: true, following: true };
    }
  }
}

const bodyTemplates = new Map();
// Kenney uses a single palette for paint, glass and trim. Split triangles using that
// palette, so changing paint does not colour the tyres or erase the windows.
function prepareBody(source, key) {
  if (bodyTemplates.has(key)) return bodyTemplates.get(key);
  const geometry = source.geometry.index ? source.geometry.toNonIndexed() : source.geometry.clone();
  const uv = geometry.attributes.uv, texture = source.material.map;
  if (!uv || !texture?.image) { const result = { geometry, painted: false }; bodyTemplates.set(key, result); return result; }
  const canvas = document.createElement('canvas'); canvas.width = texture.image.width; canvas.height = texture.image.height;
  const ctx = canvas.getContext('2d'); ctx.drawImage(texture.image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  function sample(i) {
    const point = texture.transformUv(new T.Vector2(uv.getX(i), uv.getY(i)));
    const x = clamp(Math.floor(point.x * canvas.width), 0, canvas.width - 1);
    const y = clamp(Math.floor(point.y * canvas.height), 0, canvas.height - 1);
    const offset = (y * canvas.width + x) * 4; return Array.from(pixels.slice(offset, offset + 3));
  }
  const counts = new Map();
  for (let i = 0; i < uv.count; i += 3) {
    const rgb = sample(i), saturation = Math.max(...rgb) - Math.min(...rgb);
    // Area, not triangle count: tiny lamp faces must not win over body panels.
    const positions = geometry.attributes.position;
    const a = new T.Vector3().fromBufferAttribute(positions, i);
    const b = new T.Vector3().fromBufferAttribute(positions, i + 1).sub(a);
    const d = new T.Vector3().fromBufferAttribute(positions, i + 2).sub(a);
    const area = b.cross(d).length() / 2;
    if (saturation > 45 && Math.max(...rgb) > 90) { const k = rgb.join(','); counts.set(k, (counts.get(k) || 0) + area); }
  }
  const paint = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const hue = rgb => new T.Color().setRGB(...rgb.map(n => n / 255)).getHSL({}).h;
  const paintHue = paint ? hue(paint.split(',').map(Number)) : -1;
  geometry.clearGroups();
  for (let i = 0; i < uv.count; i += 3) {
    // Palette gradients have many shades of the same paint hue.
    const rgb = sample(i), difference = Math.abs(hue(rgb) - paintHue);
    const isPaint = paintHue >= 0 && Math.min(difference, 1 - difference) < 0.07 && Math.max(...rgb) - Math.min(...rgb) > 40;
    const darkGlass = Math.max(...rgb) < 170 && rgb[2] > rgb[0] + 12;
    geometry.addGroup(i, 3, isPaint ? 0 : darkGlass ? 1 : 2);
  }
  // Reorder triangle indices into three batches: paint, glass and original trim.
  const groups = geometry.groups.slice(), indices = []; geometry.clearGroups();
  for (let material = 0; material < 3; material++) {
    const start = indices.length;
    for (const g of groups) if (g.materialIndex === material) for (let i = g.start; i < g.start + g.count; i++) indices.push(i);
    if (indices.length > start) geometry.addGroup(start, indices.length - start, material);
  }
  geometry.setIndex(indices);
  const result = { geometry, painted: true }; bodyTemplates.set(key, result); return result;
}

export function createCar(assets, c) {
  const root = new T.Group(), name = modelName(c), model = assets.cloneModel(name); root.add(model);
  root.name = `car-${c.car_id}`; root.userData.carId = c.car_id;
  const baseColor = colors[c.kind][hash(c.car_id) % colors[c.kind].length];
  const paint = new T.MeshPhysicalMaterial({ color: baseColor, metalness: 0.45, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.12 });
  const glass = new T.MeshPhysicalMaterial({ color: 0x253c48, metalness: 0.15, roughness: 0.09, clearcoat: 1 });
  const wheels = [], meshes = []; model.traverse(o => { if (o.isMesh) meshes.push(o); });
  for (const mesh of meshes) {
    if (/^wheel-(front|back)-(left|right)$/.test(mesh.name)) {
      // Pivot about the axle, not the model origin. Works with the supplied GLBs.
      const pivot = new T.Group(); pivot.position.copy(mesh.position); pivot.quaternion.copy(mesh.quaternion); pivot.scale.copy(mesh.scale);
      mesh.parent.add(pivot); pivot.add(mesh); mesh.position.set(0, 0, 0); mesh.quaternion.identity(); mesh.scale.setScalar(1);
      wheels.push({ mesh, pivot, base: pivot.quaternion.clone(), front: mesh.name.includes('front') });
    } else if (mesh.material.name === 'paint') { mesh.material = paint;
    } else if (mesh.name === 'body' || mesh.name === 'spoiler') {
      const template = prepareBody(mesh, `${name}/${mesh.name}`); mesh.geometry = template.geometry;
      mesh.material = template.painted ? [paint, glass, mesh.material] : paint;
    } else if (mesh.name === 'glass') mesh.material = glass;
    mesh.castShadow = mesh.receiveShadow = true;
  }
  const bounds = new T.Box3().setFromObject(model), size = bounds.getSize(new T.Vector3());
  const headlights = new T.Group(), brakeLights = new T.Group(), cones = new T.Group(); root.add(headlights, brakeLights, cones);
  const headMaterial = new T.MeshStandardMaterial({ color: 0xffeac2, emissive: 0xffedcc, emissiveIntensity: 4 });
  const brakeMaterial = new T.MeshStandardMaterial({ color: 0x73150c, emissive: 0xff2510, emissiveIntensity: 0.1 });
  const coneMaterial = new T.MeshBasicMaterial({ color: 0xffedc8, transparent: true, opacity: 0.08, depthWrite: false, blending: T.AdditiveBlending });
  for (const x of [-size.x * 0.32, size.x * 0.32]) {
    const head = new T.Mesh(new T.BoxGeometry(0.18, 0.11, 0.04), headMaterial); head.position.set(x, size.y * 0.4, size.z / 2 + 0.025); headlights.add(head);
    const brake = head.clone(); brake.material = brakeMaterial; brake.position.z = -size.z / 2 - 0.025; brakeLights.add(brake);
    const cone = new T.Mesh(new T.ConeGeometry(0.9, 5, 12, 1, true), coneMaterial);
    cone.rotation.x = -Math.PI / 2; cone.position.set(x, 0.28, size.z / 2 + 2.5); cones.add(cone);
  }
  // At a distance, two simple shapes replace the detailed mesh.
  const lod = new T.LOD(); root.remove(model); lod.addLevel(model, 0);
  const simple = new T.Group();
  const body = new T.Mesh(new T.BoxGeometry(size.x, size.y * 0.45, size.z), paint);
  body.position.y = size.y * 0.32; simple.add(body);
  const cabin = new T.Mesh(new T.BoxGeometry(size.x * 0.8, size.y * 0.45, size.z * 0.52), glass);
  cabin.position.y = size.y * 0.7; simple.add(cabin);
  lod.addLevel(simple, 95); root.add(lod);
  root.userData.lod = lod;
  root.userData.animate = (pose, night) => {
    paint.color.setHex(pose.state === 'Turned away' ? 0xed3934 : baseColor);
    // Angle comes from distance, so pause/restart/seek never accumulate wheel drift.
    for (const w of wheels) {
      w.mesh.rotation.x = pose.distance / 0.24;
      w.pivot.quaternion.copy(w.base);
      if (w.front) w.pivot.rotateY(pose.steering || 0);
    }
    headlights.visible = cones.visible = night > 0.3 && pose.state !== 'Parked';
    brakeMaterial.emissiveIntensity = pose.braking || pose.state === 'Waiting' ? 3 : night > 0.3 ? 0.8 : 0.1;
  };
  return root;
}

export function updateCars(lot, time, night, assets) {
  // Paused scenes still render for orbit controls, but need no repeated traffic work.
  if (lot.lastMinute === time && lot.lastNight === night) return;
  lot.lastMinute = time; lot.lastNight = night;
  lot.cars.forEach(item => { item.pose = poseAt(item, time); });
  applyFollowing(lot.cars);
  let inLift = 0, outLift = 0;
  for (const item of lot.cars) {
    const p = item.pose;
    if (item.routeLine) item.routeLine.visible = p.visible && p.state === 'Searching';
    if (!p.visible) { if (item.mesh) item.mesh.visible = false; continue; }
    if (!item.mesh) {
      item.mesh = createCar(assets, item.data); lot.group.add(item.mesh);
      item.mesh.userData.selection = { type: 'car', lot, item };
    }
    item.mesh.visible = true; item.mesh.position.copy(p.position);
    item.mesh.rotation.set(-Math.asin(clamp(p.direction.y, -1, 1)), Math.atan2(p.direction.x, p.direction.z), 0, 'YXZ');
    item.mesh.userData.state = p.state; item.mesh.userData.animate(p, night);
    if (p.position.y < 1) {
      const lift = smooth((5 - Math.abs(p.position.z + 42)) / 2.5);
      if (Math.abs(p.position.x + 1.8) < 1.1) inLift = Math.max(inLift, lift);
      if (Math.abs(p.position.x - 1.8) < 1.1) outLift = Math.max(outLift, lift);
    }
  }
  lot.entrance.rotation.z = inLift * Math.PI / 2; lot.exit.rotation.z = outLift * Math.PI / 2;
}
