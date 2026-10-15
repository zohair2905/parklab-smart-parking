// Main replay controller. Simulation inputs and output files are read-only.
import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AssetManager } from './assets.js?v=parklab-20261016';
import { createWorld } from './scene.js?v=parklab-20261016';
import { createLot, updateSensors } from './lots.js?v=parklab-20261016';
import { updateCars, exitDuration, releaseTime } from './cars.js?v=parklab-20261016';
import { createCameraRig } from './camera.js?v=parklab-20261016';

export async function startReplay(log) {
  const $ = id => document.getElementById(id), stage = $('stage'), slider = $('timeline');
  const horizon = log.SIMULATION_MINUTES;
  let minute = 150, speed = 60, paused = true, mode = 'Both', selection = null;
  let endTime = horizon, lastFrame = performance.now(), lastDashboard = -Infinity;
  const finalTime = Math.ceil(Math.max(horizon, ...Object.values(log.modes).flatMap(m =>
    m.cars.map(c => releaseTime(c) + exitDuration(c)))));
  $('runLabel').textContent = `${log.LEGACY_MODE === false ? 'Part A · two levels' : 'Original run · open lot'} · Run ${log.EXPORT_RUN + 1} · seed ${log.seed}`;
  slider.max = horizon;
  const assets = await new AssetManager(progress => {
    $('assetProgress').value = progress.done; $('assetStatus').textContent = `${progress.done}/${progress.total} · ${progress.current}`;
  }).loadAll();
  $('assetLoading').hidden = true;
  $('assetNote').textContent = `${assets.loaded}/23 assets loaded · ${assets.failures.length} fallbacks`;
  $('assetNote').title = assets.failures.join('\n');
  const scene = new T.Scene(); scene.name = 'parking-replay';
  const renderer = new T.WebGLRenderer({ antialias: true }); stage.appendChild(renderer.domElement);
  const camera = new T.PerspectiveCamera(43, 1, 0.1, 500);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.minDistance = 4; controls.maxDistance = 260;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  const world = createWorld(scene, renderer, camera, assets);
  const lots = ['Normal', 'Smart'].map(name => createLot(scene, name, log, world));
  const rig = createCameraRig(camera, controls, () => ({ mode, selection }));
  const twoLevels = lots[0].twoLevels; $('cutawayLabel').hidden = !twoLevels;
  lots.forEach(lot => lot.setCutaway(true));

  // This marker highlights the selected bay/car without changing its material.
  const marker = new T.Mesh(new T.RingGeometry(1.4, 1.55, 32), new T.MeshBasicMaterial({ color: 0xffce73, side: T.DoubleSide }));
  marker.rotation.x = -Math.PI / 2; marker.visible = false; scene.add(marker);
  const raycaster = new T.Raycaster(), pointer = new T.Vector2(); let down;
  renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.set((e.clientX - bounds.left) / bounds.width * 2 - 1, -(e.clientY - bounds.top) / bounds.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    // Only visible cars and bay surfaces are selectable; a roof cannot hide the controls.
    const targets = lots.filter(l => l.group.visible).flatMap(l => [
      ...l.spotMeshes, ...l.sensors, ...l.cars.filter(i => i.mesh?.visible).map(i => i.mesh),
    ]);
    const hit = raycaster.intersectObjects(targets, true)[0]; let object = hit?.object;
    while (object && !object.userData.selection) object = object.parent;
    if (object) select(object.userData.selection);
  });
  function select(value) {
    selection = value; $('selectionPanel').hidden = !selection;
    $('follow').disabled = selection?.type !== 'car'; updateDetails();
  }
  function updateDetails() {
    marker.visible = false;
    if (!selection) return;
    const { lot } = selection; let rows;
    if (selection.type === 'car') {
      const { item } = selection, c = item.data;
      $('selectionTitle').textContent = `${lot.name} · Car ${c.car_id}`;
      rows = [['Kind / model', `${c.kind} / ${item.name}`], ['State', item.pose?.state ?? 'Not arrived'],
        ['Arrival', clock(c.arrival)], ['Assigned', c.assign_time == null ? '—' : clock(c.assign_time)],
        ['Bay / level', c.spot_index == null ? '—' : `${c.spot_index} / ${c.level ?? 1}`],
        ['Search', c.search_minutes == null ? '—' : `${c.search_minutes.toFixed(2)} min`],
        ['Parked at', c.park_start == null ? '—' : clock(c.park_start)],
        ['Release / give up', clock(releaseTime(c))], ['Hourly price', c.price_per_hour == null ? '—' : `${c.price_per_hour.toFixed(2)} CU`],
        ['Recorded fee', `${(c.fee ?? 0).toFixed(2)} CU`], ['Outcome', c.outcome.replaceAll('_', ' ')]];
      if (item.mesh?.visible && lot.group.visible) { item.mesh.getWorldPosition(marker.position); marker.visible = true; }
    } else {
      const { spot } = selection;
      const car = lot.data.cars.find(c => c.spot_index === spot.index && c.assign_time <= minute && minute < c.leave_time);
      $('selectionTitle').textContent = `${lot.name} · Bay ${spot.index}`;
      rows = [['Kind', spot.kind], ['Level', spot.level ?? 1], ['Recorded distance', `${spot.distance} m`],
        ['Sensor', car ? 'Red · claimed' : 'Green · free'], ['Assigned car', car?.car_id ?? '—']];
      marker.position.copy(lot.positions.get(spot.index)); lot.group.localToWorld(marker.position); marker.visible = lot.group.visible;
    }
    marker.position.y += 0.12;
    const details = $('details'); details.replaceChildren();
    for (const [label, value] of rows) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label; dd.textContent = value; details.append(dt, dd);
    }
    $('selectionHelp').textContent = selection.type === 'car' && !selection.item.mesh?.visible
      ? 'This car is outside the displayed time. Seek to its arrival to follow it.' : 'Click another car or parking bay to inspect it.';
  }
  document.addEventListener('parking-select-bay', e => { const lot=lots.find(l=>l.name===e.detail.mode); const spot=log.layout.find(s=>s.index===e.detail.index); if(lot&&spot){if(!lot.group.visible)setMode(lot.name);select({type:'spot',lot,spot});} });
  $('closeSelection').onclick = () => select(null);
  $('inspect').onclick = () => {
    const lot = lots.find(l => l.name === $('inspectMode').value);
    const item = lot.cars.find(i => i.data.car_id === Number($('carNumber').value));
    $('inspectMessage').textContent = item ? '' : 'No car has this ID in the selected log.';
    if (item) { if (!lot.group.visible) setMode(lot.name); select({ type: 'car', lot, item }); }
  };
  $('follow').onclick = () => { if (selection?.type === 'car') rig.preset('follow'); };

  // METRICS: these formulas retain the original dashboard accounting.
  function measurements(lot) {
    let parked = 0, occupied = 0, turned = 0, revenue = 0, searches = 0, searchSum = 0, priceBalks = 0;
    for (const c of lot.data.cars) {
      if (c.outcome === 'balked_price') { if (c.price_refusal_time <= minute) priceBalks++; continue; }
      if (c.outcome === 'turned_away') { if (c.give_up_time <= minute) turned++; continue; }
      if (c.assign_time <= minute) { searches++; searchSum += c.search_minutes; }
      if (c.assign_time <= minute && minute < c.leave_time) occupied++;
      if (c.park_start <= minute && minute < c.leave_time) parked++;
      if (c.leave_time <= minute) revenue += c.fee;
    }
    const occupancy = occupied / log.layout.length;
    const high = lot.name === 'Smart' && occupancy > log.HIGH_OCCUPANCY_THRESHOLD;
    const price = log.BASE_PRICE_PER_HOUR * (high ? log.HIGH_PRICE_MULTIPLIER : 1);
    return { parked, occupied, turned, revenue, searches, searchSum, occupancy, high, price, priceBalks };
  }
  function chart(lot) {
    const canvas = lot.panel.querySelector('canvas'), width = Math.max(250, canvas.clientWidth), height = 105;
    canvas.width = width * 2; canvas.height = height * 2;
    const ctx = canvas.getContext('2d'); ctx.scale(2, 2); ctx.font = '11px system-ui';
    const x = t => 32 + t / endTime * (width - 42), y = p => 80 - p * 0.65;
    ctx.strokeStyle = '#353530'; ctx.fillStyle = '#a7a7a1';
    for (const percent of [0, 100]) { ctx.fillText(`${percent}%`, 0, y(percent) + 3); ctx.beginPath(); ctx.moveTo(32, y(percent)); ctx.lineTo(width - 10, y(percent)); ctx.stroke(); }
    ctx.setLineDash([4, 4]); ctx.strokeStyle = '#72726b'; ctx.beginPath();
    ctx.moveTo(32, y(log.HIGH_OCCUPANCY_THRESHOLD * 100)); ctx.lineTo(width - 10, y(log.HIGH_OCCUPANCY_THRESHOLD * 100)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillText(`${log.HIGH_OCCUPANCY_THRESHOLD * 100}%`, width - 36, y(log.HIGH_OCCUPANCY_THRESHOLD * 100) - 4);
    ctx.strokeStyle = lot.name === 'Normal' ? '#a7a7a1' : '#ff2a2a'; ctx.lineWidth = 2; ctx.beginPath();
    lot.data.samples.filter(s => s.minute <= minute).forEach((s, i) => { if (i === 0) ctx.moveTo(x(s.minute), y(s.percent)); else ctx.lineTo(x(s.minute), y(s.percent)); }); ctx.stroke();
    ctx.fillStyle = '#a7a7a1'; ctx.fillText(clock(0).slice(0, 5), 32, 100); ctx.fillText(clock(endTime).slice(0, 5), width - 42, 100);
    ctx.strokeStyle = '#eaeaea'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x(minute), 12); ctx.lineTo(x(minute), 82); ctx.stroke();
  }
  function dashboard() {
    for (const lot of lots.filter(l => l.group.visible)) {
      const m = measurements(lot), values = [m.parked, `${(m.occupancy * 100).toFixed(0)}%`, m.turned,
        `${m.price.toFixed(0)} CU`, `${m.revenue.toFixed(2)} CU`, m.searches ? `${(m.searchSum / m.searches).toFixed(2)} min` : '—'];
      lot.panel.querySelectorAll('b').forEach((b, i) => { b.textContent = values[i]; });
      lot.panel.querySelector('.badge').hidden = !m.high;
      lot.panel.querySelector('.extra').hidden = log.LEGACY_MODE !== false;
      lot.panel.querySelector('.extra').textContent = `${m.priceBalks} additional drivers declined the price`; chart(lot);
    }
    document.dispatchEvent(new CustomEvent('parking-frame', { detail: { minute, mode } }));
    $('clock').textContent = clock(minute); slider.value = minute;
    slider.setAttribute('aria-valuetext', clock(minute));
    $('status').textContent = minute >= horizon ? 'Admissions closed · existing visits finish' : paused ? 'Paused · choose Play or drag the timeline' : 'Playing recorded events';
  }
  function clock(t) {
    const seconds = Math.floor((log.START_HOUR * 60 + t) * 60 + 0.00001);
    return [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  }


  function setMode(value) {
    mode = value;
    lots.forEach((lot, i) => {
      lot.group.visible = mode === 'Both' || mode === lot.name;
      lot.group.position.x = mode === 'Both' ? (i === 0 ? (twoLevels ? 29 : 19) : (twoLevels ? -29 : -19)) : 0;
      lot.panel.hidden = !lot.group.visible;
    });
    $('dashboards').classList.toggle('single', mode !== 'Both');
    $('modes').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === mode));
    rig.preset(rig.view); refresh();
  }
  function refresh() {
    lots.filter(l => l.group.visible).forEach(lot => {
      updateCars(lot, minute, world.lighting.night, assets); updateSensors(lot, minute, log.layout);
    });
    dashboard(); updateDetails();
  }
  function setPaused(value) { paused = value; $('pause').textContent = paused ? 'Play' : 'Pause'; dashboard(); }
  $('quality').onchange = () => world.lighting.setQuality($('quality').value);
  $('lighting').onclick = e => {
    if (!e.target.dataset.light) return; world.lighting.setPreset(e.target.dataset.light);
    $('lighting').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === e.target));
  };
  $('modes').onclick = e => { if (e.target.dataset.mode) setMode(e.target.dataset.mode); };
  $('views').onclick = e => { if (e.target.dataset.view && !e.target.disabled) rig.preset(e.target.dataset.view); };
  $('speeds').onclick = e => {
    if (!e.target.dataset.speed) return; speed = Number(e.target.dataset.speed);
    $('speeds').querySelectorAll('[data-speed]').forEach(b => b.setAttribute('aria-pressed', Number(b.dataset.speed) === speed));
  };
  $('pause').onclick = () => { if (minute >= endTime) minute = 0; setPaused(!paused); refresh(); };
  $('restart').onclick = () => { minute = 0; setPaused(true); refresh(); };
  slider.oninput = () => { minute = Number(slider.value); setPaused(true); refresh(); };
  $('afterHours').onchange = () => {
    endTime = $('afterHours').checked ? finalTime : horizon; slider.max = endTime;
    minute = Math.min(minute, endTime); $('endLabel').textContent = clock(endTime).slice(0, 5); refresh();
  };
  $('cutaway').onchange = () => lots.forEach(lot => lot.setCutaway($('cutaway').checked));
  function photo(value) { document.body.classList.toggle('photo', value); $('photo').setAttribute('aria-pressed', value); }
  $('photo').onclick = () => photo(!document.body.classList.contains('photo'));
  $('exitPhoto').onclick = () => photo(false);
  function screenshot() {
    // Render immediately before capture; no permanently preserved GPU buffer needed.
    const visible = marker.visible; marker.visible = false; world.lighting.render();
    renderer.domElement.toBlob(blob => {
      if (!blob) { $('inspectMessage').textContent = 'Screenshot failed. Try Low quality.'; return; }
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `parking-${mode.toLowerCase()}-${clock(minute).replaceAll(':', '-')}.png`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png'); marker.visible = visible;
  }
  $('screenshot').onclick = screenshot;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') photo(false);
    if (e.key.toLowerCase() === 's' && document.body.classList.contains('photo')) screenshot();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); lastFrame = performance.now(); });
  new ResizeObserver(() => {
    const w = stage.clientWidth, h = stage.clientHeight; world.lighting.resize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix(); dashboard();
  }).observe(stage);
  setMode('Smart'); world.lighting.setPreset('night'); $('endLabel').textContent = clock(horizon).slice(0, 5);
  function frame(now) {
    const seconds = Math.min((now - lastFrame) / 1000, 0.25); lastFrame = now;
    if (!paused) { minute = Math.min(endTime, minute + seconds * speed / 60); if (minute >= endTime) setPaused(true); }
    world.lighting.update(seconds);
    lots.filter(l => l.group.visible).forEach(lot => {
      updateCars(lot, minute, world.lighting.night, assets); updateSensors(lot, minute, log.layout);
    });
    rig.update(seconds);
    if (now - lastDashboard > 150) { dashboard(); updateDetails(); lastDashboard = now; }
    world.lighting.render(); requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
