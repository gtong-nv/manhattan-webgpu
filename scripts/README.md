# Real geodata for the NYC pilot

`download_city.py` fetches public official NYC data and writes `public/data/city.json`.
It clips every geometry to an exact 1,000 m × 1,000 m local square centered on
40.7043° N, 74.0116° W, covering The Battery and the Financial District.

```bash
python -m venv /tmp/nyc-geodata-venv
/tmp/nyc-geodata-venv/bin/pip install -r scripts/requirements-geo.txt
/tmp/nyc-geodata-venv/bin/python scripts/download_city.py
```

Optional: `--cache /tmp/nyc-geodata-cache` caches raw responses by request URL.
Delete that cache when a fresh acquisition is desired. The committed scene is a
download snapshot; rerunning without a cache may reflect updated source records.

The downloaded data has no OpenStreetMap or commercial basemap dependencies.
Sources are NYC OTI Building Footprints, NYC CSCL street centerlines, DCP borough
boundaries with water excluded, NYC Parks Properties, and NYC Parks Forestry Tree
Points. Source URLs and usage terms are embedded in `meta.sources`. See the
[NYC Open Data FAQ](https://www.nyc.gov/opendata/get-started/FAQs) and each source's
metadata. Credit the City of New York and the named agencies in a published viewer.

Coordinates are local meters, **x east, y north**, using an azimuthal equidistant
projection. `meta.size` and `meta.localExtent` describe the exact crop;
`meta.bounds` is its enclosing WGS84 longitude/latitude box. A Three.js renderer
should map a point to `[x, elevation, -y]`. Polygon `rings[0]` is the exterior and
subsequent rings are holes. Disconnected polygons get separate records.

Building heights use the official `HEIGHT_ROOF` feet-above-ground attribute,
converted to meters. Missing heights remain explicitly marked estimates, and
`levels` is always a visual estimate from height. Source ground elevation is kept
but terrain is flat. Placeholder footprint triangles are omitted. Roads use real
centerlines and widths when available, with estimated widths marked; underground
tunnels and ferry routes are excluded. Road point order follows permitted travel
where one-way direction is known. Tree positions/species come from full standing
tree records, deduplicated by planting space. Park polygons identify property,
not precisely grass. Cars and facade detail in the viewer are procedural.

The source datasets have different vintages. This download is not a synchronized
survey or a game-ready model of every rooftop. Water comes from the complement of
the real shoreline polygon within the crop, not a hand-drawn coast.

## Whole-Manhattan streaming dataset

```bash
/tmp/nyc-geodata-venv/bin/python scripts/build_manhattan.py --cache /tmp/nyc-manhattan-cache
```

This preserves the earlier `city.json` and writes
`public/data/manhattan/manifest.json` plus independently loadable spatial tiles.
Use `--acquire-only` to finish/resume source downloads without generating tiles.
The default cache is `/tmp/nyc-manhattan-cache`; preserve it to resume interrupted
downloads. Delete the cache to acquire a new source snapshot. Independent source
requests use four workers by default, with retries and response caching.

The center is `[-73.9712, 40.7831]` (longitude, latitude). All feature coordinates
remain **global local meters** in that one AEQD frame. Each tile's `meta.origin`
is a rendering origin, not a coordinate subtraction already applied to features.

The manifest includes 500 m LOD0 tiles, 1,000 m LOD1 tiles, and 2,000 m LOD2 tiles
on an aligned hierarchy. Full-detail tiles contain every acquired building, road,
park and standing tree. More distant levels simplify building outlines, omit
trees and pedestrian paths, and select broader roads. A building's complete
silhouette is assigned once per level to the tile containing its centroid;
buildings may cross a tile boundary and are never sliced at that boundary. Road
and ground geometry is clipped at tile boundaries. `overview.land` supplies
Manhattan geographic context before tiles load. `overview.contextLand` contains
only neighboring NYC borough shoreline polygons, excluded from Manhattan counts
and detail tiles. New Jersey geographic context is not included.

Each manifest tile descriptor also supplies `contentBounds`, the union of its
tile square and complete building footprints, plus `maxHeight`, its tallest
building roof height plus a 15 m margin. These let the viewer cull distant content
without losing buildings that cross tile boundaries.

Buildings use official Manhattan tax-lot prefix `BASE_BBL LIKE '1%'`, including
source borough islands and Marble Hill. CSCL roads use `boroughcode='1'`.
Standing trees are downloaded in the borough's enclosing box, then spatially
filtered against the actual borough shoreline with a 3 m alignment tolerance.
The builder checks source counts against every downloaded page; incomplete
downloads fail rather than silently producing partial borough coverage.
Bridge centerlines retain actual spans over water; their deck elevations and
structures require a rendering approximation or additional engineering geometry.
Ten landmark identities are tagged to existing measured footprints. The MetLife
clock tower uses the LPC building database's BIN, avoiding adjacent buildings with
similar names; source roof height remains distinct from any decorative spire.

Run `python scripts/validate_manhattan.py` in the same environment to verify every
polygon, tile bounds, complete and unique building coverage at each LOD, and tree
membership. The generated hierarchy currently has 498 tile files: 350 LOD0 tiles,
109 LOD1 tiles, and 39 LOD2 tiles, plus the manifest.

The 2014 CityGML model is not used by this generation. Its ~894 MB whole-city
archive is an older one-time survey, with hybrid LoD1/2 massing and about 100
detailed landmark buildings. Building roof heights and current footprints remain
the measured authority here. Renderer roof/crown details are artistic overrides.
