import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const manifest = JSON.parse(readFileSync(new URL('../public/data/manhattan/manifest.json', import.meta.url)));
async function waitForCity(page) {
  await page.waitForFunction(() => window.__cityWorld?.ready && window.__cityWorld.metrics.pending === 0, null, { timeout: 150000 });
  await expect(page.locator('#error')).toBeHidden();
}
async function visit(page, name) {
  await page.selectOption('#neighborhood', name);
  await page.waitForFunction(() => window.__cityWorld?.state.cameraTween === null);
  await waitForCity(page);
}

test('Manhattan snapshot has complete membership at all three levels', () => {
  expect(manifest.meta.counts.buildings).toBeGreaterThan(44000);
  expect(manifest.meta.counts.trees).toBeGreaterThan(90000);
  expect(manifest.meta.bounds[3]).toBeGreaterThan(40.87);
  expect(manifest.meta.bounds[1]).toBeLessThan(40.71);
  const memberships = [];
  for (const level of manifest.levels) {
    const ids = new Set(); let trees = 0;
    for (const descriptor of level.tiles) {
      const tile = JSON.parse(readFileSync(new URL(`../public/${descriptor.url}`, import.meta.url)));
      assert.equal(tile.meta.lod, level.lod);
      for (const building of tile.buildings) {
        assert.equal(ids.has(building.id), false, `Repeated building ${building.id}`);
        ids.add(building.id);
        assert.ok(building.height > 0, `Missing height ${building.id}`);
        assert.ok(building.rings[0].length >= 4, `Invalid footprint ${building.id}`);
      }
      trees += tile.trees.length;
    }
    expect(ids.size).toBe(manifest.meta.counts.buildings);
    expect(trees).toBe(level.lod === 0 ? manifest.meta.counts.trees : 0);
    memberships.push([...ids].sort());
  }
  expect(memberships[1]).toEqual(memberships[0]);
  expect(memberships[2]).toEqual(memberships[0]);
});

test('WebGPU city renders, streams across Manhattan, and releases old tiles', async ({ page }) => {
  const errors = [], failedRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.url().includes('/data/manhattan/') && !response.ok()) failedRequests.push(response.url()); });
  await page.goto('/'); await waitForCity(page);
  expect(await page.evaluate(() => window.__cityWorld.renderer.backend.isWebGPUBackend)).toBe(true);
  const initial = await page.evaluate(() => window.__cityWorld.metrics);
  expect(initial.levels[0]).toBeGreaterThan(0);
  expect(initial.levels[0]).toBeLessThanOrEqual(16);
  expect(initial.pending).toBe(0); expect(initial.errors).toEqual([]);
  expect(initial.cached).toBeLessThanOrEqual(initial.limit);
  expect(initial.triangles).toBeGreaterThan(50000);
  expect(initial.receivedMB).toBeLessThan(25);
  // Unknown construction dates previously coupled the glass-family choice to
  // its palette index, giving every such tower the same glass material.
  const paletteCohorts = await page.evaluate(() => {
    return [{ height: 180, family: 'glass' }, { height: 180, year: 2010, family: 'glass' }, { height: 30, year: 1960, family: 'stone' }].map(cohort => {
      const counts = {};
      for (let i = 0; i < 1200; i++) {
        const profile = window.__cityWorld.materials.facadeProfile({ id: `palette-regression-${i}`, ...cohort });
        if (profile.family === cohort.family) counts[profile.index] = (counts[profile.index] || 0) + 1;
      }
      return counts;
    });
  });
  for (const cohort of paletteCohorts) {
    expect(Object.keys(cohort).length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...Object.values(cohort))).toBeGreaterThan(30);
  }
  await page.screenshot({ path: 'preview-desktop.png' });

  // Exercise the actual pointer raycast against translated, streamed tile meshes.
  const target = await page.evaluate(() => {
    const city = window.__cityWorld;
    for (const mesh of city.tiles.buildingMeshes) {
      mesh.geometry.computeBoundingBox(); mesh.updateWorldMatrix(true, false);
      const p = mesh.geometry.boundingBox.getCenter(city.controls.target.clone());
      p.applyMatrix4(mesh.matrixWorld).project(city.camera);
      const x = (p.x + 1) * innerWidth / 2, y = (1 - p.y) * innerHeight / 2;
      if (x > 320 && x < innerWidth - 230 && y > 100 && y < innerHeight - 180 && city.pick(x,y) === mesh.userData.building.id) return {x,y,id:mesh.userData.building.id};
    }
  });
  expect(target).toBeTruthy();
  await page.mouse.click(target.x, target.y);
  await expect(page.locator('#inspector')).toBeVisible();
  expect(await page.evaluate(() => window.__cityWorld.selected.id)).toBe(target.id);
  await page.keyboard.press('Escape'); await expect(page.locator('#inspector')).toBeHidden();

  await page.click('#settings-toggle'); await page.uncheck('#traffic'); await page.uncheck('#greenery');
  expect(await page.evaluate(() => [window.__cityWorld.tiles.traffic, window.__cityWorld.tiles.trees])).toEqual([false,false]);
  await page.check('#pixels');
  expect(await page.evaluate(() => window.__cityWorld.state.pixels)).toBe(true);
  await page.uncheck('#pixels'); await page.check('#traffic'); await page.check('#greenery'); await page.click('#settings-close');

  for (const name of ['downtown', 'harlem', 'inwood']) {
    await visit(page, name);
    const metrics = await page.evaluate(() => window.__cityWorld.metrics);
    expect(metrics.visible).toBeGreaterThan(0); expect(metrics.cached).toBeLessThanOrEqual(metrics.limit);
    expect(metrics.errors).toEqual([]); expect(metrics.levels[0]).toBeLessThanOrEqual(16);
    if (name === 'downtown') await page.screenshot({ path: 'preview-downtown.png' });
  }
  expect(await page.evaluate(() => window.__cityWorld.metrics.evictions)).toBeGreaterThan(0);
  await visit(page, 'overview');
  const overview = await page.evaluate(() => window.__cityWorld.metrics);
  expect(overview.levels[0]).toBe(0); expect(overview.levels[1]).toBe(0);
  expect(overview.levels[2]).toBe(manifest.levels.find(level => level.lod === 2).tiles.length);
  expect(overview.buildings).toBe(manifest.meta.counts.buildings);
  expect(overview.cached).toBeLessThanOrEqual(overview.limit);
  await page.screenshot({ path: 'preview-manhattan.png' });
  expect(errors).toEqual([]); expect(failedRequests).toEqual([]);
});

test('mobile controls and source disclosure stay accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); await waitForCity(page);
  await expect(page.locator('#neighborhood')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'preview-mobile.png' });
  await page.click('#settings-toggle'); await expect(page.locator('#settings')).toBeVisible();
  await page.locator('#sunlight').evaluate(input => { input.value = '18'; input.dispatchEvent(new Event('input', {bubbles:true})); });
  await expect(page.locator('#time-label')).toHaveText('18:00');
  await page.click('#settings-close'); await page.click('#about-toggle');
  await expect(page.locator('#about-dialog')).toBeVisible();
  await expect(page.locator('#source-list a')).toHaveCount(manifest.meta.sources.length);
  await expect(page.locator('#about-dialog')).toContainText('procedural interpretations');
  await expect(page.locator('#about-dialog')).toContainText('WebGPU');
  await page.click('#about-close');
});
