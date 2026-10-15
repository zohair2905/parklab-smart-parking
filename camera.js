import * as T from 'three';

export function createCameraRig(camera, controls, getState) {
  let view = 'overview', phase = 0;
  const fly = new T.CatmullRomCurve3([
    new T.Vector3(65, 35, -80), new T.Vector3(-65, 26, -55),
    new T.Vector3(-65, 45, 55), new T.Vector3(65, 40, 65),
  ], true, 'centripetal');
  function preset(value) {
    view = value;
    const { mode } = getState(), wide = mode === 'Both';
    controls.target.set(0, 2, -4);
    if (value === 'top') camera.position.set(0, wide ? 155 : 125, -4.1);
    if (value === 'entrance') camera.position.set(wide ? 12 : 6, 20, -85);
    if (value === 'overview' || value === 'free') camera.position.set(wide ? 78 : 30, wide ? 78 : 49, wide ? -105 : -70);
    controls.update(); markButtons();
  }
  function markButtons() {
    document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === view));
  }
  // Manual orbit immediately takes over from the automatic camera.
  controls.addEventListener('start', () => { view = 'free'; markButtons(); });
  function update(seconds) {
    if (view === 'cinematic') {
      phase = (phase + seconds / 70) % 1;
      camera.position.copy(fly.getPointAt(phase)); controls.target.set(0, 2, -4);
    } else if (view === 'follow') {
      const selection = getState().selection;
      if (selection?.type === 'car' && selection.lot.group.visible && selection.item.mesh?.visible) {
        const mesh = selection.item.mesh, target = mesh.getWorldPosition(new T.Vector3());
        const direction = selection.item.pose.direction.clone(); direction.y = 0; direction.normalize();
        const eye = target.clone().addScaledVector(direction, -8).add(new T.Vector3(0, 4, 0));
        camera.position.lerp(eye, 1 - Math.exp(-seconds * 6));
        controls.target.lerp(target.clone().add(new T.Vector3(0, 0.6, 0)), 1 - Math.exp(-seconds * 8));
      }
    }
    controls.update();
  }
  return { preset, update, get view() { return view; } };
}
