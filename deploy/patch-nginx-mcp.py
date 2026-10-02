#!/usr/bin/env python3
"""Ensure /mcp proxy to localhost MCP Streamable-HTTP in nginx site config."""
from pathlib import Path

p = Path("/etc/nginx/sites-available/immobilieneichmann.de")
text = p.read_text()
changed = False

snippet = """
    # Public MCP Streamable-HTTP (localhost Node) — listings tools
    location = /mcp {
        proxy_pass http://127.0.0.1:3848/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Accept $http_accept;
        proxy_buffering off;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
    location = /mcp/ {
        return 301 /mcp;
    }

"""

if "location = /mcp" not in text and "location /mcp" not in text:
    marker = "    location /admin/api/"
    if marker in text:
        text = text.replace(marker, snippet + marker, 1)
    else:
        marker2 = "    location ~* \\.(css|js|mjs|"
        if marker2 in text:
            text = text.replace(marker2, snippet + marker2, 1)
        else:
            text = text.replace("\n    location / {\n", snippet + "\n    location / {\n", 1)
    changed = True
    print("nginx: inserted /mcp proxy")
else:
    print("nginx: /mcp already present")

if changed:
    p.write_text(text)
    print("nginx: config updated")
else:
    print("nginx: no changes needed")
