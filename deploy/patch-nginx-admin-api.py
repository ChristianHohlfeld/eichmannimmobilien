#!/usr/bin/env python3
"""Ensure /admin/api/ proxy + eigen redirect + 40m upload body limit in nginx site config."""
from pathlib import Path

p = Path("/etc/nginx/sites-available/immobilieneichmann.de")
text = p.read_text()
changed = False

snippet = """
    # Admin API (localhost Node) — session cookie auth
    # Multipart eigen-image uploads need a raised body limit (default nginx is 1m).
    location /admin/api/ {
        client_max_body_size 40m;
        proxy_pass http://127.0.0.1:3847;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_request_buffering off;
    }

    location = /admin/eigen {
        return 302 /admin/#eigen;
    }
    location = /admin/eigen/ {
        return 302 /admin/#eigen;
    }
    location ^~ /admin/eigen/ {
        return 302 /admin/#eigen;
    }

"""

if "location /admin/api/" not in text:
    marker = "    location ~* \\.(css|js|mjs|"
    if marker in text:
        text = text.replace(marker, snippet + marker, 1)
    else:
        text = text.replace("\n    location / {\n", snippet + "\n    location / {\n", 1)
    changed = True
    print("nginx: inserted /admin/api/ + eigen redirect")
else:
    print("nginx: /admin/api/ already present")

# Ensure client_max_body_size inside existing /admin/api/ block
start = text.find("location /admin/api/")
if start >= 0:
    brace = text.find("{", start)
    end = text.find("\n    }", brace)
    if brace >= 0 and end > brace:
        block = text[brace : end + 6]
        if "client_max_body_size" not in block:
            insert_at = brace + 1
            text = text[:insert_at] + "\n        client_max_body_size 40m;" + text[insert_at:]
            changed = True
            print("nginx: added client_max_body_size 40m to /admin/api/")
        else:
            print("nginx: client_max_body_size already set for /admin/api/")

if changed:
    p.write_text(text)
    print("nginx: config updated")
else:
    print("nginx: no changes needed")
