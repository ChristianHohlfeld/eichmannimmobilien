# Production nginx notes

The production static site is currently served by nginx on the `eichmann-web` droplet (`46.101.163.236`), from `/var/www/immobilieneichmann.de`. The active site configuration is `/etc/nginx/sites-available/immobilieneichmann.de` (enabled via `/etc/nginx/sites-enabled/immobilieneichmann.de`). Content deploys do not manage this server configuration, so nginx changes must be applied on the droplet and kept documented here.

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
