#!/usr/bin/env python3
"""Precompress the static city bundle without changing its source artifacts."""
import gzip
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'dist')
source_bytes = compressed_bytes = count = 0
for path in root.rglob('*'):
    if path.is_file() and path.suffix in {'.json', '.js', '.css', '.html'}:
        data = path.read_bytes()
        packed = gzip.compress(data, compresslevel=6, mtime=0)
        path.with_name(path.name + '.gz').write_bytes(packed)
        source_bytes += len(data)
        compressed_bytes += len(packed)
        count += 1
print(f'{count} assets: {source_bytes / 1048576:.1f} MB → {compressed_bytes / 1048576:.1f} MB gzip')
