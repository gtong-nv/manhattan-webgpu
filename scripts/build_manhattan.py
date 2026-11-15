#!/usr/bin/env python3
"""Acquire official Manhattan geodata and build three offline spatial LODs.

python -m pip install -r scripts/requirements-geo.txt
python scripts/build_manhattan.py --cache /tmp/nyc-manhattan-cache

The earlier 1 km² public/data/city.json snapshot is deliberately preserved.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import time

import requests
from pyproj import CRS, Transformer
from requests.adapters import HTTPAdapter
from shapely import make_valid, transform
from shapely.geometry import Point, Polygon, box, shape
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from shapely.prepared import prep
from urllib3.util.retry import Retry

from download_city import SOURCE_DEFINITIONS, BUILDINGS_URL, SOCRATA, number, parts, xy

ROOT = Path(__file__).resolve().parent.parent
CENTER = (-73.9712, 40.7831)
FOOT_TO_M = 0.3048
LANDMARKS = [
    (r"empire state", "empire-state"), (r"chrysler", "chrysler"),
    (r"^(1|one) world trade|freedom tower", "one-wtc"),
    (r"woolworth", "woolworth"), (r"flatiron", "flatiron"),
    (r"^(30 rockefeller plaza|comcast building|ge building|rca building)$", "rockefeller"),
    (r"metropolitan life|met.?life tower|metropolitan life insurance", "metlife"),
    (r"trinity church", "trinity"), (r"castle clinton", "castle-clinton"),
    (r"new york stock exchange", "nyse"),
]
KNOWN_LANDMARK_POINTS = [
    ("one-wtc", "One World Trade Center", -74.01338, 40.71274, 200),
    ("rockefeller", "30 Rockefeller Plaza", -73.97919, 40.75874, 150),
]
LANDMARK_BIN_IDENTITIES = {
    # NYC LPC building database: 1 Madison Avenue, Block 853 Lot 1, built 1907–09.
    "1016741": ("metlife", "Metropolitan Life Insurance Company Tower"),
}
LPC_SOURCE = {
    "name": "NYC LPC Individual Landmark and Historic District Building Database",
    "url": "https://data.cityofnewyork.us/d/gpmc-yuvp",
    "api": "https://data.cityofnewyork.us/resource/gpmc-yuvp.json",
    "license": "NYC Open Data Terms of Use (see source metadata)",
}


def rings(polygon):
    """Compact coordinates without making a valid narrow polygon self-intersect.

    Most data safely uses centimeter precision; slivers and nearly touching edges
    retain higher precision rather than introducing invalid renderer geometry.
    """
    polygon = orient(polygon, sign=1)
    original = [list(polygon.exterior.coords)] + [list(ring.coords) for ring in polygon.interiors]
    for precision in (2, 4, 7, None):
        candidate = [
            [[round(p[0], precision), round(p[1], precision)] if precision is not None else [p[0], p[1]] for p in ring]
            for ring in original
        ]
        check = Polygon(candidate[0], candidate[1:])
        if check.is_valid and check.area > 0:
            return candidate
    raise RuntimeError("Cannot encode valid polygon rings")


class CachedJSON:
    def __init__(self, directory):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)

    def get(self, url, params):
        request_url = requests.Request("GET", url, params=params).prepare().url
        digest = hashlib.sha256(request_url.encode()).hexdigest()
        path = self.directory / (digest + ".json")
        if path.exists():
            return json.loads(path.read_text())
        with requests.Session() as session:
            session.headers["User-Agent"] = "Manhattan-offline-3D-world/1.0"
            retry = Retry(total=4, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504])
            session.mount("https://", HTTPAdapter(max_retries=retry))
            response = session.get(url, params=params, timeout=120)
            response.raise_for_status()
            result = response.json()
        if isinstance(result, dict) and (result.get("error") or result.get("errorCode")):
            raise RuntimeError(f"API error from {url}: {str(result)[:300]}")
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(result, separators=(",", ":")))
        temp.replace(path)
        return result


def acquire(cache, workers):
    all_boroughs = cache.get(SOCRATA + "gthc-hcne.geojson", {"$limit": 10})["features"]
    land = [feature for feature in all_boroughs if str(feature["properties"].get("borocode")) == "1"]
    borough_wgs = unary_union([shape(f["geometry"]) for f in land])
    west, south, east, north = borough_wgs.bounds
    where = {
        "buildings": "BASE_BBL LIKE '1%'",
        "roads": "boroughcode='1'",
        "parks": "borough='M' AND retired=false",
        "trees": f"within_box(location,{north},{west},{south},{east}) AND tpstructure='Full'",
    }
    selects = {
        "roads": "the_geom,objectid,stname_label,full_street_name,streetwidth,rw_type,trafdir,number_travel_lanes,boroughcode,from_level_code,to_level_code",
        "parks": "multipolygon,gispropnum,name311,signname,typecategory,borough",
        "trees": "location,objectid,plantingspaceglobalid,genusspecies,dbh,tpcondition,updateddate",
    }
    sources = {source["key"]: source for source in SOURCE_DEFINITIONS}
    raw = {"land": land, "context": [f for f in all_boroughs if f not in land],
           "buildings": [], "roads": [], "parks": [], "trees": []}
    planned = []
    expected = {}
    for key in ("buildings", "roads", "parks", "trees"):
        url = sources[key]["api"]
        if key == "buildings":
            total = cache.get(url, {"f": "json", "where": where[key], "returnCountOnly": "true"})["count"]
            limit = 2000
        else:
            count_url = url.replace(".geojson", ".json")
            total = int(cache.get(count_url, {"$select": "count(*)", "$where": where[key]})[0]["count"])
            limit = 5000
        expected[key] = total
        print(f"Source count {key}: {total:,}", flush=True)
        for offset in range(0, total, limit):
            if key == "buildings":
                params = {
                    "f": "geojson", "where": where[key],
                    "outFields": "OBJECTID,DOITT_ID,BIN,BASE_BBL,MAPPLUTO_BBL,NAME,CONSTRUCTION_YEAR,FEATURE_CODE,GEOM_SOURCE,GROUND_ELEVATION,HEIGHT_ROOF,LAST_STATUS_TYPE",
                    "outSR": "4326", "orderByFields": "OBJECTID ASC",
                    "resultRecordCount": limit, "resultOffset": offset,
                }
            else:
                params = {"$select": selects[key], "$where": where[key],
                          "$order": "objectid", "$limit": limit, "$offset": offset}
            planned.append((key, url, params, offset))

    def page(task):
        key, url, params, offset = task
        result = cache.get(url, params)
        if "features" not in result:
            raise RuntimeError(f"Expected GeoJSON FeatureCollection: {key} {offset}")
        print(f"Acquired {key} {offset:,}: {len(result['features']):,}", flush=True)
        return key, offset, result["features"]

    pages = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for future in as_completed([executor.submit(page, task) for task in planned]):
            pages.append(future.result())
    # Stable ordering also makes output independent of request completion order.
    for key, _, features in sorted(pages, key=lambda item: (item[0], item[1])):
        raw[key].extend(features)
    for key, total in expected.items():
        if len(raw[key]) != total:
            raise RuntimeError(f"Incomplete {key} acquisition: {len(raw[key])} of {total}")
    return raw, borough_wgs


def landmark_name(name):
    for pattern, key in LANDMARKS:
        if re.search(pattern, name or "", re.I):
            return key
    return None


def prepare(raw, borough_wgs, forward):
    project = lambda geometry: transform(shape(geometry), forward.transform, interleaved=False)
    land_geom = make_valid(transform(borough_wgs, forward.transform, interleaved=False))
    land_buffer = land_geom.buffer(3)
    land_prepared = prep(land_buffer)
    land = [(polygon, {"id": f"manhattan-land-{i}", "name": "Manhattan", "kind": "land"})
            for i, polygon in enumerate(parts(land_geom, "Polygon")) if polygon.area > .1]
    parks = []
    for feature in raw["parks"]:
        props = feature["properties"]
        geometry = make_valid(project(feature["geometry"])).intersection(land_geom)
        name = props.get("name311") or props.get("signname") or "NYC park"
        kind = "plaza" if "plaza" in (props.get("typecategory") or "").lower() else "park"
        for i, polygon in enumerate(parts(geometry, "Polygon")):
            if polygon.area > 1:
                parks.append((polygon, {"id": f"park-{props['gispropnum']}-{i}", "name": name, "kind": kind}))

    buildings = []
    placeholders = 0
    for feature in raw["buildings"]:
        props = feature["properties"]
        if not str(props.get("BASE_BBL", "")).startswith("1"):
            raise RuntimeError("Non-Manhattan building returned by borough filter")
        if props.get("FEATURE_CODE") == 1003:
            placeholders += 1
            continue
        height_ft = number(props.get("HEIGHT_ROOF"))
        estimated = height_ft <= 0
        height = height_ft * FOOT_TO_M if not estimated else (4.0 if props.get("FEATURE_CODE") == 2110 else 12.0)
        geometry = make_valid(project(feature["geometry"]))
        for i, polygon in enumerate(parts(geometry, "Polygon")):
            if polygon.area < .25:
                continue
            centroid = polygon.centroid
            record = {
                "id": f"nyc-{props['DOITT_ID']}-{i}", "name": props.get("NAME") or "",
                "height": round(height, 2), "heightEstimated": estimated,
                "heightSource": "estimated default" if estimated else "NYC HEIGHT_ROOF",
                "heightFeetOriginal": height_ft if not estimated else None,
                "groundElevation": round(number(props.get("GROUND_ELEVATION")) * FOOT_TO_M, 2),
                "levels": max(1, round(height / 3.4)), "levelsSource": "estimated from height",
                "centroid": [round(centroid.x, 2), round(centroid.y, 2)],
                "area": round(polygon.area, 1), "bin": props.get("BIN"),
                "bbl": props.get("MAPPLUTO_BBL"), "year": props.get("CONSTRUCTION_YEAR"),
                "featureCode": props.get("FEATURE_CODE"), "status": props.get("LAST_STATUS_TYPE"),
                "geometrySource": props.get("GEOM_SOURCE"),
            }
            landmark = landmark_name(record["name"])
            if landmark:
                record["landmark"] = landmark
            identity = LANDMARK_BIN_IDENTITIES.get(str(props.get("BIN")))
            if identity:
                record["landmark"], record["name"] = identity
                record["landmarkIdentification"] = "NYC LPC building database BIN"
                record["nameSource"] = "NYC LPC building database"
            buildings.append((polygon, record))

    # Landmark tags identify existing measured footprints; they never substitute
    # generic geometry for missing data. Coordinates are curated identity hints.
    for key, name, lon, lat, minimum_height in KNOWN_LANDMARK_POINTS:
        point = Point(*forward.transform(lon, lat))
        candidates = [(geometry.distance(point), geometry, record)
                      for geometry, record in buildings if record["height"] >= minimum_height]
        distance, geometry, record = min(candidates, key=lambda item: item[0])
        if distance > 40:
            raise RuntimeError(f"Known landmark could not be associated with a real footprint: {name}")
        record["landmark"] = key
        record["landmarkIdentification"] = "curated point associated with official footprint"
        if not record["name"]:
            record["name"] = name
            record["nameSource"] = "curated landmark identification"
        print(f"Landmark {key}: {record['id']}, roof {record['height']} m, point distance {distance:.1f} m", flush=True)

    roads = []
    excluded_roads = 0
    for feature in raw["roads"]:
        props = feature["properties"]
        if str(props.get("boroughcode")) != "1":
            raise RuntimeError("Non-Manhattan road returned by borough filter")
        road_type = int(number(props.get("rw_type")))
        name = props.get("stname_label") or props.get("full_street_name") or "Unnamed path"
        if road_type in (4, 12, 14) or any(s in name.upper() for s in ("TUNNEL", "TUNL", "TNNL", "UNDERPASS", "FERRY")):
            excluded_roads += 1
            continue
        pedestrian = road_type in (5, 6, 7) or props.get("trafdir") == "NV"
        kind = "path" if pedestrian else "highway" if road_type == 2 else "ramp" if road_type == 9 else "street"
        measured_width = number(props.get("streetwidth")) * FOOT_TO_M
        width = measured_width if measured_width > 0 else 3.0 if pedestrian else 9.0
        # Real bridge centerlines legitimately cross water. Preserve those spans;
        # ordinary ground paths stay aligned with the actual shoreline.
        geometry = project(feature["geometry"])
        if road_type != 3:
            geometry = geometry.intersection(land_buffer)
        for i, line in enumerate(parts(geometry, "LineString")):
            if line.length < 1:
                continue
            points = xy(line.coords)
            if props.get("trafdir") == "TF":
                points.reverse()
            record = {
                "id": f"cscl-{props['objectid']}-{i}", "name": name, "width": round(width, 2),
                "widthSource": "NYC CSCL streetwidth" if measured_width > 0 else "estimated default",
                "kind": kind, "oneway": props.get("trafdir") in ("FT", "TF"),
                "trafficAllowed": not pedestrian, "roadType": road_type,
                "elevated": road_type == 3,
                "lanes": int(number(props.get("number_travel_lanes"), 1)),
                "fromLevel": props.get("from_level_code"), "toLevel": props.get("to_level_code"),
            }
            # Preserve travel direction when clipping subsequent tile pieces.
            if props.get("trafdir") == "TF":
                from shapely.geometry import LineString
                line = LineString(list(line.coords)[::-1])
            roads.append((line, record))

    trees = []
    seen_spaces = set()
    for feature in raw["trees"]:
        props = feature["properties"]
        point = project(feature["geometry"])
        if not land_prepared.covers(point):
            continue
        planting_space = props.get("plantingspaceglobalid")
        if planting_space and planting_space in seen_spaces:
            continue
        if planting_space:
            seen_spaces.add(planting_space)
        trees.append({
            "id": f"nyctree-{props['objectid']}", "x": round(point.x, 2), "y": round(point.y, 2),
            "species": props.get("genusspecies") or "Unknown", "dbhInches": number(props.get("dbh")),
            "condition": props.get("tpcondition"), "source": "NYC Parks inventory",
        })
    print(f"Prepared {len(buildings):,} buildings, {len(roads):,} road pieces, {len(trees):,} standing trees", flush=True)
    return land_geom, land + parks, buildings, roads, trees, placeholders, excluded_roads


def tile_coordinates(bounds, size):
    minx, miny, maxx, maxy = bounds
    for ix in range(math.floor(minx / size), math.floor(maxx / size) + 1):
        for iy in range(math.floor(miny / size), math.floor(maxy / size) + 1):
            yield ix, iy


def write_json(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(content, separators=(",", ":"), ensure_ascii=False) + "\n")


def content_descriptor(content, tile_bounds):
    """Bounds include complete cross-seam buildings for correct frustum culling."""
    bounds = list(tile_bounds)
    for building in content["buildings"]:
        for x, y in building["rings"][0]:
            bounds[0] = min(bounds[0], x)
            bounds[1] = min(bounds[1], y)
            bounds[2] = max(bounds[2], x)
            bounds[3] = max(bounds[3], y)
    return {
        "contentBounds": bounds,
        "maxHeight": round(max((building["height"] for building in content["buildings"]), default=0) + 15, 2),
    }


def build_level(output, lod, size, local_bounds, surfaces, buildings, roads, trees):
    bins = defaultdict(lambda: {"buildings": [], "roads": [], "trees": [], "land": []})
    for polygon, record in buildings:
        centroid = polygon.centroid
        index = (math.floor(centroid.x / size), math.floor(centroid.y / size))
        # Each complete silhouette belongs to exactly one tile; no sliced towers.
        tolerance = (0, .8, 2.5)[lod]
        simple = polygon if lod == 0 else polygon.simplify(tolerance, preserve_topology=True)
        if lod == 2 and len(simple.exterior.coords) > 24:
            simple = simple.simplify(5, preserve_topology=True)
        item = dict(record)
        item["rings"] = rings(simple)
        bins[index]["buildings"].append(item)
    if lod == 0:
        for tree in trees:
            bins[(math.floor(tree["x"] / size), math.floor(tree["y"] / size))]["trees"].append(tree)
    for geometry, record in surfaces:
        for index in tile_coordinates(geometry.bounds, size):
            ix, iy = index
            tile_box = box(ix * size, iy * size, (ix + 1) * size, (iy + 1) * size)
            clipped = geometry.intersection(tile_box)
            for i, polygon in enumerate(parts(clipped, "Polygon")):
                if polygon.area < .1:
                    continue
                tolerance = (0, 1.5, 4)[lod]
                polygon = polygon.simplify(tolerance, preserve_topology=True)
                bins[index]["land"].append({**record, "id": f"{record['id']}-{i}", "rings": rings(polygon)})
    for geometry, record in roads:
        if lod and (record["kind"] == "path" or (record["width"] < (8 if lod == 1 else 14) and record["kind"] not in ("highway", "ramp"))):
            continue
        for index in tile_coordinates(geometry.bounds, size):
            ix, iy = index
            clipped = geometry.intersection(box(ix * size, iy * size, (ix + 1) * size, (iy + 1) * size))
            for i, line in enumerate(parts(clipped, "LineString")):
                if line.length < 1:
                    continue
                line = line.simplify((0, 1, 3)[lod])
                bins[index]["roads"].append({**record, "id": f"{record['id']}-{i}", "points": xy(line.coords)})
    tiles = []
    for (ix, iy), content in sorted(bins.items()):
        if not any(content.values()):
            continue
        tile_id = f"{ix}_{iy}"
        bounds = [ix * size, iy * size, (ix + 1) * size, (iy + 1) * size]
        relative = f"lod{lod}/{tile_id}.json"
        tile = {"meta": {"center": list(CENTER), "size": size, "lod": lod, "bounds": bounds,
                         "origin": [(ix + .5) * size, (iy + .5) * size]}, **content}
        write_json(output / relative, tile)
        tiles.append({"id": tile_id, "bounds": bounds, **content_descriptor(content, bounds),
                      "url": f"data/manhattan/{relative}",
                      "counts": {key: len(content[key]) for key in ("buildings", "trees", "roads")}})
    print(f"Built LOD {lod}: {len(tiles)} tiles", flush=True)
    return {"lod": lod, "tileSize": size, "tiles": tiles}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=Path("/tmp/nyc-manhattan-cache"))
    parser.add_argument("--output", type=Path, default=ROOT / "public/data/manhattan")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--acquire-only", action="store_true")
    args = parser.parse_args()
    started = time.monotonic()
    raw, borough_wgs = acquire(CachedJSON(args.cache), max(1, min(args.workers, 6)))
    if args.acquire_only:
        print("Acquisition complete; responses retained in cache.")
        return
    local = CRS.from_proj4(f"+proj=aeqd +lat_0={CENTER[1]} +lon_0={CENTER[0]} +datum=WGS84 +units=m +no_defs")
    forward = Transformer.from_crs("EPSG:4326", local, always_xy=True)
    land_geom, surfaces, buildings, roads, trees, placeholders, excluded_roads = prepare(raw, borough_wgs, forward)
    geometry_bounds = [land_geom.bounds] + [geometry.bounds for geometry, _ in buildings]
    local_bounds = [min(b[0] for b in geometry_bounds), min(b[1] for b in geometry_bounds),
                    max(b[2] for b in geometry_bounds), max(b[3] for b in geometry_bounds)]
    levels = [build_level(args.output, lod, size, local_bounds, surfaces, buildings, roads, trees)
              for lod, size in ((0, 500), (1, 1000), (2, 2000))]
    # Small, complete geographic context remains present while detailed tiles stream.
    overview = []
    for geometry, record in surfaces:
        overview.append({**record, "rings": rings(geometry.simplify(8, preserve_topology=True))})
    # Neighboring boroughs are context only, never attributed as Manhattan features.
    context = []
    context_box = box(local_bounds[0] - 6000, local_bounds[1] - 6000,
                      local_bounds[2] + 6000, local_bounds[3] + 6000)
    for feature in raw["context"]:
        geometry = transform(shape(feature["geometry"]), forward.transform, interleaved=False)
        geometry = make_valid(geometry).intersection(context_box).simplify(15, preserve_topology=True)
        name = feature["properties"].get("boroname") or "Neighboring NYC borough"
        for i, polygon in enumerate(parts(geometry, "Polygon")):
            if polygon.area > 10:
                context.append({"id": f"context-{name}-{i}", "name": name,
                                "kind": "land", "rings": rings(polygon)})
    counts = {"buildings": len(buildings), "roads": len(roads), "trees": len(trees), "land": len(surfaces),
              "estimatedHeights": sum(record["heightEstimated"] for _, record in buildings),
              "sourceBuildingFeatures": len(raw["buildings"]), "placeholderFootprintsExcluded": placeholders}
    manifest = {
        "meta": {
            "name": "Manhattan", "center": list(CENTER), "bounds": list(borough_wgs.bounds),
            "localBounds": [round(v, 2) for v in local_bounds], "sources": SOURCE_DEFINITIONS + [LPC_SOURCE],
            "notes": [
                "Complete Manhattan borough coverage from official NYC sources, including source borough islands and Marble Hill; not a single neighborhood crop.",
                "Building membership uses official BASE_BBL borough prefix 1. Geometry is real OTI footprint geometry; no generic replacement buildings are fabricated.",
                "HEIGHT_ROOF is feet above ground converted to meters. Zero/missing heights have marked conservative estimated defaults; all floor counts are estimates.",
                "This generation uses footprint extrusion rather than 2014 CityGML roof meshes; decorative landmark silhouettes are renderer approximations.",
                "Selected landmark identities use curated known coordinates matched to existing measured building footprints; tagged identity is distinct from any renderer crown/roof approximation.",
                "Metropolitan Life Insurance Company Tower identity is linked to official LPC building BIN 1016741; this avoids confusing it with neighboring MetLife buildings.",
                "Source ground elevations are retained, but terrain is flat in this style prototype.",
                "Manhattan roads use official CSCL boroughcode 1. Street widths are measured source attributes when present and marked estimates otherwise.",
                "Bridge centerlines (CSCL road type 3) retain their actual spans over water, but bridge structures/deck elevations are not supplied by this pipeline.",
                f"Excluded {excluded_roads} underground/ferry/nonexistent CSCL routes and {placeholders} placeholder footprint triangles.",
                "Standing tree locations and species are actual NYC Parks inventory records spatially filtered to the shoreline and deduplicated by planting space; no procedural park tree locations are added to these tiles.",
                "Tree records on the borough edge allow a 3 m boundary tolerance for source misalignment.",
                "Parks identify property jurisdiction, not exact grass cover. Sources have different survey/update vintages; this is an acquisition snapshot.",
                "LOD0 includes all acquired detail; LOD1 simplifies outlines and omits trees/paths; LOD2 simplifies further and retains broad roads. Building silhouettes remain complete and are assigned once per level by centroid.",
                "All tile feature coordinates use the same global local-meter AEQD frame, x east/y north; renderer z=-y. Tile origin is metadata for rendering precision.",
                "Traffic, facade details, and lighting are stylized procedural effects, not live observations.",
                "Overview contextLand contains real shoreline-clipped neighboring NYC boroughs only, excluded from Manhattan counts and tiles. New Jersey context is not included.",
            ],
            "counts": counts, "generatedAt": datetime.now(timezone.utc).isoformat(),
            "coordinateSystem": "AEQD WGS84, meters, x east/y north; center [-73.9712,40.7831]",
        },
        "levels": levels, "overview": {"land": overview, "contextLand": context},
    }
    write_json(args.output / "manifest.json", manifest)
    print(json.dumps(counts, indent=2))
    print(f"Saved {args.output / 'manifest.json'} in {time.monotonic() - started:.1f}s")


if __name__ == "__main__":
    main()
