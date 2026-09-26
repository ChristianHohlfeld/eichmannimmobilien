#!/usr/bin/env python3
"""Ensure /admin/api/ proxy + eigen redirect + 40m upload body limit in nginx site config.

Also keep proxy_read_timeout / proxy_send_timeout at >= 240s so Immowelt sync
(admin-api child timeout 240s) is not cut short by nginx.
"""
from pathlib import Path
import re

p = Path("/etc/nginx/sites-available/immobilieneichmann.de")
text = p.read_text()
changed = False

snippet = """
    # Admin API (localhost Node) — session cookie auth
    # Multipart eigen-image uploads need a raised body limit (default nginx is 1m).
    # Sync timeout is 240s in admin-api; keep proxy timeouts at least that long.
    location /admin/api/ {
        client_max_body_size 40m;
        proxy_pass http://127.0.0.1:3847;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 240s;
        proxy_send_timeout 240s;
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

# Ensure directives inside existing /admin/api/ block
start = text.find("location /admin/api/")
if start >= 0:
    brace = text.find("{", start)
    end = text.find("\n    }", brace)
    if brace >= 0 and end > brace:
        block = text[brace : end + 6]
        new_block = block

        if "client_max_body_size" not in new_block:
            new_block = new_block.replace("{", "{\n        client_max_body_size 40m;", 1)
            print("nginx: added client_max_body_size 40m to /admin/api/")
        else:
            print("nginx: client_max_body_size already set for /admin/api/")

        def ensure_timeout(src, directive, seconds=240):
            pat = re.compile(rf"{directive}\s+(\d+)s\s*;")
            m = pat.search(src)
            line = f"        {directive} {seconds}s;"
            if not m:
                # Insert after proxy_read_timeout or after proxy_set_header X-Forwarded-Proto
                anchor = re.search(r"proxy_set_header\s+X-Forwarded-Proto\s+\$scheme\s*;", src)
                if anchor:
                    at = anchor.end()
                    return src[:at] + "\n" + line + src[at:], True
                return src.replace("{", "{\n" + line, 1), True
            cur = int(m.group(1))
            if cur < seconds:
                return pat.sub(f"{directive} {seconds}s;", src, count=1), True
            return src, False

        new_block, did = ensure_timeout(new_block, "proxy_read_timeout", 240)
        if did:
            print("nginx: set proxy_read_timeout 240s on /admin/api/")
        else:
            print("nginx: proxy_read_timeout already >= 240s")

        new_block, did = ensure_timeout(new_block, "proxy_send_timeout", 240)
        if did:
            print("nginx: set proxy_send_timeout 240s on /admin/api/")
        else:
            print("nginx: proxy_send_timeout already >= 240s")

        if new_block != block:
            text = text[:brace] + new_block + text[end + 6 :]
            changed = True

if changed:
    p.write_text(text)
    print("nginx: config updated")
else:
    print("nginx: no changes needed")
