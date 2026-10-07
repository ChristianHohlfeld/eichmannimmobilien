# Production nginx notes

The production static site is served by nginx on the `eichmann-web` droplet (`46.101.163.236`), from `/var/www/immobilieneichmann.de`. The active site configuration is `/etc/nginx/sites-available/immobilieneichmann.de` (enabled via `/etc/nginx/sites-enabled/immobilieneichmann.de`).

**Canonical host:** `https://immobilieneichmann.de` (apex). Content deploys (`deploy-droplet.yml` rsync) do **not** overwrite this server config. Keep the live file in sync with the tracked snapshot `deploy/nginx/immobilieneichmann.de.conf` whenever nginx is changed on the droplet.

## Homepage `/index.html` → `/` (301)

GSC reports `/index.html` as "Alternative page with proper canonical tag" because the HTML canonical is `/` while nginx served `index.html` as 200.

**Important:** do not only `return 301 /` on `location = /index.html` while leaving `index index.html;` to handle `/` — the index module internal-redirects `/` → `/index.html` and causes a redirect loop. Serve `/` explicitly, then 301 the explicit duplicates:

```nginx
location = / {
    try_files /index.html =404;
}
location = /index.html {
    return 301 /;
}
location = /index {
    return 301 /;
}
```

**Verify:**

```bash
curl -sI https://immobilieneichmann.de/index.html
# → 301 Location: https://immobilieneichmann.de/
curl -sI -L https://www.immobilieneichmann.de/index.html -o /dev/null -w '%{url_effective} %{http_code} %{num_redirects}\n'
# → https://immobilieneichmann.de/ 200 2
curl -sI https://immobilieneichmann.de/
# → 200
```

## www → apex (301)

`www.immobilieneichmann.de` must not remain a parallel indexable 200. Dedicated server blocks redirect to apex HTTPS while preserving path and query (`$request_uri`):

```nginx
# HTTPS www
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name www.immobilieneichmann.de;
    # … same LE cert as apex …
    return 301 https://immobilieneichmann.de$request_uri;
}

# HTTP apex + www (after ACME location)
location / {
    return 301 https://immobilieneichmann.de$request_uri;
}
```

Cert SANs already include `immobilieneichmann.de` and `www.immobilieneichmann.de`.

**Verify:**

```bash
curl -sI https://www.immobilieneichmann.de/projekte?x=1
# → 301 Location: https://immobilieneichmann.de/projekte?x=1
curl -sI http://www.immobilieneichmann.de/
# → 301 Location: https://immobilieneichmann.de/
curl -sI https://immobilieneichmann.de/
# → 200
```

## Project URL compatibility

The canonical project URL is `/projekte`. The production nginx config also redirects the trailing-slash form to it:

```nginx
location = /projekte/ {
    return 301 /projekte;
}
```

After changing the site config, validate and reload nginx, then verify that `/projekte/` returns `301` to `/projekte` and `/projekte` returns `200`.

## Public MCP (`/mcp`)

Production nginx proxies `location = /mcp` to `http://127.0.0.1:3848/mcp` (systemd `eichmann-mcp.service`).
Patched idempotently by `deploy/patch-nginx-mcp.py` via `deploy/install-mcp.sh` on each droplet deploy.

## Apply / restore on droplet

```bash
# After editing deploy/nginx/immobilieneichmann.de.conf in git (or copying from live):
sudo cp /etc/nginx/sites-available/immobilieneichmann.de \
  /etc/nginx/sites-available/immobilieneichmann.de.bak-$(date +%Y%m%d%H%M%S)
sudo cp /path/to/immobilieneichmann.de.conf /etc/nginx/sites-available/immobilieneichmann.de
sudo nginx -t && sudo systemctl reload nginx
```

`deploy/patch-nginx-admin-api.py` / `patch-nginx-mcp.py` only patch specific locations into the existing site file; they do not replace the full config. Do not rely on content deploys to re-apply www→apex or index.html→/.
