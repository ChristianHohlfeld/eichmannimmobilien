#!/usr/bin/env python3
"""Ensure /mcp (open) and /mcp-gw (mcprush token) proxies to localhost MCP in nginx site config."""
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

if "location = /mcp {" not in text and "location /mcp {" not in text:
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

# mcprush gateway: same upstream, token is checked by the Node server.
gw_snippet = """
    # mcprush gateway MCP (token-checked in Node via MCPRUSH_TOKEN); /mcp stays open
    location = /mcp-gw {
        proxy_pass http://127.0.0.1:3848/mcp-gw;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Accept $http_accept;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Mcprush-Token $http_x_mcprush_token;
        proxy_buffering off;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
    location = /mcp-gw/ {
        return 301 /mcp-gw;
    }
"""

if "location = /mcp-gw" not in text:
    anchor = "    location = /mcp/ {\n        return 301 /mcp;\n    }\n"
    if anchor in text:
        text = text.replace(anchor, anchor + gw_snippet, 1)
        changed = True
        print("nginx: inserted /mcp-gw proxy")
    else:
        print("nginx: WARN /mcp anchor not found; /mcp-gw not inserted")
else:
    print("nginx: /mcp-gw already present")

if changed:
    p.write_text(text)
    print("nginx: config updated")
else:
    print("nginx: no changes needed")
