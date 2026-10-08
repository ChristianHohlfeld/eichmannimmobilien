#!/usr/bin/env python3
"""Ensure /mcp (open) and /mcp-gw (mcprush token) proxies to localhost MCP in nginx site config,
with per-IP rate limits (limit_req)."""
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

# Rate limits (per real client IP = $binary_remote_addr; nginx is the edge, no CDN in front,
# so client-sent X-Forwarded-For is never trusted for limiting).
#   /mcp     public: 30 req/min per IP, burst 15
#   /mcp-gw  mcprush gateway: many buyers share few mcprush egress IPs -> 300 req/min per IP, burst 60
# limit_req_zone must live in http{} context; this site file is included inside http{} via sites-enabled.
ZONES = """# mcp-rate-limit-v1 (managed by deploy/patch-nginx-mcp.py)
limit_req_zone $binary_remote_addr zone=eichmann_mcp:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=eichmann_mcp_gw:10m rate=300r/m;

"""
if "zone=eichmann_mcp:" not in text:
    text = ZONES + text
    changed = True
    print("nginx: added limit_req_zone eichmann_mcp / eichmann_mcp_gw")

LIMITS = {
    "    location = /mcp {\n": "        limit_req zone=eichmann_mcp burst=15 nodelay;\n        limit_req_status 429;\n",
    "    location = /mcp-gw {\n": "        limit_req zone=eichmann_mcp_gw burst=60 nodelay;\n        limit_req_status 429;\n",
}
for head, lines in LIMITS.items():
    idx = text.find(head)
    if idx < 0:
        print(f"nginx: WARN {head.strip()} not found; no limit_req added")
        continue
    block_end = text.find("    }\n", idx)
    if "limit_req zone=" in text[idx:block_end]:
        print(f"nginx: limit_req already in {head.strip()}")
        continue
    text = text[: idx + len(head)] + lines + text[idx + len(head):]
    changed = True
    print(f"nginx: added limit_req to {head.strip()}")

if changed:
    # Write, validate, and roll back on failure so a bad patch can never leave nginx unloadable.
    import shutil, subprocess
    backup = p.with_name(p.name + ".bak-mcp")
    shutil.copy2(p, backup)
    p.write_text(text)
    t = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
    if t.returncode != 0:
        shutil.copy2(backup, p)
        print("nginx: nginx -t FAILED, restored previous config:\n" + t.stderr)
        raise SystemExit(1)
    print("nginx: config updated (nginx -t ok)")
else:
    print("nginx: no changes needed")
