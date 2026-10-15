// Real-time lighting and post-processing only. These settings never alter log time.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const PRESETS = {
  day: { sky: 'day', brightness: 0.85, tint: 0xffffff, sun: 2.6, sunColor: 0xfff2db,
    position: [-42, 75, -35], ambient: 0.5, night: 0, exposure: 0.9 },
  sunset: { sky: 'sunset', brightness: 0.65, tint: 0xffddbc, sun: 1.7, sunColor: 0xffb477,
    position: [-70, 18, -15], ambient: 0.3, night: 0.3, exposure: 0.95 },
  night: { sky: 'sunset', brightness: 0.13, tint: 0xa4abb4, sun: 0.65, sunColor: 0xadcaff,
    position: [30, 65, 20], ambient: 0.65, night: 1, exposure: 1.35 },
};

export function createLighting(scene, renderer, camera, assets) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene.background = null;
  const sun = new THREE.DirectionalLight(0xfff2db, 2.6);
  sun.position.set(-42, 75, -35); sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -85, right: 85, top: 85, bottom: -85, near: 1, far: 240 });
  sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.035;
  scene.add(sun);
  const ambient = new THREE.HemisphereLight(0xcadfee, 0x777260, 0.5); scene.add(ambient);

  // Blend two equirectangular HDR textures on the sky dome. This avoids abrupt
  // background swaps. A separate dome lets PMREM sample the very same blended sky.
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, uniforms: {
      skyA: { value: assets.hdris.get('day') }, skyB: { value: assets.hdris.get('day') },
      blend: { value: 1 }, brightness: { value: 0.85 }, tint: { value: new THREE.Color(0xffffff) },
    },
    vertexShader: 'varying vec3 direction; void main(){direction=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `uniform sampler2D skyA; uniform sampler2D skyB; uniform float blend;
      uniform float brightness; uniform vec3 tint; varying vec3 direction;
      void main(){vec3 d=normalize(direction); vec2 uv=vec2(atan(d.z,d.x)*0.15915494+0.5,asin(clamp(d.y,-1.0,1.0))*0.31830989+0.5);
      vec3 sky=mix(texture2D(skyA,uv).rgb,texture2D(skyB,uv).rgb,blend);
      gl_FragColor=vec4(sky*tint*brightness,1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(350, 32, 16), skyMaterial);
  sky.frustumCulled = false; sky.renderOrder = -10; scene.add(sky);
  const probeScene = new THREE.Scene();
  probeScene.add(new THREE.Mesh(sky.geometry, skyMaterial));
  const pmrem = new THREE.PMREMGenerator(renderer);
  let environment = null;
  function refreshEnvironment() {
    const next = pmrem.fromScene(probeScene, 0.04, 0.1, 500);
    scene.environment = next.texture;
    if (environment) environment.dispose();
    environment = next;
  }
  refreshEnvironment();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const ao = new SSAOPass(scene, camera, 1, 1);
  ao.kernelRadius = 7; ao.minDistance = 0.005; ao.maxDistance = 0.12;
  composer.addPass(ao);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.16, 0.35, 1.15);
  composer.addPass(bloom);
  const vignette = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, strength: { value: 0.12 } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'uniform sampler2D tDiffuse;uniform float strength;varying vec2 vUv;void main(){vec4 c=texture2D(tDiffuse,vUv);float edge=smoothstep(0.15,0.7,length(vUv-0.5));gl_FragColor=vec4(c.rgb*(1.0-strength*edge),c.a);}',
  });
  composer.addPass(vignette);
  // OutputPass performs tone mapping and sRGB conversion ONCE, after all effects.
  composer.addPass(new OutputPass());

  let quality = 'medium', presetName = 'day', transition = 1, probeTimer = 0;
  let from = PRESETS.day, target = PRESETS.day;
  let lastNight = 0;
  const wetMaterials = [], lamps = [];
  function resize(width, height) {
    const ratio = { low: 1, medium: 1.25, high: 1.75 }[quality];
    renderer.setPixelRatio(Math.min(devicePixelRatio, ratio));
    renderer.setSize(width, height, false);
    composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(width, height);
  }
  function setQuality(value) {
    if (!['low', 'medium', 'high'].includes(value)) return;
    quality = value; ao.enabled = value === 'high';
    const size = { low: 512, medium: 1024, high: 2048 }[value];
    sun.shadow.mapSize.set(size, size);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    const canvas = renderer.domElement;
    resize(canvas.clientWidth || 800, canvas.clientHeight || 500);
  }
  function setPreset(value) {
    if (!PRESETS[value] || presetName === value) return;
    from = { brightness: skyMaterial.uniforms.brightness.value,
      tint: skyMaterial.uniforms.tint.value.clone(), sun: sun.intensity,
      sunColor: sun.color.clone(), position: sun.position.clone(), ambient: ambient.intensity,
      night: lastNight, exposure: renderer.toneMappingExposure };
    const uniforms = skyMaterial.uniforms;
    uniforms.skyA.value = uniforms.blend.value < 0.5 ? uniforms.skyA.value : uniforms.skyB.value;
    uniforms.skyB.value = assets.hdris.get(PRESETS[value].sky);
    target = PRESETS[value]; presetName = value; transition = 0; probeTimer = 1;
  }
  function update(seconds) {
    sky.position.copy(camera.position);
    if (transition < 1) {
      transition = Math.min(1, transition + seconds / 1.4);
      const t = transition * transition * (3 - 2 * transition), u = skyMaterial.uniforms;
      u.blend.value = t;
      u.brightness.value = THREE.MathUtils.lerp(from.brightness, target.brightness, t);
      u.tint.value.copy(new THREE.Color(from.tint)).lerp(new THREE.Color(target.tint), t);
      sun.intensity = THREE.MathUtils.lerp(from.sun, target.sun, t);
      sun.color.copy(new THREE.Color(from.sunColor)).lerp(new THREE.Color(target.sunColor), t);
      sun.position.copy(from.position.isVector3 ? from.position : new THREE.Vector3(...from.position)).lerp(new THREE.Vector3(...target.position), t);
      ambient.intensity = THREE.MathUtils.lerp(from.ambient, target.ambient, t);
      renderer.toneMappingExposure = THREE.MathUtils.lerp(from.exposure, target.exposure, t);
      lastNight = THREE.MathUtils.lerp(from.night, target.night, t);
      // Wet-looking asphalt uses the HDR reflection; this is not ray tracing.
      wetMaterials.forEach(mat => { mat.roughness = 0.92 - lastNight * 0.48; mat.clearcoat = lastNight * 0.7; mat.clearcoatRoughness = 0.18; });
      lamps.forEach(lamp => { lamp.material.emissiveIntensity = 0.1 + lastNight * 4; });
      probeTimer += seconds;
      // Refresh only while changing lighting, rather than capturing a cube every frame.
      if (probeTimer > 0.24 || transition === 1) { refreshEnvironment(); probeTimer = 0; }
    }
  }
  function render() { if (quality === 'low') renderer.render(scene, camera); else composer.render(); }
  setQuality('medium'); renderer.toneMappingExposure = PRESETS.day.exposure;
  return { sun, ambient, resize, render, update, setPreset, setQuality,
    get night() { return lastNight; },
    registerWet: material => wetMaterials.push(material),
    registerLamp: mesh => lamps.push(mesh) };
}
