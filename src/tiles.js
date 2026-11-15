import * as THREE from 'three/webgpu';
import { createTileWorld } from './world.js';

// Only the manifest and coastline are global. Every building arrives through a
// bounded tile request, and GPU resources are released when its LRU entry leaves.
export class TileManager {
  constructor(manifest, scene, materials, { maxCached = 72, concurrency = 4 } = {}) {
    this.manifest = manifest;
    this.scene = scene;
    this.materials = materials;
    this.maxCached = maxCached;
    this.concurrency = concurrency;
    this.cache = new Map();
    this.wanted = new Map();
    this.roots = [];
    this.plans = [];
    this.buildQueue = [];
    this.fetching = 0;
    this.traffic = true;
    this.trees = true;
    this.evictions = 0;
    this.receivedBytes = 0;
    this.disposed = false;
    this.errors = new Map();
    this.lastSelection = -Infinity;
    this.visibleEntries = [];
    this.refined = new Set();
    this.frustum = new THREE.Frustum();
    this.projection = new THREE.Matrix4();
    const levels = [...manifest.levels].sort((a, b) => a.lod - b.lod);
    const maps = new Map();
    for (const level of levels) {
      const nodes = new Map();
      for (const descriptor of level.tiles) {
        const [x0, y0, x1, y1] = descriptor.bounds;
        const [cx0, cy0, cx1, cy1] = descriptor.contentBounds ?? [x0 - 100, y0 - 100, x1 + 100, y1 + 100];
        const node = {
          ...descriptor, lod: level.lod, tileSize: level.tileSize,
          key: `${level.lod}/${descriptor.id}`, children: [],
          x: (x0 + x1) / 2, y: (y0 + y1) / 2,
          box: new THREE.Box3(new THREE.Vector3(cx0, -10, -cy1), new THREE.Vector3(cx1, descriptor.maxHeight ?? 650, -cy0)),
        };
        nodes.set(`${Math.floor(node.x / level.tileSize)},${Math.floor(node.y / level.tileSize)}`, node);
      }
      maps.set(level.lod, nodes);
    }
    for (let i = 0; i < levels.length - 1; i++) {
      const parentSize = levels[i + 1].tileSize;
      for (const node of maps.get(levels[i].lod).values()) {
        const parent = maps.get(levels[i + 1].lod).get(`${Math.floor(node.x / parentSize)},${Math.floor(node.y / parentSize)}`);
        if (parent) parent.children.push(node);
      }
    }
    this.roots = [...maps.get(levels.at(-1).lod).values()];
  }

  select(camera, target, viewportHeight, now = performance.now(), force = false) {
    if (this.disposed) return;
    if (!force && now - this.lastSelection < 240) return;
    this.lastSelection = now;
    camera.updateMatrixWorld();
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection, camera.coordinateSystem);
    const pixelsPerMeter = viewportHeight * camera.zoom / (camera.top - camera.bottom);
    const wanted = new Map();
    const nextRefined = new Set();
    let detailBudget = 16;
    const distance = node => Math.hypot(node.x - target.x, node.y + target.z);
    const gather = node => {
      // Large, distant districts stay coarse even when a skyscraper extends into
      // the view. A small hysteresis band prevents thrashing at zoom boundaries.
      const wasFine = this.refined.has(node.key) ? 1.1 : 0.95;
      const refine = node.children.length && node.tileSize * pixelsPerMeter * wasFine > 660 &&
        (node.lod > 1 || distance(node) < 1250);
      if (refine) {
        const children = node.children.filter(child => this.frustum.intersectsBox(child.box)).sort((a, b) => distance(a) - distance(b));
        if (children.length && (node.lod > 1 || children.length <= detailBudget)) {
          if (node.lod === 1) detailBudget -= children.length;
          nextRefined.add(node.key);
          return children.flatMap(gather);
        }
      }
      return [node];
    };
    this.plans = [];
    for (const root of [...this.roots].sort((a, b) => distance(a) - distance(b))) {
      if (!this.frustum.intersectsBox(root.box)) continue;
      const leaves = gather(root);
      this.plans.push({ root, leaves });
    }
    // An ultrawide or oblique view can intersect many more districts than a
    // typical screen. Coarsen distant plans before they exceed the cache budget.
    const plannedCount = () => this.plans.reduce((sum, plan) => sum + (plan.leaves[0] === plan.root ? 1 : plan.leaves.length + 1), 0);
    for (const plan of [...this.plans].reverse()) {
      if (plannedCount() <= this.maxCached - 4) break;
      plan.leaves = [plan.root];
    }
    for (const { root, leaves } of this.plans) {
      wanted.set(root.key, { node: root, priority: distance(root) - 20000 });
      for (const node of leaves) wanted.set(node.key, { node, priority: distance(node) - (node.lod === 2 ? 20000 : 0) });
    }
    this.refined = nextRefined;
    this.wanted = wanted;
    for (const [key, entry] of this.cache) {
      if (!wanted.has(key) && entry.status === 'fetching') entry.controller.abort();
    }
    this.buildQueue = this.buildQueue.filter(entry => {
      if (wanted.has(entry.node.key)) return true;
      this.cache.delete(entry.node.key);
      entry.data = null;
      return false;
    });
    this.applyVisibility(now);
    this.pumpRequests();
  }

  pumpRequests() {
    if (this.disposed) return;
    const candidates = [...this.wanted.values()].sort((a, b) => a.priority - b.priority);
    for (const { node } of candidates) {
      if (this.fetching >= this.concurrency || this.buildQueue.length >= 6) break;
      if (this.cache.has(node.key)) continue;
      const failure = this.errors.get(node.key);
      if (failure && performance.now() - failure.time < 30000) continue;
      if (this.cache.size >= this.maxCached) {
        const spare = [...this.cache.values()].filter(entry => entry.status === 'ready' && !this.wanted.has(entry.node.key) && !entry.world.group.visible).sort((a,b) => a.lastUsed - b.lastUsed)[0];
        if (!spare) break;
        this.scene.remove(spare.world.group); spare.world.dispose();
        this.cache.delete(spare.node.key); this.evictions++;
      }
      this.request(node);
    }
  }

  async request(node) {
    if (this.disposed) return;
    const entry = { node, status: 'fetching', controller: new AbortController(), lastUsed: performance.now(), world: null };
    this.cache.set(node.key, entry);
    this.fetching++;
    try {
      const url = new URL(node.url.replace(/^\//, ''), new URL(import.meta.env.BASE_URL, location.href));
      const response = await fetch(url, { signal: entry.controller.signal });
      if (!response.ok) throw new Error(`Tile ${node.id}: HTTP ${response.status}`);
      const body = await response.text();
      this.receivedBytes += new TextEncoder().encode(body).byteLength;
      if (!this.wanted.has(node.key)) { this.cache.delete(node.key); return; }
      entry.data = JSON.parse(body);
      entry.status = 'queued';
      this.buildQueue.push(entry);
      this.errors.delete(node.key);
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.warn('City tile could not be loaded:', error);
        this.errors.set(node.key, { time: performance.now(), message: error.message });
      }
      this.cache.delete(node.key);
    } finally {
      this.fetching--;
      this.pumpRequests();
    }
  }

  tick(dt, elapsed, now = performance.now()) {
    if (this.disposed) return;
    // Construct at most one tile each frame; network concurrency cannot cause a
    // burst of geometry allocation. Low detail parents are constructed first.
    if (this.buildQueue.length) {
      this.buildQueue.sort((a, b) => (this.wanted.get(a.node.key)?.priority ?? Infinity) - (this.wanted.get(b.node.key)?.priority ?? Infinity));
      const entry = this.buildQueue.shift();
      try {
        entry.world = createTileWorld(entry.data, this.materials, { lod: entry.node.lod });
        entry.world.group.visible = false;
        entry.world.setTraffic(this.traffic);
        entry.world.setTrees(this.trees);
        this.scene.add(entry.world.group);
        entry.world.group.updateMatrixWorld(true);
        entry.data = null;
        entry.status = 'ready';
      } catch (error) {
        console.error('Tile geometry failed:', entry.node.key, error);
        this.errors.set(entry.node.key, { time: now, message: error.message });
        this.cache.delete(entry.node.key);
      }
      this.applyVisibility(now);
      this.pumpRequests();
    }
    for (const entry of this.visibleEntries) entry.world.update(dt, elapsed);
  }

  applyVisibility(now) {
    const visible = new Set();
    for (const { root, leaves } of this.plans) {
      const complete = leaves.every(node => this.cache.get(node.key)?.status === 'ready');
      if (complete) for (const leaf of leaves) visible.add(leaf.key);
      else if (this.cache.get(root.key)?.status === 'ready') visible.add(root.key);
      // During first load, individual ready tiles are better than a blank area.
      else for (const leaf of leaves) if (this.cache.get(leaf.key)?.status === 'ready') visible.add(leaf.key);
    }
    this.visibleEntries = [];
    for (const [key, entry] of this.cache) {
      if (!entry.world) continue;
      entry.world.group.visible = visible.has(key);
      if (visible.has(key)) this.visibleEntries.push(entry);
      if (visible.has(key) || this.wanted.has(key)) entry.lastUsed = now;
    }
    // This is a ceiling on retained tiles. Currently needed tiles are protected
    // from eviction; their count is separately bounded by the LOD selection.
    const spare = [...this.cache.values()].filter(entry => entry.status === 'ready' && !this.wanted.has(entry.node.key) && !visible.has(entry.node.key)).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.cache.size > this.maxCached && spare.length) {
      const entry = spare.shift();
      this.scene.remove(entry.world.group);
      entry.world.dispose();
      this.cache.delete(entry.node.key);
      this.evictions++;
    }
  }

  setTraffic(value) { this.traffic = value; for (const entry of this.cache.values()) entry.world?.setTraffic(value); }
  setTrees(value) { this.trees = value; for (const entry of this.cache.values()) entry.world?.setTrees(value); }
  get buildingMeshes() { return this.visibleEntries.flatMap(entry => entry.world.buildingMeshes); }
  get stats() {
    const levels = [0, 0, 0];
    let buildings = 0, cars = 0, trees = 0;
    for (const entry of this.visibleEntries) {
      levels[entry.node.lod]++;
      const stats = entry.world.stats;
      buildings += stats.buildings ?? entry.node.counts?.buildings ?? 0;
      cars += stats.cars ?? 0;
      trees += stats.trees ?? 0;
    }
    return {
      visible: this.visibleEntries.length, cached: this.cache.size, limit: this.maxCached,
      pending: [...this.wanted.keys()].filter(key => this.cache.get(key)?.status !== 'ready').length,
      fetching: this.fetching, queued: this.buildQueue.length, levels, buildings, cars, trees,
      receivedMB: this.receivedBytes / 1048576, evictions: this.evictions,
      errors: [...this.errors].filter(([key]) => this.wanted.has(key)).map(([, value]) => value.message),
    };
  }
  dispose() {
    this.disposed = true;
    this.wanted.clear(); this.plans.length = 0; this.visibleEntries.length = 0;
    for (const entry of this.cache.values()) { entry.controller.abort(); if (entry.world) { this.scene.remove(entry.world.group); entry.world.dispose(); } }
    this.cache.clear();
    this.buildQueue.length = 0;
  }
}
