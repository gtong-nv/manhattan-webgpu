import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const GROUND = 0.7;
const STREET = 0.94;
const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

function hash(value) {
  let h = 2166136261;
  for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function randomFor(value) {
  let s = hash(value);
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Linear RGB multipliers deliberately vary within an architectural family.
// They travel in vertex buffers, so hundreds of differently colored buildings
// still share one material batch and one draw call per archetype.
const FACADE_TINTS = {
  glass: [
    [0.72, 0.94, 1.20], [0.54, 0.77, 1.17], [0.64, 1.08, 0.96],
    [0.77, 1.08, 0.75], [1.13, 1.15, 1.17], [0.61, 0.68, 0.77],
    [1.25, 0.95, 0.64], [1.20, 1.07, 0.84],
  ],
  prewar: [
    [1.13, 1.03, 0.86], [0.89, 0.98, 1.10], [1.20, 0.98, 0.88],
    [0.76, 0.80, 0.84], [1.02, 1.06, 0.95], [1.03, 0.87, 0.76],
  ],
  stone: [
    [1.17, 1.10, 0.88], [0.89, 1.00, 1.12], [1.13, 1.13, 1.13],
    [1.20, 0.97, 0.76], [1.18, 0.94, 0.91], [0.74, 0.82, 0.91],
  ],
  brick: [
    [1.20, 0.83, 0.68], [1.13, 0.79, 0.77], [1.16, 1.04, 0.79],
    [0.75, 0.73, 0.71], [0.91, 0.76, 0.65], [1.09, 1.04, 0.96],
  ],
  modern: [
    [1.14, 1.14, 1.12], [0.79, 0.94, 1.15], [0.78, 1.07, 0.95],
    [1.19, 1.00, 0.81], [0.67, 0.73, 0.80], [1.18, 0.91, 0.87],
  ],
};

const ROOF_TINTS = [
  [0.68, 0.73, 0.81], [1.05, 1.03, 0.94], [0.80, 0.87, 0.81],
  [1.14, 0.95, 0.78], [0.87, 0.78, 0.72], [0.95, 0.99, 1.12],
  [0.64, 0.67, 0.68],
];

function buildingAppearance(building, profile, rings, origin) {
  const identity = building.id ?? building.bin ?? building.bbl ?? building.centroid?.join(',') ?? building.name ?? '';
  // Appearance has an independent RNG: a color change never changes roof shapes,
  // traffic, source geometry, or the deterministic placement of existing details.
  const rng = randomFor(`appearance:${identity}`);
  const palette = FACADE_TINTS[profile.family] || FACADE_TINTS.stone;
  const tintIndex = Math.floor(rng() * palette.length);
  const brightness = 0.82 + rng() * 0.36;
  const tint = palette[tintIndex].map(component => component * brightness);
  const roofIndex = Math.floor(rng() * ROOF_TINTS.length);
  const roofBrightness = 0.84 + rng() * 0.32;
  const roofTint = ROOF_TINTS[roofIndex].map(component => component * roofBrightness);
  const anchor = Array.isArray(building.centroid) && building.centroid.length >= 2
    ? new THREE.Vector2(building.centroid[0] - origin[0], building.centroid[1] - origin[1])
    : ringCenter(rings[0]);
  return {
    tint,
    roofTint,
    tintIndex,
    roofIndex,
    // Floors keep their measured-meter V coordinate. Horizontal variation makes
    // neighboring curtain walls use different bay pitches and lit-window phases.
    scaleU: 0.86 + rng() * 0.29,
    offsetU: Math.floor(rng() * 8) * (profile.bayWidth || 3.3),
    roofRotation: Math.floor(rng() * 4),
    roofScale: 0.86 + rng() * 0.28,
    roofOffset: [rng() * 28, rng() * 28],
    roofAnchor: anchor,
  };
}

function ensureVertexColors(geometry) {
  if (!geometry.getAttribute('color')) {
    const colors = new Float32Array(geometry.getAttribute('position').count * 3);
    colors.fill(1);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  return geometry;
}

function applyBuildingAppearance(geometry, appearance) {
  ensureVertexColors(geometry);
  const colors = geometry.getAttribute('color');
  const uv = geometry.getAttribute('uv');
  const visited = new Uint8Array(colors.count);
  const turns = appearance.roofRotation;
  for (const section of geometry.groups) {
    const wall = section.materialIndex === 0;
    const tint = wall ? appearance.tint : appearance.roofTint;
    for (let i = section.start; i < section.start + section.count; i++) {
      const vertex = geometry.index.getX(i);
      if (visited[vertex]) continue;
      visited[vertex] = 1;
      colors.setXYZ(vertex, tint[0], tint[1], tint[2]);
      if (wall) {
        uv.setX(vertex, uv.getX(vertex) * appearance.scaleU + appearance.offsetU);
      } else {
        // A building-local anchor keeps the exact same roof pattern when its
        // vertex coordinates move between 500 m / 1 km / 2 km tile origins.
        const x = (uv.getX(vertex) - appearance.roofAnchor.x) * appearance.roofScale;
        const y = (uv.getY(vertex) - appearance.roofAnchor.y) * appearance.roofScale;
        const u = turns === 0 ? x : turns === 1 ? -y : turns === 2 ? -x : y;
        const v = turns === 0 ? y : turns === 1 ? x : turns === 2 ? -y : -x;
        uv.setXY(vertex, u + appearance.roofOffset[0], v + appearance.roofOffset[1]);
      }
    }
  }
}

function cleanRing(points) {
  const result = [];
  for (const p of points || []) {
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = result[result.length - 1];
    if (!last || Math.hypot(x - last.x, y - last.y) > 0.02) result.push(new THREE.Vector2(x, y));
  }
  if (result.length > 2 && result[0].distanceTo(result[result.length - 1]) < 0.02) result.pop();
  return result;
}

function normalizedRings(input) {
  return (input || []).map(cleanRing).filter(r => r.length >= 3).map((r, i) => {
    // An outer ring runs counterclockwise; the building lies left of every wall edge.
    if (THREE.ShapeUtils.isClockWise(r) === (i === 0)) r.reverse();
    return r;
  });
}

function makeShape(rings) {
  const shape = new THREE.Shape(rings[0]);
  for (const hole of rings.slice(1)) shape.holes.push(new THREE.Path(hole));
  return shape;
}

function flatPolygon(rings, elevation) {
  const geometry = new THREE.ShapeGeometry(makeShape(rings));
  const positions = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const north = positions.getY(i);
    positions.setXYZ(i, x, elevation, -north);
    uv.setXY(i, x, north);
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function extrudedPolygon(rings, height, base = GROUND, uvBase = 0) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let vertex = 0;
  for (const ring of rings) {
    let perimeter = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < 0.01) continue;
      positions.push(a.x, base, -a.y, b.x, base, -b.y,
        b.x, base + height, -b.y, a.x, base + height, -a.y);
      for (let n = 0; n < 4; n++) normals.push(dy / length, 0, dx / length);
      uvs.push(perimeter, uvBase, perimeter + length, uvBase,
        perimeter + length, uvBase + height, perimeter, uvBase + height);
      indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3);
      vertex += 4;
      perimeter += length;
    }
  }
  const wallCount = indices.length;
  const top = new THREE.ShapeGeometry(makeShape(rings));
  const topPosition = top.attributes.position;
  for (let i = 0; i < topPosition.count; i++) {
    const x = topPosition.getX(i);
    const y = topPosition.getY(i);
    positions.push(x, base + height, -y);
    normals.push(0, 1, 0);
    uvs.push(x, y);
  }
  const topIndices = top.index;
  for (let i = 0; i < topIndices.count; i++) indices.push(vertex + topIndices.getX(i));
  top.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.addGroup(0, wallCount, 0);
  geometry.addGroup(wallCount, indices.length - wallCount, 1);
  geometry.computeBoundingSphere();
  return geometry;
}

function insideRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function roofPoint(rings, rng, margin) {
  const bounds = new THREE.Box2().setFromPoints(rings[0]);
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = THREE.MathUtils.lerp(bounds.min.x, bounds.max.x, attempt ? rng() : 0.5);
    const y = THREE.MathUtils.lerp(bounds.min.y, bounds.max.y, attempt ? rng() : 0.5);
    if (!insideRing(x, y, rings[0]) || rings.slice(1).some(r => insideRing(x, y, r))) continue;
    let valid = true;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = THREE.MathUtils.clamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
        if (Math.hypot(x - a.x - t * dx, y - a.y - t * dy) < margin) { valid = false; break; }
      }
      if (!valid) break;
    }
    if (valid) return [x, y];
  }
  return null;
}

function roadGeometry(points, width, elevation) {
  const vertices = [];
  const uvs = [];
  const indices = [];
  let distance = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next[0] - previous[0];
    let dy = next[1] - previous[1];
    const length = Math.hypot(dx, dy) || 1;
    dx /= length;
    dy /= length;
    if (i) distance += Math.hypot(p[0] - previous[0], p[1] - previous[1]);
    const half = width / 2;
    vertices.push(p[0] - dy * half, elevation, -p[1] - dx * half,
      p[0] + dy * half, elevation, -p[1] + dx * half);
    uvs.push(0, distance, width, distance);
    if (i) {
      const a = (i - 1) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function pathInfo(points) {
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + Math.hypot(
    points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return { points, distances, length: distances[distances.length - 1] || 0 };
}

function samplePath(path, along, lane, direction, target) {
  const distance = ((along % path.length) + path.length) % path.length;
  let i = 1;
  while (i < path.distances.length - 1 && path.distances[i] < distance) i++;
  const a = path.points[i - 1];
  const b = path.points[i];
  const length = path.distances[i] - path.distances[i - 1] || 1;
  const t = (distance - path.distances[i - 1]) / length;
  const dx = (b[0] - a[0]) / length;
  const dy = (b[1] - a[1]) / length;
  target.x = THREE.MathUtils.lerp(a[0], b[0], t) + dy * lane * direction;
  target.z = -THREE.MathUtils.lerp(a[1], b[1], t) + dx * lane * direction;
  target.angle = Math.atan2(dx * direction, -dy * direction);
  return target;
}

function localRings(rings, origin) {
  return normalizedRings((rings || []).map(ring => ring.map(p => [p[0] - origin[0], p[1] - origin[1]])));
}

function ringCenter(ring) {
  let x = 0;
  let y = 0;
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const cross = a.x * b.y - b.x * a.y;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
    area += cross;
  }
  if (Math.abs(area) < 0.01) return new THREE.Box2().setFromPoints(ring).getCenter(new THREE.Vector2());
  return new THREE.Vector2(x / (3 * area), y / (3 * area));
}

// A conservative inferred setback. Concave footprints and courtyard buildings
// retain their original plan whenever a proposed upper floor leaves the base.
function setbackRings(rings, factor) {
  if (factor >= 0.999 || rings.length > 1) return rings;
  const center = ringCenter(rings[0]);
  if (!insideRing(center.x, center.y, rings[0])) return rings;
  const outer = rings[0];
  for (let f = factor; f < 0.995; f += 0.08) {
    const candidate = outer.map(p => p.clone().sub(center).multiplyScalar(f).add(center));
    const valid = candidate.every((p, i) => {
      const next = candidate[(i + 1) % candidate.length];
      return insideRing(p.x, p.y, outer) && insideRing((p.x + next.x) / 2, (p.y + next.y) / 2, outer);
    });
    if (valid) return [candidate];
  }
  return rings;
}

function wtcShaft(rings) {
  const center = ringCenter(rings[0]);
  let longest = 0;
  let angle = 0;
  for (let i = 0; i < rings[0].length; i++) {
    const a = rings[0][i];
    const b = rings[0][(i + 1) % rings[0].length];
    if (a.distanceToSquared(b) > longest) {
      longest = a.distanceToSquared(b);
      angle = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  const cs = Math.cos(angle);
  const sn = Math.sin(angle);
  const box = new THREE.Box2().setFromPoints(rings[0].map(p => new THREE.Vector2(
    (p.x - center.x) * cs + (p.y - center.y) * sn,
    -(p.x - center.x) * sn + (p.y - center.y) * cs)));
  let radius = Math.min(box.max.x - box.min.x, box.max.y - box.min.y) * 0.45;
  const square = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  const diamond = [[0, -1], [0.5, -0.5], [1, 0], [0.5, 0.5], [0, 1], [-0.5, 0.5], [-1, 0], [-0.5, -0.5]];
  const transform = (p, r) => new THREE.Vector2(center.x + p[0] * r * cs - p[1] * r * sn,
    center.y + p[0] * r * sn + p[1] * r * cs);
  for (let i = 0; i < 5; i++) {
    if (square.every(p => { const q = transform(p, radius); return insideRing(q.x, q.y, rings[0]); })) break;
    radius *= 0.84;
  }
  return { lower: [square.map(p => transform(p, radius))], upper: [diamond.map(p => transform(p, radius * 1.14))] };
}

function loftedPolygon(lower, upper, height, base, uvBase) {
  const ring = lower[0];
  const topRing = upper[0];
  const positions = [];
  const uvs = [];
  const indices = [];
  let perimeter = 0;
  for (let i = 0; i < ring.length; i++) {
    const next = (i + 1) % ring.length;
    const a = ring[i], b = ring[next], c = topRing[next], d = topRing[i];
    const length = a.distanceTo(b);
    positions.push(a.x, base, -a.y, b.x, base, -b.y,
      c.x, base + height, -c.y, d.x, base + height, -d.y);
    uvs.push(perimeter, uvBase, perimeter + length, uvBase,
      perimeter + length, uvBase + height, perimeter, uvBase + height);
    const v = i * 4;
    indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    perimeter += length;
  }
  const wallCount = indices.length;
  const top = flatPolygon(upper, base + height);
  const topPosition = top.attributes.position;
  const topUv = top.attributes.uv;
  for (let i = 0; i < topPosition.count; i++) {
    positions.push(topPosition.getX(i), topPosition.getY(i), topPosition.getZ(i));
    uvs.push(topUv.getX(i), topUv.getY(i));
  }
  for (let i = 0; i < top.index.count; i++) indices.push(ring.length * 4 + top.index.getX(i));
  top.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.addGroup(0, wallCount, 0);
  geometry.addGroup(wallCount, indices.length - wallCount, 1);
  geometry.computeBoundingSphere();
  return geometry;
}

function landmarkName(building) {
  const supplied = building.landmark || '';
  const name = `${supplied} ${building.name || ''}`.toLowerCase();
  if (/empire[ -]state/.test(name)) return 'empire-state';
  if (/chrysler/.test(name)) return 'chrysler';
  if (/one[ -]wtc|one world trade|1 world trade/.test(name)) return 'one-wtc';
  if (/woolworth/.test(name)) return 'woolworth';
  if (/flatiron/.test(name)) return 'flatiron';
  if (/rockefeller|30 rock/.test(name)) return 'rockefeller';
  if (supplied === 'metlife' || /metlife.*clock|met life.*tower/.test(name)) return 'metlife';
  if (/trinity.*church/.test(name)) return 'trinity';
  return supplied;
}

function architecturalSections(building, rings, height, lod, family, rng) {
  const landmark = landmarkName(building);
  if (lod >= 2) return [{ rings, from: 0, to: 1 }];
  if (landmark === 'one-wtc' && rings.length === 1) {
    const shaft = wtcShaft(rings);
    return [{ rings, from: 0, to: 0.10 }, { rings: shaft.lower, topRings: shaft.upper, from: 0.10, to: 0.88 }];
  }
  let tiers;
  if (landmark === 'empire-state') {
    tiers = [[0.09, 1], [0.19, 0.86], [0.69, 0.62], [0.80, 0.49], [0.88, 0.36], [0.94, 0.20]];
  } else if (landmark === 'chrysler') {
    tiers = [[0.10, 1], [0.17, 0.90], [0.73, 0.73], [0.82, 0.59], [0.88, 0.43], [0.93, 0.28]];
  } else if (landmark === 'one-wtc') {
    tiers = [[0.10, 1], [0.28, 0.94], [0.51, 0.84], [0.73, 0.74], [0.88, 0.63]];
  } else if (landmark === 'woolworth') {
    tiers = [[0.47, 1], [0.72, 0.66], [0.86, 0.48], [0.94, 0.30]];
  } else if (landmark === 'trinity') {
    tiers = [[0.25, 1], [0.46, 0.38], [0.73, 0.23]];
  } else if (landmark === 'metlife') {
    tiers = [[0.16, 1], [0.74, 0.90], [0.85, 0.75], [0.91, 0.60]];
  } else if (landmark === 'rockefeller') {
    tiers = [[0.12, 1], [0.72, 0.80], [0.89, 0.66], [1, 0.52]];
  } else if (landmark === 'flatiron' || rings.length > 1 || height < 24) {
    tiers = [[1, 1]];
  } else if (height > 140) {
    if (family === 'glass' || family === 'modern') {
      tiers = rng() < 0.45 ? [[0.09, 1], [0.94, 0.80], [1, 0.66]] : [[0.12, 1], [0.86, 0.84], [1, 0.72]];
    } else {
      tiers = [[0.15, 1], [0.69, 0.84], [0.87, 0.66], [1, 0.47]];
    }
  } else if (height > 70) {
    tiers = family === 'prewar' || family === 'stone'
      ? [[0.52, 1], [0.82, 0.84], [1, 0.67]]
      : [[0.13, 1], [0.94, 0.85], [1, 0.73]];
  } else if (height > 35 && rng() > 0.3) {
    tiers = [[0.79, 1], [1, 0.82]];
  } else {
    tiers = [[1, 1]];
  }
  if (lod === 1 && !landmark && tiers.length > 2) tiers = [tiers[0], tiers[tiers.length - 1]];
  let from = 0;
  return tiers.map(([to, factor]) => {
    const section = { rings: setbackRings(rings, factor), from, to };
    from = to;
    return section;
  });
}

/**
 * Build one immutable spatial tile. Input coordinates are GLOBAL east/north
 * meters; vertex buffers are tile-local, and group.position carries its origin.
 * Roof silhouettes above the measured footprint are artistic reconstructions.
 */
export function createTileWorld(data, materials, options = {}) {
  const lod = Math.max(0, Math.min(2, Number(options.lod ?? data.meta?.lod) || 0));
  const bounds = data.meta?.bounds;
  const origin = data.meta?.origin || (bounds ? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] : [0, 0]);
  const group = new THREE.Group();
  group.name = `Manhattan tile ${data.meta?.id || origin.join(',')} · LOD ${lod}`;
  group.position.set(origin[0], 0, -origin[1]);
  group.userData.tileOrigin = origin;
  group.userData.lod = lod;
  const buildingMeshes = [];
  const pickingGroup = new THREE.Group();
  pickingGroup.name = 'Selection geometry · interpreted architectural silhouettes';
  pickingGroup.visible = false;
  const treeGroup = new THREE.Group();
  treeGroup.name = 'Georeferenced vegetation';
  const trafficGroup = new THREE.Group();
  trafficGroup.name = 'Illustrative traffic on mapped roads';
  group.add(pickingGroup, treeGroup, trafficGroup);
  const roofs = Array.isArray(materials.roofs) ? materials.roofs : [materials.roofs];
  const trimLight = materials.trimLight || roofs[0];
  const trimDark = materials.trimDark || roofs[1] || roofs[0];
  const metal = materials.metal || materials.carWindows;
  const mechanical = materials.mechanical || trimDark;
  const towerWood = materials.waterTowerWood || trimDark;
  const copper = materials.copper || trimDark;
  const glassDark = materials.glassDark || materials.carWindows;
  const geometryPool = new Set();
  const geometriesToMerge = new Map();
  const instanceBuckets = [];
  const box = new THREE.BoxGeometry(1, 1, 1);
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, lod ? 6 : 10);
  const cone = new THREE.ConeGeometry(1, 1, lod ? 6 : 10);
  geometryPool.add(box);
  geometryPool.add(cylinder);
  geometryPool.add(cone);
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  let detailCount = 0;

  function addBatch(geometry, material, castShadow = true) {
    if (!geometry || !material) { geometry?.dispose(); return; }
    // Ground, roads and bridge decks may share a material with other surfaces;
    // a neutral attribute keeps every merge's layout compatible with facades.
    ensureVertexColors(geometry);
    if (!geometriesToMerge.has(material)) geometriesToMerge.set(material, { geometries: [], castShadow });
    const batch = geometriesToMerge.get(material);
    batch.castShadow ||= castShadow;
    geometry.clearGroups();
    batch.geometries.push(geometry);
  }

  function addBuildingSection(geometry, facade, roof) {
    for (const [index, material] of [[0, facade], [1, roof]]) {
      const section = geometry.groups[index];
      const part = new THREE.BufferGeometry();
      for (const [name, attribute] of Object.entries(geometry.attributes)) part.setAttribute(name, attribute);
      part.setIndex(Array.from(geometry.index.array.subarray(section.start, section.start + section.count)));
      addBatch(part, material);
    }
  }

  function instances(geometry, material, parent = group, castShadow = true) {
    ensureVertexColors(geometry);
    geometryPool.add(geometry);
    const transforms = [];
    const bucket = {
      add(x, y, z, sx, sy, sz, angle = 0) {
        if (![x, y, z, sx, sy, sz, angle].every(Number.isFinite)) return;
        position.set(x, y, z);
        scale.set(sx, sy, sz);
        rotation.setFromAxisAngle(UP, angle);
        transforms.push(new THREE.Matrix4().compose(position, rotation, scale));
        detailCount++;
      },
      finish() {
        if (!transforms.length || !material) return;
        const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
        transforms.forEach((transform, i) => mesh.setMatrixAt(i, transform));
        mesh.castShadow = castShadow;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        parent.add(mesh);
      },
    };
    instanceBuckets.push(bucket);
    return bucket;
  }

  const lightTrim = instances(box, trimLight);
  const darkTrim = instances(box, trimDark);
  const finePiers = instances(box, trimLight, group, false);
  const ironwork = instances(box, metal, group, false);
  const roofUnits = instances(box, mechanical);
  const unitCaps = instances(box, trimLight);
  const fanDiscs = instances(cylinder, glassDark, group, false);
  const tankBodies = instances(cylinder, towerWood);
  const tankRoofs = instances(cone, metal);
  const antenna = instances(cylinder, metal);
  const crownMetal = instances(cone, copper);
  const crownSilver = instances(cone, materials.crownSilver || trimLight);
  const clockFaces = instances(new THREE.CircleGeometry(1, 20), trimLight, group, false);
  const pyramidGeometry = new THREE.ConeGeometry(1, 1, 4);
  pyramidGeometry.rotateY(Math.PI / 4);
  const pyramids = instances(pyramidGeometry, copper);

  function rim(ring, elevation, width, depth, bucket = lightTrim) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const length = a.distanceTo(b);
      if (length < 1.3) continue;
      bucket.add((a.x + b.x) / 2, elevation, -(a.y + b.y) / 2,
        length + 0.08, depth, width, Math.atan2(b.y - a.y, b.x - a.x));
    }
  }

  let landCount = 0;
  for (const feature of data.land || []) {
    const rings = localRings(feature.rings, origin);
    if (!rings.length || (feature.kind === 'land' && !options.includeLand)) continue;
    if (feature.kind === 'land') {
      const geometry = flatPolygon(rings, GROUND);
      addBatch(geometry, materials.sidewalk, false);
    } else {
      addBatch(flatPolygon(rings, GROUND + (feature.kind === 'park' ? 0.04 : 0.07)),
        feature.kind === 'park' ? materials.grass : materials.sidewalk, false);
    }
    landCount++;
  }

  let landmarkCount = 0;
  let inferredMassing = 0;
  let roofDetailCount = 0;
  for (const building of data.buildings || []) {
    const rings = localRings(building.rings, origin);
    if (!rings.length) continue;
    const rng = randomFor(building.id || JSON.stringify(building.rings?.[0]?.[0]));
    const height = Math.max(2.8, Math.min(650, Number(building.height) || 14));
    const profile = materials.facadeProfile?.(building) || {
      family: height > 85 ? 'prewar' : 'brick',
      material: materials.facades[hash(building.id) % materials.facades.length],
      floorHeight: 3.6, bayWidth: 3.3, baseHeight: 4.5, roofIndex: hash(building.id) % roofs.length,
    };
    const facade = lod === 2 ? (profile.coarseMaterial || profile.material) : profile.material;
    const roof = roofs[profile.roofIndex % roofs.length] || roofs[0];
    const family = profile.family;
    const appearance = buildingAppearance(building, profile, rings, origin);
    const landmark = landmarkName(building);
    const sections = architecturalSections(building, rings, height, lod, family, rng);
    const selectionParts = [];
    const area = Number(building.area) || Math.abs(THREE.ShapeUtils.area(rings[0]));
    if (landmark) landmarkCount++;
    if (sections.length > 1) inferredMassing++;

    for (let j = 0; j < sections.length; j++) {
      const section = sections[j];
      const base = GROUND + section.from * height;
      const top = GROUND + section.to * height;
      const geometry = section.topRings
        ? loftedPolygon(section.rings, section.topRings, top - base, base, base - GROUND)
        : extrudedPolygon(section.rings, top - base, base, base - GROUND);
      applyBuildingAppearance(geometry, appearance);
      selectionParts.push(geometry);
      addBuildingSection(geometry, facade, roof);
      if (lod >= 2) continue;
      const ring = (section.topRings || section.rings)[0];
      // Shallow real geometry casts the sharp cornice/terrace shadows in the reference.
      const cornice = family === 'prewar' || family === 'stone' || family === 'brick';
      rim(ring, top - 0.20, cornice ? 0.62 : 0.30, cornice ? 0.46 : 0.30, cornice ? lightTrim : darkTrim);
      if (lod === 0 && (j === 0 || sections.length === 1)) {
        const shopTop = GROUND + Math.min(4.6, height * 0.35);
        if (shopTop < top - 1) rim(ring, shopTop, 0.40, 0.22, darkTrim);
        if (cornice && height > 19 && top - base > 15) rim(ring, base + Math.min(11.0, (top - base) * 0.42), 0.40, 0.22, lightTrim);
      }
      if (lod !== 0 || top - base < 10 || section.topRings) continue;
      // Raised masonry piers and fins make vertical window bays read as architecture,
      // rather than a flat repeated image. Detail density is capped per facade edge.
      for (let edge = 0; edge < ring.length; edge++) {
        const a = ring[edge];
        const b = ring[(edge + 1) % ring.length];
        const length = a.distanceTo(b);
        if (length < 7) continue;
        const dx = (b.x - a.x) / length;
        const dy = (b.y - a.y) / length;
        const angle = Math.atan2(dy, dx);
        const offset = 0.14;
        const pierBottom = Math.max(base, GROUND + (profile.baseHeight || 4.5));
        const pierHeight = top - pierBottom - 0.6;
        const pitch = (profile.bayWidth || 3.3) / appearance.scaleU * (height > 90 ? 1 : 2);
        const count = Math.min(28, Math.max(1, Math.floor(length / pitch)));
        if (family !== 'brick' || height > 40) for (let p = 0; p <= count; p++) {
          const t = (p + 0.15) / (count + 0.3);
          finePiers.add(THREE.MathUtils.lerp(a.x, b.x, t) + dy * offset,
            pierBottom + pierHeight / 2, -THREE.MathUtils.lerp(a.y, b.y, t) + dx * offset,
            family === 'glass' ? 0.13 : 0.24, pierHeight, family === 'glass' ? 0.21 : 0.34, angle);
        }
        // A subset of apartment/loft faces gets fine projecting balconies/fire escapes.
        if (j === 0 && (family === 'brick' || family === 'modern') && height > 16 && height < 95 && edge % 3 === 0 && rng() > 0.35) {
          const x = (a.x + b.x) / 2 + dy * 0.53;
          const z = -(a.y + b.y) / 2 + dx * 0.53;
          const pitchY = (profile.floorHeight || 3.6) * (height > 50 ? 2 : 1);
          for (let y = base + 7.2; y < top - 2; y += pitchY) {
            ironwork.add(x, y, z, 2.3, 0.15, 1.05, angle);
            ironwork.add(x + dy * 0.52, y + 0.9, z + dx * 0.52, 2.3, 0.10, 0.08, angle);
            for (const side of [-1, 1]) ironwork.add(x + side * dx * 1.07 + dy * 0.51,
              y + 0.45, z - side * dy * 1.07 + dx * 0.51, 0.06, 0.9, 0.06, angle);
          }
        }
      }
    }

    const selectionGeometry = selectionParts.length === 1 ? selectionParts[0] : mergeGeometries(selectionParts, false);
    if (selectionParts.length > 1) selectionParts.forEach(geometry => geometry.dispose());
    // A single material is intentional: Raycaster uses all indexed faces even though
    // the visible version is split into batches shared by thousands of buildings.
    const pick = new THREE.Mesh(selectionGeometry, facade);
    pick.name = building.name || `NYC building ${building.id}`;
    pick.userData.building = building;
    pick.userData.proceduralDetails = true;
    pick.userData.architecture = { family, landmark: landmark || null, inferredSetbacks: sections.length > 1, measuredHeight: height };
    pick.userData.appearance = {
      tint: appearance.tint, roofTint: appearance.roofTint,
      bayScale: appearance.scaleU, bayOffset: appearance.offsetU,
    };
    pickingGroup.add(pick);
    buildingMeshes.push(pick);
    if (lod >= 2) continue;

    const last = sections[sections.length - 1];
    const topRings = last.topRings || last.rings;
    const top = GROUND + height * last.to;
    const topArea = Math.abs(THREE.ShapeUtils.area(topRings[0]));
    if (landmark && ['empire-state', 'chrysler', 'one-wtc', 'woolworth', 'trinity', 'metlife'].includes(landmark)) {
      const center = roofPoint(topRings, rng, 0.7) || [ringCenter(topRings[0]).x, ringCenter(topRings[0]).y];
      const remaining = height * (1 - last.to);
      if (landmark === 'chrysler') {
        crownSilver.add(center[0], top + remaining * 0.25, -center[1], Math.min(7, Math.sqrt(topArea) * 0.35), remaining * 0.5, Math.min(7, Math.sqrt(topArea) * 0.35));
        antenna.add(center[0], top + remaining * 0.70, -center[1], 0.48, remaining * 0.60, 0.48);
      } else if (landmark === 'trinity') {
        crownMetal.add(center[0], top + remaining / 2, -center[1], Math.min(4.3, Math.sqrt(topArea) * 0.3), remaining, Math.min(4.3, Math.sqrt(topArea) * 0.3));
      } else if (landmark === 'metlife') {
        const r = Math.sqrt(topArea) * 0.56;
        pyramids.add(center[0], top + remaining / 2, -center[1], r, remaining, r);
        const clockRing = sections[Math.min(2, sections.length - 1)].rings[0];
        const edges = clockRing.map((a, i) => ({ a, b: clockRing[(i + 1) % clockRing.length] }))
          .map(edge => ({ ...edge, length: edge.a.distanceTo(edge.b) })).sort((a, b) => b.length - a.length);
        const directions = [];
        for (const edge of edges) {
          if (directions.length >= 4 || edge.length < 8) continue;
          const dx = (edge.b.x - edge.a.x) / edge.length;
          const dy = (edge.b.y - edge.a.y) / edge.length;
          if (directions.some(d => d[0] * dx + d[1] * dy > 0.8)) continue;
          directions.push([dx, dy]);
          const x = (edge.a.x + edge.b.x) / 2 + dy * 0.52;
          const z = -(edge.a.y + edge.b.y) / 2 + dx * 0.52;
          const y = GROUND + height * 0.795;
          const r = Math.min(3.3, edge.length * 0.19);
          const angle = Math.atan2(dy, dx);
          clockFaces.add(x, y, z, r, r, 1, angle);
          ironwork.add(x + dy * 0.06, y + r * 0.26, z + dx * 0.06, 0.18, r * 0.64, 0.11, angle);
          ironwork.add(x + dx * r * 0.20 + dy * 0.06, y, z - dy * r * 0.20 + dx * 0.06, r * 0.55, 0.18, 0.11, angle);
        }
      } else {
        const radius = landmark === 'one-wtc' ? 0.72 : 0.60;
        antenna.add(center[0], top + remaining / 2, -center[1], radius, remaining, radius);
        if (landmark === 'woolworth') crownMetal.add(center[0], top + remaining * 0.35, -center[1], 3.8, remaining * 0.70, 3.8);
      }
    }
    if (lod === 1) {
      const p = topArea > 200 ? roofPoint(topRings, rng, 2.0) : null;
      if (p) roofUnits.add(p[0], top + 0.7, -p[1], 3.4, 1.4, 4.4);
      continue;
    }
    const units = Math.min(7, Math.max(0, Math.floor(topArea / 140)));
    const p = units ? roofPoint(topRings, rng, 3.8) : null;
    for (let u = 0; u < units; u++) {
      const unit = u < 3 && p ? [p[0] + (u - 1) * 3.0, p[1]] : roofPoint(topRings, rng, 2.0);
      if (!unit || !insideRing(unit[0], unit[1], topRings[0])) continue;
      const w = 1.5 + rng() * 1.1;
      const d = 2.1 + rng() * 1.6;
      const h = 0.75 + rng() * 0.65;
      const fitsRoof = [[-1, -1], [-1, 1], [1, -1], [1, 1]].every(([sx, sy]) => {
        const x = unit[0] + sx * w / 2;
        const y = unit[1] + sy * d / 2;
        return insideRing(x, y, topRings[0]) && !topRings.slice(1).some(ring => insideRing(x, y, ring));
      });
      if (!fitsRoof) continue;
      roofUnits.add(unit[0], top + h / 2, -unit[1], w, h, d);
      unitCaps.add(unit[0], top + h + 0.06, -unit[1], w + 0.10, 0.12, d + 0.10);
      fanDiscs.add(unit[0], top + h + 0.14, -unit[1], w * 0.29, 0.07, w * 0.29);
      roofDetailCount++;
    }
    if (!landmark && height > 12 && height < 150 && topArea > 95 && rng() < (family === 'brick' ? 0.49 : 0.30)) {
      const p = roofPoint(topRings, rng, 3.1);
      if (p) {
        const r = 1.35 + rng() * 0.65;
        tankBodies.add(p[0], top + 3.4, -p[1], r, 2.9, r);
        tankRoofs.add(p[0], top + 5.25, -p[1], r + 0.12, 0.85, r + 0.12);
        rim(topRings[0], top + 0.1, 0.22, 0.22, darkTrim);
        for (const x of [-1, 1]) for (const z of [-1, 1]) ironwork.add(p[0] + x * r * 0.59, top + 0.98, -p[1] + z * r * 0.59, 0.16, 1.96, 0.16);
        roofDetailCount++;
      }
    }
    // Low service penthouses supply variety without exceeding the measured silhouette
    // of taller towers; tiny vents/tanks remain identified as decorative details.
    if (sections.length === 1 && area > 300 && !landmark && rng() > 0.4) {
      const p = roofPoint(topRings, rng, 4.0);
      if (p) {
        roofUnits.add(p[0], top + 1.25, -p[1], 5.0, 2.5, 4.0);
        unitCaps.add(p[0], top + 2.54, -p[1], 5.1, 0.12, 4.1);
      }
    }
  }

  const roadMarks = instances(box, materials.roadMark, group, false);
  const streetPoles = instances(cylinder, metal, group, false);
  const streetLamps = instances(box, trimLight, group, false);
  const cars = [];
  let roadCount = 0;
  let elevatedRoads = 0;
  for (const road of data.roads || []) {
    const points = (road.points || []).map(p => [Number(p[0]) - origin[0], Number(p[1]) - origin[1]])
      .filter((p, i, array) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && (!i || Math.hypot(p[0] - array[i - 1][0], p[1] - array[i - 1][1]) > 0.1));
    if (points.length < 2) continue;
    const path = pathInfo(points);
    if (path.length < 0.3) continue;
    const walk = /footway|pedestrian|path|cycleway|steps/.test(road.kind || '');
    const width = Math.max(2, Math.min(32, Number(road.width) || (walk ? 3 : 9)));
    const elevated = road.elevated === true || Number(road.roadType) === 3;
    // Official centerlines establish the crossing. This constant deck clearance is
    // an artistic approximation; there is no source claim about bridge elevations.
    const clearance = elevated ? (Number(road.deckHeight) || (/bridge/i.test(road.name || '') ? 25 : 12)) : 0;
    const street = STREET + clearance;
    if (elevated) {
      const ribbon = roadGeometry(points, width + 3.3, street - 0.08);
      const p = ribbon.attributes.position;
      const outline = [];
      for (let i = 0; i < p.count; i += 2) outline.push([p.getX(i), -p.getZ(i)]);
      for (let i = p.count - 1; i >= 0; i -= 2) outline.push([p.getX(i), -p.getZ(i)]);
      const deck = normalizedRings([outline]);
      if (deck.length) addBatch(extrudedPolygon(deck, 1.0, street - 1.08), trimDark, true);
      ribbon.dispose();
      elevatedRoads++;
    }
    if (lod < 2 || elevated) addBatch(roadGeometry(points, width + (walk ? 0.5 : 3.1), street - 0.035), materials.sidewalk, false);
    addBatch(roadGeometry(points, width, street), walk ? materials.sidewalk : materials.road, false);
    roadCount++;
    if (lod > 0 || walk || road.trafficAllowed === false) continue;
    const sample = {};
    if (width > 7) for (let d = 6; d < path.length - 4; d += 11) {
      samplePath(path, d, 0, 1, sample);
      roadMarks.add(sample.x, street + 0.016, sample.z, 0.16, 0.022, 3.2, sample.angle);
    }
    if (path.length > 35 && width > 7) {
      for (let d = 24; d < path.length - 8; d += 65) {
        samplePath(path, d, width / 2 + 0.8, 1, sample);
        streetPoles.add(sample.x, street + 3.4, sample.z, 0.095, 6.8, 0.095);
        streetLamps.add(sample.x, street + 6.8, sample.z, 0.65, 0.18, 0.95, sample.angle);
      }
    }
    const rng = randomFor(road.id || points[0].join(','));
    const count = Math.min(6, Math.floor(path.length / 75 + rng() * 0.65));
    for (let c = 0; c < count && cars.length < 85; c++) cars.push({ path,
      offset: path.length * (c + rng()) / count,
      speed: 4.5 + rng() * 5.5,
      direction: road.oneway ? 1 : (c % 2 ? -1 : 1),
      street,
      lane: road.oneway ? width * 0.08 : Math.min(2.5, width * 0.22),
      body: Math.floor(rng() * materials.carBodies.length),
      length: 3.8 + rng() * 1.0 });
  }

  let treeCount = 0;
  if (lod < 2) {
    const trunks = instances(new THREE.CylinderGeometry(0.11, 0.20, 1, 5), materials.treeTrunk, treeGroup, lod === 0);
    const leafGeometry = new THREE.IcosahedronGeometry(1, lod === 0 ? 1 : 0);
    const leaves = materials.treeLeaves.map(material => instances(leafGeometry, material, treeGroup, lod === 0));
    for (const tree of data.trees || []) {
      if (!Number.isFinite(tree.x) || !Number.isFinite(tree.y)) continue;
      if (lod === 1 && hash(tree.id || `${tree.x},${tree.y}`) % 3 !== 0) continue;
      const rng = randomFor(tree.id || `${tree.x},${tree.y}`);
      const height = Math.max(5, Math.min(16, Number(tree.height) || 6.5 + rng() * 5));
      const radius = height * (0.21 + rng() * 0.07);
      const x = tree.x - origin[0];
      const z = -(tree.y - origin[1]);
      trunks.add(x, GROUND + height * 0.27, z, 1, height * 0.54, 1);
      const crown = leaves[Math.floor(rng() * leaves.length)];
      crown.add(x, GROUND + height * 0.68, z, radius, height * 0.34, radius, rng() * TAU);
      if (lod === 0 && rng() > 0.4) crown.add(x + radius * 0.36, GROUND + height * 0.56, z + radius * 0.20,
        radius * 0.78, height * 0.26, radius * 0.85, rng() * TAU);
      treeCount++;
    }
  }

  for (const [material, batch] of geometriesToMerge) {
    const geometry = batch.geometries.length === 1 ? batch.geometries[0] : mergeGeometries(batch.geometries, false);
    if (batch.geometries.length > 1) batch.geometries.forEach(g => g.dispose());
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'Material-batched architectural geometry';
    mesh.castShadow = lod < 2 && batch.castShadow;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  instanceBuckets.forEach(bucket => bucket.finish());

  const carMeshes = cars.length ? materials.carBodies.map(material => {
    const mesh = new THREE.InstancedMesh(box, material, cars.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    trafficGroup.add(mesh);
    return mesh;
  }) : [];
  const cabins = cars.length ? new THREE.InstancedMesh(box, materials.carWindows, cars.length) : null;
  if (cabins) {
    cabins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    cabins.castShadow = true;
    cabins.frustumCulled = false;
    trafficGroup.add(cabins);
  }
  const sample = {};
  const bodyCounts = new Array(carMeshes.length).fill(0);
  let elapsed = 0;
  let trafficEnabled = true;
  let disposed = false;
  function carMatrix(mesh, index, x, y, z, sx, sy, sz, angle) {
    position.set(x, y, z);
    scale.set(sx, sy, sz);
    rotation.setFromAxisAngle(UP, angle);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(index, matrix);
  }
  function update(dt = 0, time) {
    if (disposed) return;
    elapsed = Number.isFinite(time) ? time : elapsed + Math.min(Math.max(dt, 0), 0.1);
    if (!trafficEnabled || !cars.length) return;
    bodyCounts.fill(0);
    cars.forEach((car, i) => {
      samplePath(car.path, car.offset + elapsed * car.speed * car.direction, car.lane, car.direction, sample);
      carMatrix(carMeshes[car.body], bodyCounts[car.body]++, sample.x, car.street + 0.61, sample.z, 1.72, 0.68, car.length, sample.angle);
      carMatrix(cabins, i, sample.x, car.street + 1.13, sample.z, 1.39, 0.49, car.length * 0.52, sample.angle);
    });
    carMeshes.forEach((mesh, i) => { mesh.count = bodyCounts[i]; mesh.instanceMatrix.needsUpdate = true; });
    cabins.instanceMatrix.needsUpdate = true;
  }
  update(0, 0);
  group.updateMatrixWorld(true);

  return {
    group,
    buildingMeshes,
    stats: { buildings: buildingMeshes.length, roads: roadCount, trees: treeCount, cars: cars.length,
      land: landCount, lod, landmarks: landmarkCount, inferredMassing, roofDetails: roofDetailCount, instances: detailCount, elevatedRoads },
    update,
    setTraffic(enabled) { trafficEnabled = Boolean(enabled); trafficGroup.visible = trafficEnabled; },
    setTrees(enabled) { treeGroup.visible = Boolean(enabled); },
    dispose() {
      if (disposed) return;
      disposed = true;
      group.traverse(object => {
        if (object.geometry) geometryPool.add(object.geometry);
        if (object.isInstancedMesh) object.dispose();
      });
      geometryPool.forEach(geometry => geometry.dispose());
      group.removeFromParent();
      // Every material belongs to the shared material system, never to this tile.
    },
  };
}

/** Compatibility for callers using a single local-coordinate neighborhood. */
export function createWorld(data, materials) {
  return createTileWorld(data, materials, { lod: 0, includeLand: true });
}
