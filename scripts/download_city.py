#!/usr/bin/env python3
"""Download official NYC data and clip a reproducible 1 km² pilot scene.

Install: python -m pip install -r scripts/requirements-geo.txt
Run:     python scripts/download_city.py
The renderer uses [x, elevation, -y] for these local east/north coordinates.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import requests
from pyproj import CRS, Transformer
from requests.adapters import HTTPAdapter
from shapely import make_valid, transform
from shapely.geometry import box, shape
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from urllib3.util.retry import Retry


ROOT = Path(__file__).resolve().parent.parent
CENTER = (-74.0116, 40.7043)  # longitude, latitude; The Battery + Financial District
SIZE = 1000.0
FOOT_TO_M = 0.3048
CITY_LICENSE = "NYC Open Data Terms of Use (see source metadata)"
BUILDINGS_URL = (
    "https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/"
    "BUILDING_view/FeatureServer/0/query"
)
SOCRATA = "https://data.cityofnewyork.us/resource/"
SOURCE_DEFINITIONS = [
    {
        "key": "buildings",
        "name": "NYC OTI Building Footprints",
        "url": "https://nycmaps-nyc.hub.arcgis.com/datasets/nyc::building/about",
        "api": BUILDINGS_URL,
        "license": CITY_LICENSE,
    },
    {
        "key": "roads",
        "name": "NYC Street Centerline (CSCL)",
        "url": "https://data.cityofnewyork.us/d/inkn-q76z",
        "api": SOCRATA + "inkn-q76z.geojson",
        "license": CITY_LICENSE,
    },
    {
        "key": "land",
        "name": "NYC DCP Borough Boundaries, water excluded",
        "url": "https://data.cityofnewyork.us/d/gthc-hcne",
        "api": SOCRATA + "gthc-hcne.geojson",
        "license": CITY_LICENSE,
    },
    {
        "key": "parks",
        "name": "NYC Parks Properties",
        "url": "https://data.cityofnewyork.us/d/enfh-gkve",
        "api": SOCRATA + "enfh-gkve.geojson",
        "license": CITY_LICENSE,
    },
    {
        "key": "trees",
        "name": "NYC Parks Forestry Tree Points",
        "url": "https://data.cityofnewyork.us/d/hn5i-inap",
        "api": SOCRATA + "hn5i-inap.geojson",
        "license": CITY_LICENSE,
    },
]


def number(value, default=0.0):
    try:
        return float(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def parts(geometry, kind):
    """Walk repaired collections without losing polygon holes or islands."""
    if geometry.is_empty:
        return
    if geometry.geom_type == kind:
        yield geometry
    elif hasattr(geometry, "geoms"):
        for item in geometry.geoms:
            yield from parts(item, kind)


def xy(coordinates):
    return [[round(point[0], 2), round(point[1], 2)] for point in coordinates]


def rings(polygon):
    polygon = orient(polygon, sign=1.0)
    return [xy(polygon.exterior.coords)] + [xy(ring.coords) for ring in polygon.interiors]


class Downloader:
    def __init__(self, cache_dir: Path | None):
        self.cache_dir = cache_dir
        if cache_dir:
            cache_dir.mkdir(parents=True, exist_ok=True)

    def get(self, url, parameters):
        request_url = requests.Request("GET", url, params=parameters).prepare().url
        cache_path = None
        if self.cache_dir:
            digest = hashlib.sha256(request_url.encode()).hexdigest()[:24]
            cache_path = self.cache_dir / (digest + ".json")
            if cache_path.exists():
                return json.loads(cache_path.read_text())
        # Each request owns its session because independent layers run concurrently.
        with requests.Session() as session:
            retry = Retry(total=3, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504])
            session.mount("https://", HTTPAdapter(max_retries=retry))
            session.headers["User-Agent"] = "NYC-1km-stylized-world-pilot/1.0"
            response = session.get(url, params=parameters, timeout=90)
            response.raise_for_status()
            result = response.json()
        if result.get("error") or "features" not in result:
            raise RuntimeError(f"Invalid geodata response from {url}: {str(result)[:300]}")
        if cache_path:
            cache_path.write_text(json.dumps(result))
        return result

    def layer(self, source, bbox):
        west, south, east, north = bbox
        polygon = (
            f"POLYGON (({west} {south},{east} {south},"
            f"{east} {north},{west} {north},{west} {south}))"
        )
        key = source["key"]
        features = []
        offset = 0
        while True:
            if key == "buildings":
                limit = 2000
                params = {
                    "f": "geojson", "where": "1=1",
                    "geometry": f"{west},{south},{east},{north}",
                    "geometryType": "esriGeometryEnvelope", "inSR": "4326",
                    "spatialRel": "esriSpatialRelIntersects", "outFields": "*",
                    "outSR": "4326", "resultRecordCount": limit,
                    "resultOffset": offset, "orderByFields": "OBJECTID ASC",
                }
            else:
                limit = 5000
                if key == "land":
                    where = "borocode=1"
                elif key == "trees":
                    # Full standing trees only: removed/stump records are not vegetation.
                    where = f"within_box(location,{north},{west},{south},{east}) AND tpstructure='Full'"
                elif key == "parks":
                    where = f"intersects(multipolygon, '{polygon}') AND retired=false"
                else:
                    where = f"intersects(the_geom, '{polygon}')"
                params = {"$where": where, "$limit": limit, "$offset": offset}
            page = self.get(source["api"], params)
            batch = page["features"]
            features.extend(batch)
            if len(batch) < limit and not page.get("exceededTransferLimit"):
                break
            offset += limit
        print(f"Downloaded {key}: {len(features)} source features", flush=True)
        return key, features


def build_scene(raw, forward, square):
    project = lambda geom: transform(shape(geom), forward.transform, interleaved=False)
    project_polygon = lambda geom: make_valid(project(geom)).intersection(square)

    # This is an actual shoreline-clipped borough boundary, not an invented coast.
    land_geometry = unary_union([project_polygon(f["geometry"]) for f in raw["land"]])
    if land_geometry.is_empty or land_geometry.area >= square.area * 0.995:
        raise RuntimeError("Missing shoreline: the pilot must contain both real land and water")
    land = [
        {"id": f"shoreline-{i}", "name": "Manhattan", "kind": "land", "rings": rings(p)}
        for i, p in enumerate(parts(land_geometry, "Polygon")) if p.area > 0.1
    ]
    for feature in raw["parks"]:
        props = feature["properties"]
        geometry = project_polygon(feature["geometry"]).intersection(land_geometry)
        name = props.get("name311") or props.get("signname") or "NYC park"
        kind = "plaza" if "plaza" in (props.get("typecategory") or "").lower() else "park"
        for i, polygon in enumerate(parts(geometry, "Polygon")):
            if polygon.area > 1:
                land.append({
                    "id": f"park-{props['gispropnum']}-{i}", "name": name,
                    "kind": kind, "rings": rings(polygon),
                })

    buildings = []
    placeholders = 0
    for feature in raw["buildings"]:
        props = feature["properties"]
        # Permitted-building placeholder triangles are not actual building outlines.
        if props.get("FEATURE_CODE") == 1003:
            placeholders += 1
            continue
        measured = number(props.get("HEIGHT_ROOF"))
        measured_m = measured * FOOT_TO_M
        estimated = measured <= 0
        # Conservative, explicitly estimated fallback for the few missing heights.
        height = measured_m if not estimated else (4.0 if props.get("FEATURE_CODE") == 2110 else 12.0)
        geometry = project_polygon(feature["geometry"])
        for i, polygon in enumerate(parts(geometry, "Polygon")):
            if polygon.area < 0.25:
                continue
            buildings.append({
                "id": f"nyc-{props['DOITT_ID']}-{i}",
                "name": props.get("NAME") or "",
                "height": round(height, 2),
                "heightSource": "estimated default" if estimated else "NYC HEIGHT_ROOF",
                "heightEstimated": estimated,
                "heightFeetOriginal": measured if not estimated else None,
                "groundElevation": round(number(props.get("GROUND_ELEVATION")) * FOOT_TO_M, 2),
                "levels": max(1, round(height / 3.4)),
                "levelsSource": "estimated from height; not an observed floor count",
                "rings": rings(polygon),
                "centroid": xy([polygon.representative_point().coords[0]])[0],
                "area": round(polygon.area, 1),
                "bin": props.get("BIN"), "bbl": props.get("MAPPLUTO_BBL"),
                "year": props.get("CONSTRUCTION_YEAR"),
                "featureCode": props.get("FEATURE_CODE"),
                "status": props.get("LAST_STATUS_TYPE"),
                "geometrySource": props.get("GEOM_SOURCE"),
            })

    roads = []
    excluded_roads = 0
    for feature in raw["roads"]:
        props = feature["properties"]
        road_type = int(number(props.get("rw_type")))
        name = props.get("stname_label") or props.get("full_street_name") or "Unnamed path"
        # CSCL includes ferry/tunnel routes. Rendering these on the surface is wrong.
        if road_type in (4, 12, 14) or any(s in name.upper() for s in ("TUNNEL", "TUNL", "TNNL", "UNDERPASS", "FERRY")):
            excluded_roads += 1
            continue
        pedestrian = road_type in (5, 6, 7) or props.get("trafdir") == "NV"
        kind = "path" if pedestrian else "highway" if road_type == 2 else "ramp" if road_type == 9 else "street"
        measured_width = number(props.get("streetwidth")) * FOOT_TO_M
        # CSCL widths are in feet; fallback widths are visual assumptions.
        width = measured_width if measured_width > 0 else (3.0 if pedestrian else 9.0)
        geometry = project(feature["geometry"]).intersection(square)
        # Keep path centerlines on actual land; tiny shoreline mismatch is tolerated.
        geometry = geometry.intersection(land_geometry.buffer(2))
        for i, line in enumerate(parts(geometry, "LineString")):
            if line.length < 1:
                continue
            points = xy(line.coords)
            direction = props.get("trafdir")
            if direction == "TF":
                points.reverse()
            roads.append({
                "id": f"cscl-{props['objectid']}-{i}", "name": name,
                "points": points, "width": round(width, 2),
                "widthSource": "NYC CSCL streetwidth" if measured_width > 0 else "estimated default",
                "kind": kind, "oneway": direction in ("FT", "TF"),
                "trafficAllowed": not pedestrian,
                "lanes": int(number(props.get("number_travel_lanes"), 1)),
                "roadType": road_type,
            })

    trees = []
    seen_spaces = set()
    for feature in raw["trees"]:
        props = feature["properties"]
        planting_space = props.get("plantingspaceglobalid")
        point = project(feature["geometry"])
        if not square.covers(point) or not land_geometry.buffer(2).covers(point):
            continue
        if planting_space and planting_space in seen_spaces:
            continue
        seen_spaces.add(planting_space)
        trees.append({
            "id": f"nyctree-{props['objectid']}",
            "x": round(point.x, 2), "y": round(point.y, 2),
            "species": props.get("genusspecies") or "Unknown",
            "dbhInches": number(props.get("dbh")),
            "condition": props.get("tpcondition"), "source": "NYC Parks inventory",
        })
    return buildings, roads, land, trees, placeholders, excluded_roads, land_geometry.area


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "public/data/city.json")
    parser.add_argument("--cache", type=Path, help="Optional raw-response cache directory")
    args = parser.parse_args()
    local = CRS.from_proj4(
        f"+proj=aeqd +lat_0={CENTER[1]} +lon_0={CENTER[0]} +datum=WGS84 +units=m +no_defs"
    )
    forward = Transformer.from_crs("EPSG:4326", local, always_xy=True)
    reverse = Transformer.from_crs(local, "EPSG:4326", always_xy=True)
    square = box(-SIZE / 2, -SIZE / 2, SIZE / 2, SIZE / 2)
    corners = [reverse.transform(x, y) for x, y in square.exterior.coords]
    bounds = [min(p[0] for p in corners), min(p[1] for p in corners),
              max(p[0] for p in corners), max(p[1] for p in corners)]
    # Query slightly beyond the square's WGS84 envelope, then clip exactly in meters.
    bbox = [bounds[0] - .00002, bounds[1] - .00002, bounds[2] + .00002, bounds[3] + .00002]
    downloader = Downloader(args.cache)
    with ThreadPoolExecutor(max_workers=5) as executor:
        raw = dict(executor.map(lambda source: downloader.layer(source, bbox), SOURCE_DEFINITIONS))
    buildings, roads, land, trees, placeholders, excluded_roads, land_area = build_scene(raw, forward, square)
    scene = {
        "meta": {
            "name": "The Battery + Financial District", "center": list(CENTER),
            "bounds": [round(v, 8) for v in bounds], "size": int(SIZE), "areaKm2": 1,
            "landAreaKm2": round(land_area / 1e6, 4),
            "coordinateSystem": "Local azimuthal equidistant, meters; x east, y north; renderer z=-y",
            "localExtent": [-500, -500, 500, 500],
            "sources": SOURCE_DEFINITIONS,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "notes": [
                "Exactly 1,000 × 1,000 local meters; the crop includes real land and harbor water.",
                "Real NYC building footprints extruded to HEIGHT_ROOF, converted from feet to meters; this pilot does not use LoD2 roof meshes.",
                "Missing or zero roof heights use a marked estimated default. Floor counts are visual estimates derived from height.",
                "Terrain is flattened for this style prototype; source ground elevations are retained as attributes.",
                "Road centerlines and available street widths are real CSCL data. Unavailable widths use marked estimates; ferry and underground tunnel routes are excluded.",
                "Tree positions/species are real standing-tree inventory records, deduplicated by planting space; tree mesh dimensions are stylized.",
                "Parks are jurisdiction/property polygons and may include paved areas; their green rendering is an artistic simplification.",
                "Cars, lighting, facade detail, and any pedestrians are procedural visual effects, not live observations.",
                f"Excluded {placeholders} placeholder footprints and {excluded_roads} ferry/tunnel/nonexistent road features.",
                "NYC datasets have different collection/update dates and are not a synchronized survey; this file records the acquisition date.",
            ],
            "counts": {"buildings": len(buildings), "roads": len(roads), "land": len(land),
                       "trees": len(trees), "estimatedHeights": sum(b["heightEstimated"] for b in buildings)},
        },
        "buildings": buildings, "roads": roads, "land": land, "trees": trees,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(scene, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(json.dumps(scene["meta"]["counts"], indent=2))
    print(f"Saved {args.output} ({args.output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
