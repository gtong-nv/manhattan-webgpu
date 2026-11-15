import * as THREE from 'three/webgpu';
import { color, mix, positionWorld, sin, smoothstep, step, texture, uniform, uv, vec2 } from 'three/tsl';

// Facade and ground UV coordinates are meters. All maps are generated once,
// repeat in physical units, and remain coherent while the camera rotates.
const TEX_WIDTH = 256;
const TEX_HEIGHT = 512;
const BAYS = 8;
const FLOORS = 8;

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(value) {
  let result = 2166136261;
  for (const character of String(value)) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

function avalanche(seed) {
  let value = seed >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function canvas2D(width, height, fill) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  if (fill) { context.fillStyle = fill; context.fillRect(0, 0, width, height); }
  return { canvas, ctx: context };
}

function textureFrom(canvas, metersX, metersY, name, data = false) {
  const map = new THREE.CanvasTexture(canvas);
  map.name = name;
  map.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1 / metersX, 1 / metersY);
  map.magFilter = THREE.NearestFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.anisotropy = 4;
  return map;
}

// Original architectural patterns, inspired by the contrast and detail density
// of 1990s isometric city games. These are interpretations, not surveyed facades.
const STYLES = [
  { name: 'Limestone piers', family: 'prewar', kind: 'pier', wall: '#bfb19b', trim: '#dfd1b8', dark: '#8c8171', joint: '#a79a86', glass: '#26303b', reflection: '#53616b', bay: 3.1, floor: 3.6 },
  { name: 'Warm granite', family: 'prewar', kind: 'pier', wall: '#9e9284', trim: '#c5b9a5', dark: '#756b63', joint: '#8c8174', glass: '#252c36', reflection: '#4e5a63', bay: 3.2, floor: 3.7 },
  { name: 'Art Deco sandstone', family: 'prewar', kind: 'deco', wall: '#b59d86', trim: '#d8bfa0', dark: '#867462', joint: '#9a846f', glass: '#2d3036', reflection: '#60616b', bay: 2.8, floor: 3.5 },
  { name: 'Terracotta office', family: 'prewar', kind: 'deco', wall: '#ac7e65', trim: '#d2a689', dark: '#795d50', joint: '#946c57', glass: '#252c34', reflection: '#505e65', bay: 3.0, floor: 3.5 },
  { name: 'Pale stone grid', family: 'stone', kind: 'stone', wall: '#c5bca8', trim: '#e0d6bd', dark: '#928b7d', joint: '#aca38f', glass: '#29323e', reflection: '#66707a', bay: 3.2, floor: 3.8 },
  { name: 'Gray granite', family: 'stone', kind: 'stone', wall: '#a29e96', trim: '#c8c3b5', dark: '#777973', joint: '#8e8e84', glass: '#282e37', reflection: '#56606a', bay: 3.1, floor: 3.7 },
  { name: 'Brownstone', family: 'stone', kind: 'stone', wall: '#897265', trim: '#b29c85', dark: '#62554e', joint: '#756457', glass: '#232c32', reflection: '#58666a', bay: 3.0, floor: 3.5 },
  { name: 'SoHo iron and brick', family: 'brick', kind: 'brick', wall: '#9b5b46', trim: '#baa58b', dark: '#6f4539', joint: '#85503e', glass: '#252e37', reflection: '#5b6a6b', bay: 2.8, floor: 3.4 },
  { name: 'Red warehouse brick', family: 'brick', kind: 'brick', wall: '#8d4e3e', trim: '#b08c6b', dark: '#633d33', joint: '#784539', glass: '#1f2a35', reflection: '#4b5b66', bay: 2.9, floor: 3.5 },
  { name: 'Buff brick', family: 'brick', kind: 'brick', wall: '#aa9270', trim: '#d0b694', dark: '#776c52', joint: '#958361', glass: '#29353c', reflection: '#586d71', bay: 2.9, floor: 3.4 },
  { name: 'Chocolate brick', family: 'brick', kind: 'brick', wall: '#70594c', trim: '#aa9479', dark: '#51453e', joint: '#604f42', glass: '#222b35', reflection: '#485a64', bay: 3.0, floor: 3.4 },
  { name: 'Seagreen curtain wall', family: 'glass', kind: 'glass', wall: '#537e79', trim: '#a9b8ac', dark: '#344d51', joint: '#71968e', glass: '#365f65', reflection: '#85aba0', bay: 3.2, floor: 3.9 },
  { name: 'Steel blue curtain wall', family: 'glass', kind: 'glass', wall: '#5c6e83', trim: '#b2bdc1', dark: '#354756', joint: '#7d94a5', glass: '#3b536a', reflection: '#93adbe', bay: 3.4, floor: 4.0 },
  { name: 'Bronze curtain wall', family: 'glass', kind: 'glass', wall: '#837967', trim: '#c0b69d', dark: '#4d514b', joint: '#99937c', glass: '#5a625f', reflection: '#b8b6a0', bay: 3.3, floor: 3.9 },
  { name: 'White modernist grid', family: 'modern', kind: 'grid', wall: '#c6c4b6', trim: '#dfdcca', dark: '#92958d', joint: '#acaea2', glass: '#2b3540', reflection: '#657681', bay: 3.6, floor: 3.7 },
  { name: 'Concrete ribbon windows', family: 'modern', kind: 'ribbon', wall: '#a9aaa1', trim: '#c8c9ba', dark: '#777f79', joint: '#969d92', glass: '#26363f', reflection: '#4f6872', bay: 3.6, floor: 3.6 },
  { name: 'Dark steel mullions', family: 'modern', kind: 'grid', wall: '#6c7374', trim: '#9ca4a1', dark: '#474f54', joint: '#828b8a', glass: '#222e3b', reflection: '#4a626e', bay: 3.4, floor: 3.8 },
  { name: 'Pink granite postmodern', family: 'modern', kind: 'pier', wall: '#a88a80', trim: '#ceb6a4', dark: '#796a65', joint: '#957c72', glass: '#28323e', reflection: '#5c6672', bay: 3.5, floor: 3.8 },
];

function makeFacadeMaps(style, index) {
  const diffuse = canvas2D(TEX_WIDTH, TEX_HEIGHT, style.wall);
  const bump = canvas2D(TEX_WIDTH, TEX_HEIGHT, '#9c9c9c');
  const lights = canvas2D(TEX_WIDTH, TEX_HEIGHT, '#000000');
  const ctx = diffuse.ctx;
  const random = randomSource(18689 + index * 673);

  // Quiet masonry grain and joints sit behind the pronounced window structure.
  for (let i = 0; i < 1800; i++) {
    ctx.fillStyle = random() > 0.5 ? '#ffffff07' : '#0000000a';
    ctx.fillRect(Math.floor(random() * 128) * 2, Math.floor(random() * 256) * 2, 2, 2);
  }
  ctx.fillStyle = style.joint;
  if (style.kind === 'brick') {
    for (let y = 0; y < TEX_HEIGHT; y += 8) {
      ctx.fillRect(0, y, TEX_WIDTH, 1);
      for (let x = (y / 8) % 2 ? -8 : 0; x < TEX_WIDTH; x += 16) ctx.fillRect(x, y, 1, 8);
    }
  } else if (style.kind !== 'glass') {
    for (let y = 0; y < TEX_HEIGHT; y += 16) {
      ctx.fillRect(0, y, TEX_WIDTH, 1);
      for (let x = (y / 16) % 2 ? -16 : 0; x < TEX_WIDTH; x += 32) ctx.fillRect(x, y, 1, 16);
    }
  }

  const glassTower = style.kind === 'glass';
  const ribbon = style.kind === 'ribbon';
  const pier = style.kind === 'pier' || style.kind === 'deco';
  for (let floor = 0; floor < FLOORS; floor++) {
    const fy = floor * 64;
    // Spandrel shadows and floor ledges give each story a clear 3D reading.
    ctx.fillStyle = style.dark;
    ctx.fillRect(0, fy + 59, TEX_WIDTH, glassTower ? 3 : 2);
    ctx.fillStyle = style.trim;
    ctx.fillRect(0, fy + 62, TEX_WIDTH, glassTower ? 1 : 2);
    for (let bay = 0; bay < BAYS; bay++) {
      const bx = bay * 32;
      const x = bx + (glassTower ? 2 : ribbon ? 1 : pier ? 8 : 7);
      const y = fy + (glassTower ? 3 : ribbon ? 13 : 10);
      const width = glassTower ? 28 : ribbon ? 30 : pier ? 16 : 18;
      const height = glassTower ? 55 : ribbon ? 34 : 42;
      ctx.fillStyle = style.dark;
      ctx.fillRect(x - 2, y - 3, width + 4, height + 5);
      bump.ctx.fillStyle = '#484848';
      bump.ctx.fillRect(x - 1, y - 1, width + 2, height + 2);
      ctx.fillStyle = style.glass;
      ctx.fillRect(x, y, width, height);
      if (!glassTower) {
        ctx.globalAlpha = 0.38 + random() * 0.18;
        ctx.fillStyle = style.reflection;
        ctx.fillRect(x + 1, y + 2, Math.max(3, Math.floor(width * (0.22 + random() * 0.3))), height - 4);
        if (random() > 0.72) ctx.fillRect(x + 1, y + height - 12, width - 2, 9);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = glassTower ? style.joint : style.dark;
      ctx.fillRect(x + Math.floor(width / 2), y, 1, height);
      if (!glassTower) ctx.fillRect(x, y + 24, width, 1);
      ctx.fillStyle = style.trim;
      ctx.fillRect(x - 2, y + height + 1, width + 4, 2);
      bump.ctx.fillStyle = '#d8d8d8';
      bump.ctx.fillRect(x - 2, y + height + 1, width + 4, 2);
      // Occasional shades make a repeated facade less mechanically uniform.
      if (random() > 0.8 && !glassTower) {
        ctx.fillStyle = '#b2ad95';
        ctx.fillRect(x + 1, y + 1, width - 2, 7 + Math.floor(random() * 9));
      }
      if (random() > 0.68) {
        lights.ctx.fillStyle = random() > 0.3 ? '#ffc374' : '#e1c59d';
        lights.ctx.fillRect(x + 1, y + 1, width - 2, height - 2);
        lights.ctx.fillStyle = '#000000';
        lights.ctx.fillRect(x + Math.floor(width / 2), y, 1, height);
        if (!glassTower) lights.ctx.fillRect(x, y + 24, width, 1);
      }
      if (pier || style.kind === 'grid') {
        ctx.fillStyle = style.trim;
        ctx.fillRect(bx, fy, 3, 64);
        ctx.fillStyle = style.dark;
        ctx.fillRect(bx + 3, fy, 2, 64);
        bump.ctx.fillStyle = '#d0d0d0';
        bump.ctx.fillRect(bx, fy, 3, 64);
      }
      if (style.kind === 'deco') {
        ctx.fillStyle = style.trim;
        ctx.fillRect(bx + 27, fy, 3, 64);
        ctx.fillStyle = style.dark;
        ctx.fillRect(bx + 30, fy, 2, 64);
      }
    }
  }

  if (glassTower) {
    // The repeating atlas contains only a quiet architectural grid. Reflection
    // colors live in the meter-scaled shader below, so they never repeat every
    // eight stories or turn into a mosaic of bright individual windows.
    ctx.fillStyle = '#f4f5f3'; ctx.fillRect(0, 0, TEX_WIDTH, TEX_HEIGHT);
    for (let bay = 0; bay < BAYS; bay++) {
      ctx.fillStyle = '#d5dcda'; ctx.fillRect(bay * 32, 0, 1, TEX_HEIGHT);
      ctx.fillStyle = '#e6eae6'; ctx.fillRect(bay * 32 + 16, 0, 1, TEX_HEIGHT);
    }
    for (let floor = 0; floor < FLOORS; floor++) {
      ctx.fillStyle = '#e2e7e3'; ctx.fillRect(0, floor * 64 + 58, TEX_WIDTH, 5);
      ctx.fillStyle = '#ccd6d2'; ctx.fillRect(0, floor * 64 + 63, TEX_WIDTH, 1);
    }
  }

  const storefront = canvas2D(256, 128, style.dark);
  const shop = storefront.ctx;
  for (let bay = 0; bay < BAYS; bay++) {
    const x = bay * 32;
    shop.fillStyle = style.wall;
    shop.fillRect(x, 0, 5, 128);
    shop.fillStyle = style.trim;
    shop.fillRect(x, 0, 3, 128);
    shop.fillRect(x, 0, 32, 7);
    shop.fillStyle = '#1e2932';
    shop.fillRect(x + 6, 38, 25, 80);
    shop.fillStyle = '#4e6267';
    shop.fillRect(x + 8, 43, 8, 68);
    shop.fillStyle = bay % 3 === 0 ? '#4a584a' : bay % 3 === 1 ? '#6f453a' : '#3c4854';
    shop.fillRect(x + 5, 15, 27, 17);
    shop.fillStyle = '#d4c4a0';
    for (let letter = 0; letter < 5; letter++) shop.fillRect(x + 9 + letter * 4, 22, 2, 2);
    shop.fillStyle = style.trim;
    shop.fillRect(x + 5, 34, 27, 3);
    shop.fillRect(x + 17, 39, 2, 80);
    shop.fillRect(x, 119, 32, 5);
  }
  const metersX = style.bay * BAYS;
  const metersY = style.floor * FLOORS;
  const label = style.name;
  return {
    map: textureFrom(diffuse.canvas, metersX, metersY, `${label} / color`),
    bumpMap: textureFrom(bump.canvas, metersX, metersY, `${label} / recess`, true),
    emissiveMap: textureFrom(lights.canvas, metersX, metersY, `${label} / window lights`),
    storefront: textureFrom(storefront.canvas, metersX, 5.4, `${label} / street level`),
    metersX,
    metersY,
  };
}

function roofTexture(base, index) {
  const { canvas, ctx } = canvas2D(256, 256, base);
  const random = randomSource(7501 + index * 99);
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = random() > 0.5 ? '#ffffff10' : '#00000012';
    ctx.fillRect(Math.floor(random() * 128) * 2, Math.floor(random() * 128) * 2, 2, 2);
  }
  ctx.fillStyle = '#393d3b35';
  for (let y = 0; y < 256; y += 64) ctx.fillRect(0, y, 256, 2);
  for (let i = 0; i < 5; i++) {
    const x = 12 + Math.floor(random() * 210), y = 12 + Math.floor(random() * 210);
    const width = 11 + Math.floor(random() * 19), height = 9 + Math.floor(random() * 15);
    ctx.fillStyle = '#30343785'; ctx.fillRect(x + 4, y + 5, width, height);
    ctx.fillStyle = '#b5b2a5'; ctx.fillRect(x, y, width, height);
    ctx.fillStyle = '#68716e'; ctx.fillRect(x + 2, y + 2, width - 4, height - 4);
    ctx.fillStyle = '#929b96';
    for (let v = 3; v < height - 2; v += 3) ctx.fillRect(x + 3, y + v, width - 6, 1);
  }
  return textureFrom(canvas, 28, 28, `Roof ${index + 1}`);
}

function groundTexture(kind) {
  const base = { road: '#53595c', sidewalk: '#aaa99b', grass: '#768b4e', earth: '#ab9c83' }[kind];
  const { canvas, ctx } = canvas2D(256, 256, base);
  const random = randomSource(hash(kind));
  for (let i = 0; i < (kind === 'grass' ? 3800 : 1900); i++) {
    ctx.fillStyle = random() > 0.5 ? '#fff1cc12' : '#162d1c12';
    const size = kind === 'grass' ? 2 + Math.floor(random() * 4) : 1;
    ctx.fillRect(Math.floor(random() * 256), Math.floor(random() * 256), size, size);
  }
  if (kind === 'sidewalk') {
    ctx.fillStyle = '#858b803f';
    for (let p = 0; p < 256; p += 32) {
      ctx.fillRect(p, 0, 1, 256); ctx.fillRect(0, p, 256, 1);
    }
  }
  return textureFrom(canvas, { road: 24, sidewalk: 16, grass: 20, earth: 24 }[kind],
    { road: 24, sidewalk: 16, grass: 20, earth: 24 }[kind], kind);
}

function makeLightRamp() {
  const ramp = new THREE.DataTexture(new Uint8Array([56, 110, 171, 244]), 4, 1, THREE.RedFormat);
  ramp.name = 'Shared four-band cel lighting';
  ramp.colorSpace = THREE.NoColorSpace;
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;
  return ramp;
}

function makeFoamTexture() {
  const { canvas, ctx } = canvas2D(512, 512, '#000000');
  const random = randomSource(152819);
  ctx.lineCap = 'round';
  for (let i = 0; i < 60; i++) {
    // Sparse, short, imperfect pen strokes, rather than a periodic ripple grid.
    const x = 25 + random() * 450, y = 20 + random() * 470;
    const width = 8 + random() * 23;
    const bend = (random() - 0.5) * 6;
    const shade = Math.floor(140 + random() * 115);
    ctx.strokeStyle = `rgb(${shade},${shade},${shade})`;
    ctx.lineWidth = 1.6 + random() * 1.3;
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + width * 0.5, y + bend, x + width, y + bend * 0.3);
    ctx.stroke();
    if (random() > 0.78) {
      ctx.beginPath(); ctx.moveTo(x + 4, y + 5);
      ctx.lineTo(x + width * 0.7, y + 5); ctx.stroke();
    }
  }
  const map = textureFrom(canvas, 320, 320, 'Harbor / drawn foam strokes', true);
  // Minification averages strokes away before they become subpixel flicker.
  map.magFilter = THREE.LinearFilter;
  return map;
}

function makeWater(timeNode, daylightNode, detailNode, gradientMap, foamMap) {
  const water = new THREE.MeshToonNodeMaterial({
    name: 'Harbor / three-tone illustrated water', gradientMap, side: THREE.DoubleSide,
  });
  const p = positionWorld.xz;
  const broad = sin(p.x.mul(0.0019).add(sin(p.y.mul(0.0013)).mul(1.8)))
    .add(sin(p.y.mul(0.0021).sub(p.x.mul(0.0007))).mul(0.6));
  const middle = mix(color('#2e6e82'), color('#3c8292'), step(-0.25, broad));
  const bands = mix(middle, color('#5999a2'), step(0.75, broad));
  const foamUV = p.mul(1 / 320).add(vec2(timeNode.mul(0.00035), timeNode.mul(0.00008)));
  const strokes = texture(foamMap, foamUV).r;
  const detail = smoothstep(0.08, 0.75, detailNode);
  water.colorNode = mix(bands, color('#b8d4cd'), strokes.mul(detail).mul(0.55))
    .mul(daylightNode.mul(0.3).add(0.7));
  return water;
}

function profileIndex(building) {
  const identity = building.id ?? building.bin ?? building.name ?? 'NYC';
  // Separate random streams prevent the family decision (seed % 3) from
  // accidentally selecting the same one of the three glass styles every time.
  const familySeed = avalanche(hash(`${identity}:family`));
  const styleSeed = avalanche(hash(`${identity}:facade`));
  const height = Number(building.height) || 15;
  const year = Number(building.year) || 0;
  const name = String(building.name ?? '').toLowerCase();
  let family;
  if (/glass|world trade|liberty plaza|brookfield|goldman/.test(name)) family = 'glass';
  else if (year && year < 1945) family = height > 65 ? 'prewar' : height < 35 ? 'brick' : 'stone';
  else if (year && year < 1978) family = height > 90 ? 'modern' : familySeed % 3 ? 'brick' : 'stone';
  else if (year >= 1978) family = height > 70 ? (familySeed % 3 ? 'glass' : 'modern') : 'modern';
  else family = height > 110 ? (familySeed % 3 ? 'prewar' : 'glass') : height < 35 ? 'brick' : 'stone';
  const candidates = STYLES.map((style, index) => style.family === family ? index : -1).filter(index => index >= 0);
  return candidates[styleSeed % candidates.length];
}

export function createMaterials() {
  const textures = new Set();
  const allMaterials = new Set();
  const timeNode = uniform(0);
  const daylightNode = uniform(1);
  const nightNode = uniform(0);
  const waterDetailNode = uniform(1);
  const gradientMap = makeLightRamp(); textures.add(gradientMap);
  const foamMap = makeFoamTexture(); textures.add(foamMap);
  const register = material => { allMaterials.add(material); return material; };
  const flat = (name, value, options = {}) => register(new THREE.MeshToonNodeMaterial({ name, color: value, gradientMap, ...options }));
  const facadeStyles = { prewar: [], stone: [], brick: [], glass: [], modern: [] };
  const coarseFacades = [];
  const facades = STYLES.map((style, index) => {
    const maps = makeFacadeMaps(style, index);
    for (const value of Object.values(maps)) if (value?.isTexture) textures.add(value);
    const material = register(new THREE.MeshToonNodeMaterial({
      name: style.name,
      gradientMap,
      vertexColors: true,
      map: maps.map,
      bumpMap: style.kind === 'glass' ? null : maps.bumpMap,
      bumpScale: 0.045,
    }));
    // Explicit TSL sampling preserves the facade UV's meter scale; only the
    // first 5.4 meters receive storefronts, regardless of the building height.
    const facadeUV = uv().mul(vec2(1 / maps.metersX, 1 / maps.metersY));
    const shopUV = uv().mul(vec2(1 / maps.metersX, 1 / 5.4));
    const baseMask = step(uv().y, style.kind === 'glass' ? 5.4 : 4.8);
    let facadeColor = texture(maps.map, facadeUV).rgb;
    if (style.kind === 'glass') {
      const variant = index % 3;
      // Three restrained tones span whole elevations. A step is 120–160m
      // tall; horizontal regions are about 45–75m wide, independent of the
      // repeating window atlas. Existing per-building UVs shift these blocks.
      const elevationStep = uv().y.div(120 + variant * 20).floor();
      const phase = uv().x.add(elevationStep.mul(32 + variant * 7)).add(index * 31)
        .div(180 + variant * 16).fract();
      const lightBlock = step(0.22, phase).mul(step(0.56, phase).oneMinus());
      const middleBlock = step(0.56, phase).mul(step(0.85, phase).oneMinus());
      const baseTone = color(style.glass);
      const middleTone = mix(baseTone, color(style.wall), 0.30);
      const lightTone = mix(baseTone, color(style.reflection), 0.24);
      const reflection = mix(mix(baseTone, middleTone, middleBlock), lightTone, lightBlock);
      facadeColor = reflection.mul(facadeColor);
    }
    material.colorNode = mix(facadeColor, texture(maps.storefront, shopUV).rgb, baseMask);
    material.emissiveNode = texture(maps.emissiveMap, facadeUV).rgb.mul(nightNode).mul(baseMask.oneMinus());
    material.userData = { family: style.family, index, bayWidth: style.bay, floorHeight: style.floor, baseHeight: 5.4 };
    facadeStyles[style.family].push(material);
    // Distant tiles keep each architectural family recognizable without maps.
    coarseFacades.push(flat(`${style.name} / distant`, style.wall, { vertexColors: true }));
    return material;
  });
  const roofs = ['#a9a79b', '#8eaa9b', '#646f79', '#ae8c71'].map((base, index) => {
    const map = roofTexture(base, index); textures.add(map);
    return register(new THREE.MeshToonNodeMaterial({ name: `Roof ${index + 1}`, map, gradientMap, vertexColors: true }));
  });
  const ground = kind => {
    const map = groundTexture(kind); textures.add(map);
    return register(new THREE.MeshToonNodeMaterial({ name: kind, map, gradientMap }));
  };
  const materials = {
    facades, facadeStyles, coarseFacades, roofs,
    road: ground('road'), sidewalk: ground('sidewalk'), grass: ground('grass'), earth: ground('earth'),
    treeTrunk: flat('Bark', '#68523b'),
    treeLeaves: ['#425e32', '#5a7739', '#728846', '#376044', '#8e9950'].map((value, index) => flat(`Tree canopy ${index + 1}`, value)),
    carBodies: ['#e5b433', '#943d33', '#d1cebd', '#427979', '#344d66', '#6b7954'].map((value, index) => flat(`Traffic ${index + 1}`, value)),
    carWindows: flat('Automotive glass', '#243e4a'),
    roadMark: flat('Road paint', '#d7ccb0', { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    water: register(makeWater(timeNode, daylightNode, waterDetailNode, gradientMap, foamMap)),
    waterFoam: flat('Shoreline wash', '#9cae9d', { transparent: true, opacity: 0.38, depthWrite: false }),
    trimLight: flat('Stone cornices', '#c4b8a1'),
    trimDark: flat('Cornice shadows', '#6b665d'),
    metal: flat('Rooftop iron', '#4a5155'),
    glassDark: flat('Dark skylights', '#273c49'),
    mechanical: flat('Roof machinery', '#8d9992'),
    waterTowerWood: flat('Water tower timber', '#75523c'),
    copper: flat('Weathered copper', '#497c70'),
    crownSilver: flat('Stainless steel crown', '#a6aaa7'),
    facadeProfile(building) {
      const index = profileIndex(building), style = STYLES[index];
      return { family: style.family, index, material: facades[index], coarseMaterial: coarseFacades[index], floorHeight: style.floor, bayWidth: style.bay, baseHeight: 5.4, roofIndex: hash(building.id ?? '') % roofs.length, cornice: style.family === 'prewar' || style.family === 'stone' || style.family === 'brick' };
    },
    selectFacade(building) { return facades[profileIndex(building)]; },
    update(elapsed, daylight = 1, waterDetail = 1) {
      const day = THREE.MathUtils.clamp(daylight, 0, 1);
      timeNode.value = elapsed;
      daylightNode.value = day;
      waterDetailNode.value = THREE.MathUtils.clamp(waterDetail, 0, 1);
      nightNode.value = (1 - THREE.MathUtils.smoothstep(day, 0.12, 0.65)) * 0.85;
    },
    dispose() {
      for (const map of textures) map.dispose();
      for (const material of allMaterials) material.dispose();
    },
  };
  return materials;
}
