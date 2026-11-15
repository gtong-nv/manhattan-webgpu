import * as THREE from 'three/webgpu';
import { uniform, mix, vec4 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pixelationPass } from 'three/addons/tsl/display/PixelationPassNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { createMaterials } from './materials.js';
import { TileManager } from './tiles.js';
import './style.css';

const $ = id => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const state = { ready: false, selected: null, hour: 14, daylight: 1, pixels: false, cameraTween: null, place: 'midtown' };
const destinations = {
  midtown: { name: 'Midtown', lon: -73.9845, lat: 40.7540, zoom: 1.1 },
  downtown: { name: 'Lower Manhattan', lon: -74.0100, lat: 40.7087, zoom: 1.05 },
  village: { name: 'Greenwich Village', lon: -73.9993, lat: 40.7323, zoom: 1.3 },
  park: { name: 'Central Park', lon: -73.9718, lat: 40.7782, zoom: 0.62 },
  harlem: { name: 'Harlem', lon: -73.9442, lat: 40.8110, zoom: 1.15 },
  inwood: { name: 'Inwood', lon: -73.9238, lat: 40.8675, zoom: 0.85 },
  overview: { name: 'All Manhattan', lon: -73.975, lat: 40.782, zoom: 0.063 },
};
let scene, camera, renderer, controls, materials, tiles, manifest, sun, ambient, pipeline, cityPass, ambientOcclusion, highlight;
let backend = '', fps = 0, frameCount = 0, lastMetric = performance.now();
const aoStrength = uniform(0.20);
const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const timer = new THREE.Timer();
timer.connect(document);
const sunOffset = new THREE.Vector3();
const tempTarget = new THREE.Vector3();
let minimapTransform;
let previousPending = -1;

function geographicPoint(lon, lat) {
  const [lon0, lat0] = manifest.meta.center;
  return new THREE.Vector3((lon - lon0) * 111320 * Math.cos(lat0 * Math.PI / 180), 25, -(lat - lat0) * 111132);
}

function resize() {
  if (!renderer) return;
  const aspect = innerWidth / innerHeight;
  const span = aspect < 0.8 ? 1100 / Math.sqrt(aspect) : 1100;
  camera.left = -span * aspect / 2; camera.right = span * aspect / 2;
  camera.top = span / 2; camera.bottom = -span / 2;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  if (cityPass) cityPass.pixelSize = state.pixels ? 2 : 1;
  if (tiles) tiles.select(camera, controls.target, innerHeight, performance.now(), true);
}

function cameraDestination({ target, zoom, theta, instant = false }) {
  const startTarget = controls.target.clone();
  const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(startTarget));
  state.cameraTween = {
    started: performance.now(), duration: instant || reducedMotion ? 1 : 850,
    start: spherical, end: new THREE.Spherical(spherical.radius, spherical.phi, theta ?? spherical.theta),
    startTarget, targetEnd: target?.clone() ?? startTarget.clone(), startZoom: camera.zoom, endZoom: zoom ?? camera.zoom,
  };
}

function goTo(name, instant = false) {
  const place = destinations[name];
  if (!place) return;
  state.place = name; $('neighborhood').value = name; $('map-location').textContent = place.name.toUpperCase();
  selectBuilding(null);
  cameraDestination({ target: geographicPoint(place.lon, place.lat), zoom: place.zoom, theta: name === 'overview' ? Math.PI / 12 : Math.PI / 4, instant });
}

function animateCamera(now) {
  const tween = state.cameraTween;
  if (!tween) return;
  const t = Math.min(1, (now - tween.started) / tween.duration), k = 1 - (1 - t) ** 3;
  const spherical = new THREE.Spherical(tween.start.radius, THREE.MathUtils.lerp(tween.start.phi, tween.end.phi, k), THREE.MathUtils.lerp(tween.start.theta, tween.end.theta, k));
  controls.target.lerpVectors(tween.startTarget, tween.targetEnd, k);
  camera.position.setFromSpherical(spherical).add(controls.target);
  camera.zoom = THREE.MathUtils.lerp(tween.startZoom, tween.endZoom, k);
  camera.updateProjectionMatrix();
  if (t === 1) { state.cameraTween = null; tiles.select(camera, controls.target, innerHeight, now, true); }
}

function setHour(value) {
  state.hour = Number(value);
  $('time-label').textContent = `${String(Math.floor(state.hour)).padStart(2, '0')}:${String(Math.round((state.hour % 1) * 60)).padStart(2, '0')}`;
  const daylight = THREE.MathUtils.smoothstep(Math.sin((state.hour - 6) / 14 * Math.PI), 0, 0.65);
  const golden = Math.min(1, Math.abs(state.hour - 13) / 6);
  sunOffset.set(-1800 + (state.hour - 14) * 230, 1300 + daylight * 1300, 1100);
  sun.color.set('#fff0d4').lerp(new THREE.Color('#ffb173'), golden * 0.38);
  sun.intensity = 0.18 + daylight * 2.65;
  ambient.intensity = 0.3 + daylight * 1.9;
  ambient.color.set('#bbcbd4').lerp(new THREE.Color('#6b82a8'), 1 - daylight);
  state.daylight = daylight;
  materials.update(timer.getElapsed(), daylight);
}

function followSun() {
  sun.position.copy(controls.target).add(sunOffset);
  sun.target.position.copy(controls.target);
  sun.target.updateMatrixWorld();
  // Shadow resolution is spent on the neighborhood being inspected. At island
  // scale there are no useful subpixel shadow details to spend a GPU pass on.
  sun.castShadow = camera.zoom > 0.22;
}

function overviewSurface() {
  const build = (features, material, elevation) => {
    const geometries = [];
    for (const feature of features) {
      if (!feature.rings?.[0]?.length) continue;
      const rings = feature.rings.map(ring => ring.map(([x, y]) => new THREE.Vector2(x, y)));
      const shape = new THREE.Shape(rings[0]);
      for (const ring of rings.slice(1)) shape.holes.push(new THREE.Path(ring));
      const geometry = new THREE.ShapeGeometry(shape);
      const position = geometry.attributes.position, uv = geometry.attributes.uv;
      for (let i = 0; i < position.count; i++) { const x = position.getX(i), y = position.getY(i); position.setXYZ(i, x, elevation, -y); uv.setXY(i, x, y); }
      geometry.computeVertexNormals();
      geometries.push(geometry);
    }
    if (!geometries.length) return;
    const combined = mergeGeometries(geometries);
    geometries.forEach(geometry => geometry.dispose());
    const mesh = new THREE.Mesh(combined, material); mesh.receiveShadow = true; mesh.name = 'Persistent shoreline'; scene.add(mesh);
  };
  const water = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000, 1, 1), materials.water);
  water.rotation.x = -Math.PI / 2; water.position.y = -0.6; water.name = 'Harbor and rivers';
  water.receiveShadow = true; scene.add(water);
  build(manifest.overview.land.filter(area => area.kind === 'land'), materials.earth, 0.7);
  build(manifest.overview.land.filter(area => area.kind !== 'land'), materials.grass, 0.72);
  const context = new THREE.MeshStandardNodeMaterial({ color: '#707d73', roughness: 1 });
  build(manifest.overview.contextLand ?? [], context, -0.1);
}

function detailRow(label, value) {
  const row = document.createElement('div'); row.className = 'detail-row';
  const key = document.createElement('span'); key.textContent = label;
  const item = document.createElement('strong'); item.textContent = value;
  row.append(key, item); return row;
}
function selectBuilding(mesh) {
  if (highlight) { scene.remove(highlight); highlight.geometry.dispose(); highlight.material.dispose(); highlight = null; }
  state.selected = mesh?.userData.building ?? null;
  $('inspector').hidden = !state.selected;
  if (!mesh) return;
  const building = state.selected;
  $('inspect-title').textContent = building.name || building.address || (building.bin ? `Building ${building.bin}` : 'Manhattan building');
  $('building-details').replaceChildren(
    detailRow('Roof height', `${Number(building.height).toFixed(1)} m`),
    detailRow('Height source', building.heightEstimated || /estimat/i.test(building.heightSource ?? '') ? 'Estimated' : 'NYC building data'),
    detailRow('Building ID', building.id),
  );
  if (building.year) $('building-details').append(detailRow('Year in source', building.year));
  highlight = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 35), new THREE.LineBasicNodeMaterial({ color: '#f0ca75', depthTest: true, transparent: true, opacity: 0.85 }));
  mesh.updateWorldMatrix(true, false); highlight.applyMatrix4(mesh.matrixWorld); scene.add(highlight);
}
function pick(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(tiles.buildingMeshes, false)[0]?.object;
}
function setSettings(open) { $('settings').hidden = !open; $('settings-toggle').setAttribute('aria-expanded', String(open)); }
function setupInteractions() {
  let down;
  renderer.domElement.addEventListener('pointerdown', event => { down = { x: event.clientX, y: event.clientY, button: event.button }; state.cameraTween = null; });
  renderer.domElement.addEventListener('pointerup', event => {
    if (down?.button === 0 && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5) selectBuilding(pick(event));
    down = null;
  });
  renderer.domElement.addEventListener('dblclick', event => {
    const mesh = pick(event); if (!mesh) return;
    const center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3()); center.y = 25;
    cameraDestination({ target: center, zoom: Math.min(4.5, controls.maxZoom) });
  });
  $('neighborhood').onchange = event => goTo(event.target.value);
  $('home-link').onclick = event => { event.preventDefault(); goTo('midtown'); };
  $('overview-view').onclick = () => goTo('overview');
  $('clear-selection').onclick = () => selectBuilding(null);
  $('zoom-in').onclick = () => cameraDestination({ zoom: Math.min(controls.maxZoom, camera.zoom * 1.45) });
  $('zoom-out').onclick = () => cameraDestination({ zoom: Math.max(controls.minZoom, camera.zoom / 1.45) });
  $('rotate-left').onclick = () => cameraDestination({ theta: controls.getAzimuthalAngle() - Math.PI / 2 });
  $('rotate-right').onclick = () => cameraDestination({ theta: controls.getAzimuthalAngle() + Math.PI / 2 });
  $('reset-view').onclick = () => goTo('midtown');
  $('sunlight').oninput = event => setHour(event.target.value);
  $('traffic').onchange = event => tiles.setTraffic(event.target.checked);
  $('greenery').onchange = event => tiles.setTrees(event.target.checked);
  $('pixels').onchange = event => { state.pixels = event.target.checked; cityPass.pixelSize = state.pixels ? 2 : 1; };
  $('occlusion').onchange = event => { aoStrength.value = event.target.checked ? 0.20 : 0; };
  $('settings-toggle').onclick = () => setSettings($('settings').hidden);
  $('settings-close').onclick = () => { setSettings(false); $('settings-toggle').focus(); };
  $('about-toggle').onclick = () => $('about-dialog').showModal();
  $('about-close').onclick = () => $('about-dialog').close();
  $('minimap').onclick = event => {
    if (!minimapTransform) return;
    const rect = event.currentTarget.getBoundingClientRect(), { scale, midX, midY } = minimapTransform;
    const x = (event.clientX - rect.left) / rect.width * 360, y = (event.clientY - rect.top) / rect.height * 440;
    cameraDestination({ target: new THREE.Vector3((x - 180) / scale + midX, 25, -((220 - y) / scale + midY)), zoom: 1.05 });
    $('map-location').textContent = 'EXPLORING';
  };
  $('minimap').onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); goTo('overview'); } };
  window.addEventListener('keydown', event => {
    if ($('about-dialog').open) return;
    if (event.key === 'Escape') { selectBuilding(null); setSettings(false); return; }
    if (event.target.matches('input,button,select')) return;
    if (event.target === renderer.domElement && ['[', ']'].includes(event.key)) {
      event.preventDefault(); const meshes = tiles.buildingMeshes;
      const current = meshes.findIndex(mesh => mesh.userData.building.id === state.selected?.id);
      const next = (current + (event.key === ']' ? 1 : -1) + meshes.length) % meshes.length;
      if (meshes[next]) selectBuilding(meshes[next]);
      return;
    }
    const action = { q: 'rotate-left', e: 'rotate-right', r: 'reset-view', '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out' }[event.key.toLowerCase()];
    if (action) { event.preventDefault(); $(action).click(); }
  });
  window.addEventListener('resize', resize);
}

function drawMinimap() {
  const ctx = $('minimap').getContext('2d');
  const [x0, y0, x1, y1] = manifest.meta.localBounds;
  const scale = Math.min(320 / (x1 - x0), 408 / (y1 - y0)), midX = (x0 + x1) / 2, midY = (y0 + y1) / 2;
  minimapTransform = { scale, midX, midY };
  const point = ([x, y]) => [180 + (x - midX) * scale, 220 - (y - midY) * scale];
  ctx.fillStyle = '#243c49'; ctx.fillRect(0, 0, 360, 440);
  const fill = (feature, color) => {
    ctx.beginPath();
    for (const ring of feature.rings) { ring.forEach((p, i) => { const [x, y] = point(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); }
    ctx.fillStyle = color; ctx.fill('evenodd');
  };
  for (const area of manifest.overview.contextLand ?? []) fill(area, '#3b4c50');
  for (const area of manifest.overview.land) fill(area, area.kind === 'land' ? '#9b9d86' : '#627b50');
  // A projected ground footprint, rather than a fixed square, follows orbit/zoom.
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), ray = new THREE.Raycaster();
  const corners = [];
  for (const [x, y] of [[-1,-1],[1,-1],[1,1],[-1,1]]) {
    ray.setFromCamera(new THREE.Vector2(x, y), camera);
    const hit = ray.ray.intersectPlane(ground, new THREE.Vector3());
    if (hit) corners.push(point([hit.x, -hit.z]));
  }
  ctx.beginPath(); corners.forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y)); ctx.closePath();
  ctx.fillStyle = '#f3d79a18'; ctx.fill(); ctx.strokeStyle = '#e6d29a'; ctx.lineWidth = 2; ctx.stroke();
  const [x, y] = point([controls.target.x, -controls.target.z]);
  ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fillStyle = '#fff1b8'; ctx.fill();
}
function fillSources() {
  $('building-count').textContent = manifest.meta.counts.buildings.toLocaleString();
  $('tree-count').textContent = manifest.meta.counts.trees.toLocaleString();
  for (const source of manifest.meta.sources) {
    const li = document.createElement('li'), a = document.createElement('a');
    a.textContent = source.name; a.href = source.url; a.target = '_blank'; a.rel = 'noreferrer'; li.append(a); $('source-list').append(li);
  }
  $('data-notes').textContent = `Snapshot: ${manifest.meta.generatedAt.slice(0, 10)}. ${manifest.meta.counts.estimatedHeights} buildings have marked estimated heights. Different sources have different survey dates. Streets are not live traffic data.`;
}
function render(now) {
  try {
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.05), elapsed = timer.getElapsed();
    animateCamera(now); controls.update();
    tempTarget.copy(controls.target);
    const [x0,y0,x1,y1] = manifest.meta.localBounds;
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, x0 - 700, x1 + 700);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, -y1 - 700, -y0 + 700);
    controls.target.y = 25;
    camera.position.add(tempTarget.sub(controls.target).negate());
    tiles.select(camera, controls.target, innerHeight, now);
    tiles.tick(reducedMotion ? 0 : dt, reducedMotion ? 0 : elapsed, now);
    materials.update(reducedMotion ? 0 : elapsed, state.daylight, (camera.zoom - 0.15) / 0.65);
    followSun();
    renderer.info.reset();
    pipeline.render();
    const tileStatus = tiles.stats;
    if (tileStatus.pending !== previousPending) {
      previousPending = tileStatus.pending;
      $('stream-status').hidden = !tileStatus.pending && !tileStatus.errors.length;
      $('stream-status').textContent = tileStatus.errors.length ? `${tileStatus.errors.length} tile requests failed; retrying…` : `Loading neighborhood detail · ${tileStatus.pending} tiles`;
    }
    if (!state.ready && tiles.stats.visible > 0) {
      state.ready = true; $('loading').classList.add('done'); setTimeout(() => { $('loading').hidden = true; }, 550);
    }
    frameCount++;
    if (now - lastMetric > 1000) {
      fps = Math.round(frameCount * 1000 / (now - lastMetric)); frameCount = 0; lastMetric = now;
      const stats = tiles.stats;
      $('render-status').textContent = `${backend} · ${stats.visible} TILES · ${stats.buildings.toLocaleString()} IN VIEW`;
      $('stream-status').hidden = !stats.pending && !stats.errors.length;
      $('stream-status').textContent = stats.errors.length ? `${stats.errors.length} tile requests failed; retrying…` : `Loading neighborhood detail · ${stats.pending} tiles`;
      $('loading-detail').textContent = `Streaming Manhattan · ${stats.pending} tiles pending…`;
      $('technical-stats').textContent = `${backend} · ${stats.visible} visible / ${stats.cached} cached tiles · LOD 0/1/2: ${stats.levels.join(' / ')} · ${stats.receivedMB.toFixed(1)} MB received · ${stats.evictions} tiles released · ${renderer.info.render.drawCalls} draw calls · ${fps} fps on this device`;
      drawMinimap();
      const origin = controls.target.clone().project(camera), north = controls.target.clone().add(new THREE.Vector3(0, 0, -100)).project(camera);
      $('compass-needle').style.transform = `rotate(${Math.atan2(north.x - origin.x, north.y - origin.y)}rad)`;
    }
  } catch (error) { fail(error); renderer.setAnimationLoop(null); }
}
function fail(error) {
  console.error(error);
  $('loading').hidden = true; $('error').hidden = false;
  $('error-detail').textContent = `${error.message} Use a current browser with GPU acceleration enabled.`;
}
async function init() {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}data/manhattan/manifest.json`);
    if (!response.ok) throw new Error(`Manhattan manifest could not load (${response.status}).`);
    manifest = await response.json();
    scene = new THREE.Scene(); scene.background = new THREE.Color('#4b6976');
    camera = new THREE.OrthographicCamera(-1000,1000,700,-700,1,90000);
    const target = geographicPoint(destinations.midtown.lon, destinations.midtown.lat);
    camera.position.setFromSpherical(new THREE.Spherical(38000, Math.acos(1 / Math.sqrt(3)), Math.PI / 4)).add(target);
    camera.zoom = destinations.midtown.zoom;
    renderer = new THREE.WebGPURenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.05;
    // Single-sample shadows keep a clean cel edge instead of a noisy penumbra.
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.BasicShadowMap;
    renderer.info.autoReset = false;
    $('loading-detail').textContent = 'Initializing WebGPU and architectural materials…';
    await renderer.init();
    backend = renderer.backend.isWebGPUBackend ? 'WEBGPU' : 'WEBGL2 FALLBACK';
    $('backend-badge').textContent = backend;
    if (!renderer.backend.isWebGPUBackend) {
      $('backend-notice').hidden = false;
      $('backend-notice').textContent = 'WebGPU is unavailable in this browser. Using WebGL2 compatibility mode. A current GPU-enabled browser over HTTPS enables WebGPU.';
      setTimeout(() => { $('backend-notice').hidden = true; }, 14000);
    }
    renderer.domElement.setAttribute('aria-label', 'Interactive Manhattan. Drag to pan, right-drag to orbit, scroll to zoom, click buildings to inspect. Q and E rotate, plus and minus zoom, R resets, brackets select buildings, Escape clears selection.');
    renderer.domElement.tabIndex = 0; $('viewport').append(renderer.domElement);
    controls = new OrbitControls(camera, renderer.domElement); controls.target.copy(target);
    controls.enableDamping = true; controls.dampingFactor = 0.11;
    controls.minPolarAngle = 0.35; controls.maxPolarAngle = Math.PI / 2.4;
    controls.minZoom = 0.045; controls.maxZoom = 6; controls.zoomSpeed = 0.8; controls.rotateSpeed = 0.5;
    controls.screenSpacePanning = false;
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    controls.listenToKeyEvents(renderer.domElement); controls.update();
    ambient = new THREE.HemisphereLight('#bbcbd4','#888179',2.2); scene.add(ambient);
    sun = new THREE.DirectionalLight('#fff0d4',2.7); sun.castShadow = true;
    sun.shadow.mapSize.set(4096,4096); sun.shadow.camera.left = -1750; sun.shadow.camera.right = 1750;
    sun.shadow.camera.top = 1750; sun.shadow.camera.bottom = -1750; sun.shadow.camera.near = 100; sun.shadow.camera.far = 7000;
    sun.shadow.normalBias = 0.35; sun.shadow.bias = -0.0001;
    scene.add(sun, sun.target);
    materials = createMaterials(); overviewSurface();
    tiles = new TileManager(manifest, scene, materials, { maxCached: 72, concurrency: 4 });
    cityPass = pixelationPass(scene, camera, 1, 0.15, 0.12);
    ambientOcclusion = ao(cityPass.getTextureNode('depth'), cityPass.getTextureNode('normal'), camera);
    ambientOcclusion.resolutionScale = 0.5; ambientOcclusion.radius.value = 12;
    ambientOcclusion.thickness.value = 6; ambientOcclusion.samples.value = 8;
    pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = vec4(cityPass.rgb.mul(mix(1, ambientOcclusion.getTextureNode().r, aoStrength)), cityPass.a);
    setHour(14); resize(); fillSources(); setupInteractions(); drawMinimap();
    window.__cityWorld = {
      get ready() { return state.ready; }, get selected() { return state.selected; },
      get metrics() { return { backend, fps, drawCalls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles, gpuBytes: renderer.info.memory.total, ...tiles.stats }; },
      data: manifest, world: tiles, tiles, camera, controls, renderer, scene, state, materials, pipeline,
      goTo: (name, instant = true) => goTo(name, instant),
      select: id => selectBuilding(tiles.buildingMeshes.find(mesh => mesh.userData.building.id === id)),
      pick: (x,y) => pick({ clientX:x,clientY:y })?.userData.building.id,
    };
    timer.reset(); renderer.setAnimationLoop(render);
  } catch (error) { fail(error); }
}
init();
