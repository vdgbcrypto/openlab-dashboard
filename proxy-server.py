#!/usr/bin/env python3
"""
OpenLab Dashboard - Reverse Proxy Server
Serves static dashboard files and proxies API calls to backend services.
This avoids CORS issues by keeping everything on the same origin (port 8899).
"""

import http.server
import socketserver
import urllib.request
import urllib.error
import json
import os
import sys
import threading
import ssl

DASHBOARD_DIR = '/opt/data/openlab-dashboard'
PROXY_ROUTES = {
    '/proxy/netdata/': 'http://100.81.76.106:19999/',
    '/proxy/truenas/': 'https://192.168.1.252/',
    '/proxy/ntopng/': 'http://100.81.76.106:3000/',
    '/proxy/crypto/': 'http://100.81.76.106:8001/',
}

# Create an SSL context that doesn't verify certs (for TrueNAS self-signed)
ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DASHBOARD_DIR, **kwargs)

    def do_GET(self):
        # Check if this is a proxy request
        for prefix, upstream_base in PROXY_ROUTES.items():
            if self.path.startswith(prefix):
                self.proxy_request(prefix, upstream_base)
                return
        # Otherwise serve static files
        super().do_GET()

    def do_POST(self):
        for prefix, upstream_base in PROXY_ROUTES.items():
            if self.path.startswith(prefix):
                self.proxy_request(prefix, upstream_base)
                return
        self.send_error(405, "Method Not Allowed")

    def do_OPTIONS(self):
        # Handle CORS preflight
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.end_headers()

    def proxy_request(self, prefix, upstream_base):
        # Strip the prefix to get the downstream path
        path = self.path
        if path.startswith(prefix):
            downstream_path = path[len(prefix):]
        else:
            # Also match without trailing slash
            prefix_stripped = prefix.rstrip('/')
            if path.startswith(prefix_stripped):
                downstream_path = path[len(prefix_stripped):]
            else:
                downstream_path = path
        # Ensure downstream_path starts with /
        if not downstream_path.startswith('/'):
            downstream_path = '/' + downstream_path
        # Reconstruct query string
        if '?' in downstream_path:
            downstream_path, query = downstream_path.split('?', 1)
            url = upstream_base + downstream_path + '?' + query
        else:
            url = upstream_base + downstream_path

        # Read POST body if present
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        # Build the upstream request
        req = urllib.request.Request(url, data=body, method=self.command)

        # Forward relevant headers
        for header in ['Authorization', 'Content-Type', 'Accept']:
            val = self.headers.get(header)
            if val:
                req.add_header(header, val)

        try:
            # Use SSL context for HTTPS upstreams
            if upstream_base.startswith('https'):
                resp = urllib.request.urlopen(req, timeout=15, context=ssl_ctx)
            elif 'crypto' in upstream_base:
                # Crypto bot Flask server is slow under load
                resp = urllib.request.urlopen(req, timeout=30)
            else:
                resp = urllib.request.urlopen(req, timeout=10)

            # Send response back to client
            self.send_response(resp.status)
            # Forward response headers
            for key, val in resp.getheaders():
                lower = key.lower()
                if lower in ('transfer-encoding', 'connection', 'keep-alive'):
                    continue
                self.send_header(key, val)
            # Add CORS headers
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            # Stream the response body
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)

        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            error_body = json.dumps({'error': str(e.reason), 'code': e.code})
            self.wfile.write(error_body.encode())

        except urllib.error.URLError as e:
            self.send_error(502, f"Upstream connection failed: {e.reason}")

        except Exception as e:
            self.send_error(500, f"Proxy error: {str(e)}")

    def log_message(self, format, *args):
        # Quieter logging
        pass


class ReusableTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    port = 8899
    with ReusableTCPServer(('0.0.0.0', port), ProxyHandler) as httpd:
        print(f"OpenLab Dashboard Proxy running on 0.0.0.0:{port}")
        print(f"Dashboard: http://0.0.0.0:{port}/")
        print(f"Netdata proxy: http://0.0.0.0:{port}/proxy/netdata/")
        print(f"TrueNAS proxy: http://0.0.0.0:{port}/proxy/truenas/")
        print(f"ntopng proxy: http://0.0.0.0:{port}/proxy/ntopng/")
        sys.stdout.flush()
        httpd.serve_forever()
