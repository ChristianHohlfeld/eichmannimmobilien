#!/usr/bin/env python3
"""Insert /admin/api/ proxy + /admin/eigen/ redirect into nginx site config."""
from pathlib import Path

p = Path("/etc/nginx/sites-available/immobilieneichmann.de")
text = p.read_text()
if "location /admin/api/" in text:
    print("nginx: /admin/api/ already present")
    raise SystemExit(0)

snippet = """
    # Admin API (localhost Node) — session cookie auth, no GitHub PAT
    location /admin/api/ {
        proxy_pass http://127.0.0.1:3847;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
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

marker = "    location ~* \\.(css|js|mjs|"
if marker in text:
    text = text.replace(marker, snippet + marker, 1)
else:
    text = text.replace("\n    location / {\n", snippet + "\n    location / {\n", 1)

p.write_text(text)
print("nginx: inserted /admin/api/ + eigen redirect")
