#!/usr/bin/env bash
# Install/refresh localhost MCP Streamable-HTTP + nginx /mcp proxy on eichmann-web.
set -euo pipefail

APP=/var/lib/eichmann/app
SITE=/var/www/immobilieneichmann.de
UNIT_SRC="$APP/deploy/eichmann-mcp.service"
NGINX_SITE=/etc/nginx/sites-available/immobilieneichmann.de

if [ ! -f "$APP/scripts/mcp-server.mjs" ]; then
  echo "Missing $APP/scripts/mcp-server.mjs – sync app tooling first"
  exit 1
fi

if [ -f "$UNIT_SRC" ]; then
  cp -f "$UNIT_SRC" /etc/systemd/system/eichmann-mcp.service
fi

if [ ! -f /etc/systemd/system/eichmann-mcp.service ]; then
  cat > /etc/systemd/system/eichmann-mcp.service <<'UNIT'
[Unit]
Description=Eichmann Immobilien public MCP (Streamable HTTP)
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/lib/eichmann/app
Environment=NODE_ENV=production
Environment=EICHMANN_SITE_ROOT=/var/www/immobilieneichmann.de
Environment=EICHMANN_MCP_HOST=127.0.0.1
Environment=EICHMANN_MCP_PORT=3848
ExecStart=/usr/bin/node /var/lib/eichmann/app/scripts/mcp-server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
fi

systemctl daemon-reload
systemctl enable eichmann-mcp.service
systemctl restart eichmann-mcp.service
sleep 1
systemctl is-active eichmann-mcp.service

# Patch nginx for /mcp (idempotent)
if [ -f "$NGINX_SITE" ] && [ -f "$APP/deploy/patch-nginx-mcp.py" ]; then
  python3 "$APP/deploy/patch-nginx-mcp.py"
fi

nginx -t
systemctl reload nginx

curl -fsS http://127.0.0.1:3848/health
echo
echo "eichmann-mcp install OK"
