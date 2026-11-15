#!/usr/bin/env python3
"""Check geographic and hierarchy invariants of the offline Manhattan dataset."""
import json
import math
from pathlib import Path

from shapely.geometry import Point, Polygon, box


ROOT = Path(__file__).resolve().parent.parent


def main():
    manifest = json.loads((ROOT / "public/data/manhattan/manifest.json").read_text())
    expected = manifest["meta"]["counts"]["buildings"]
    previous = None
    checked = 0
    for level in manifest["levels"]:
        ids, tree_ids = set(), set()
        for index in level["tiles"]:
            path = ROOT / "public" / index["url"]
            tile = json.loads(path.read_text())
            assert tile["meta"]["bounds"] == index["bounds"], path
            assert tile["meta"]["center"] == manifest["meta"]["center"], path
            assert tile["meta"]["lod"] == level["lod"], path
            tile_box = box(*index["bounds"]).buffer(.011)
            content_box = box(*index["contentBounds"]).buffer(.011)
            assert content_box.covers(box(*index["bounds"])), path
            for key in ("buildings", "roads", "trees"):
                assert len(tile[key]) == index["counts"][key], (path, key)
            for building in tile["buildings"]:
                assert building["id"] not in ids, ("duplicate building", path, building["id"])
                ids.add(building["id"])
                polygon = Polygon(building["rings"][0], building["rings"][1:])
                assert polygon.is_valid and polygon.area > 0, (path, building["id"])
                assert content_box.covers(polygon), ("building outside content bounds", path, building["id"])
                assert building["height"] > 0 and math.isfinite(building["height"])
                assert index["maxHeight"] >= building["height"] + 14.99, path
                x, y = building["centroid"]
                assert tile_box.covers(Point(x, y)), ("centroid outside owner tile", path, building["id"])
            for surface in tile["land"]:
                polygon = Polygon(surface["rings"][0], surface["rings"][1:])
                assert polygon.is_valid and polygon.area > 0, (path, surface["id"])
                assert tile_box.covers(polygon), ("land outside tile", path, surface["id"])
            for road in tile["roads"]:
                assert road["width"] > 0
                assert all(tile_box.covers(Point(p)) for p in road["points"])
            for tree in tile["trees"]:
                assert tree["id"] not in tree_ids, ("duplicate tree", path, tree["id"])
                tree_ids.add(tree["id"])
                assert tile_box.covers(Point(tree["x"], tree["y"]))
            checked += 1
        assert len(ids) == expected, (level["lod"], len(ids), expected)
        if previous is not None:
            assert ids == previous, "LOD building membership changed"
        previous = ids
        if level["lod"] == 0:
            assert len(tree_ids) == manifest["meta"]["counts"]["trees"]
        else:
            assert not tree_ids, "distant LOD unexpectedly contains trees"
        print(f"LOD {level['lod']}: {len(level['tiles'])} tiles, {len(ids):,} complete buildings, {len(tree_ids):,} trees")
    for key in ("land", "contextLand"):
        for record in manifest["overview"].get(key, []):
            polygon = Polygon(record["rings"][0], record["rings"][1:])
            assert polygon.is_valid and polygon.area > 0, ("overview", record["id"])
    assert (ROOT / "public/data/city.json").exists(), "original pilot snapshot missing"
    print(f"Validated {checked} tiles and neighboring-borough context.")


if __name__ == "__main__":
    main()
