#!/usr/bin/env python3
"""Serve this static world, preferring precompressed assets on public links."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class CityHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = Path(self.translate_path(self.path))
        if path.is_dir():
            index = path / 'index.html'
            if not index.is_file():
                self.send_error(404)
                return None
            path = index
        zipped = path.with_name(path.name + '.gz')
        if 'gzip' in self.headers.get('Accept-Encoding', '') and zipped.is_file():
            stream = zipped.open('rb')
            self.send_response(200)
            self.send_header('Content-type', self.guess_type(str(path)))
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Vary', 'Accept-Encoding')
            self.send_header('Content-Length', str(zipped.stat().st_size))
            self.send_header('Last-Modified', self.date_time_string(path.stat().st_mtime))
            self.end_headers()
            return stream
        return super().send_head()

    def end_headers(self):
        # Revalidate filenames shared by successive geographic snapshots. Hashed
        # JS filenames could be immutable, but this also keeps previews simple.
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5173)
    parser.add_argument('--directory', default='dist')
    args = parser.parse_args()
    server = ThreadingHTTPServer(('0.0.0.0', args.port), partial(CityHandler, directory=args.directory))
    print(f'Serving {args.directory} on 0.0.0.0:{args.port}', flush=True)
    server.serve_forever()
