#!/usr/bin/env bash
# Install/refresh localhost admin API + nginx proxy on eichmann-web.
set -euo pipefail

APP=/var/lib/eichmann/app
SITE=/var/www/immobilieneichmann.de
UNIT_SRC="$APP/deploy/eichmann-admin-api.service"
NGINX_SITE=/etc/nginx/sites-available/immobilieneichmann.de

if [ ! -f "$APP/scripts/admin-api.mjs" ]; then
  echo "Missing $APP/scripts/admin-api.mjs – sync app tooling first"
  exit 1
fi

if [ -f "$UNIT_SRC" ]; then
  cp -f "$UNIT_SRC" /etc/systemd/system/eichmann-admin-api.service
fi

if [ ! -f /etc/systemd/system/eichmann-admin-api.service ]; then
  cat > /etc/systemd/system/eichmann-admin-api.service <<'UNIT'
[Unit]
Description=Eichmann Immobilien admin API (localhost)
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/lib/eichmann/app
Environment=EICHMANN_DB_PATH=/var/lib/eichmann/listings.db
Environment=EICHMANN_SITE_ROOT=/var/www/immobilieneichmann.de
Environment=EICHMANN_ADMIN_CONFIG=/var/www/immobilieneichmann.de/admin/config.json
Environment=EICHMANN_SESSION_SECRET_FILE=/var/lib/eichmann/admin-session.secret
Environment=EICHMANN_ADMIN_API_HOST=127.0.0.1
Environment=EICHMANN_ADMIN_API_PORT=3847
ExecStart=/usr/bin/node /var/lib/eichmann/app/scripts/admin-api.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
fi

mkdir -p /var/lib/eichmann
chmod 755 /var/lib/eichmann

systemctl daemon-reload
systemctl enable eichmann-admin-api.service
systemctl restart eichmann-admin-api.service
sleep 1
systemctl is-active eichmann-admin-api.service

# Patch nginx via a separate Python file to avoid heredoc nesting issues
if [ -f "$NGINX_SITE" ]; then
  if ! grep -q 'location /admin/api/' "$NGINX_SITE"; then
    python3 "$APP/deploy/patch-nginx-admin-api.py"
  else
    echo "nginx: /admin/api/ already present"
  fi
fi

nginx -t
systemctl reload nginx

curl -fsS http://127.0.0.1:3847/admin/api/health || curl -fsS http://127.0.0.1:3847/health
echo
echo "admin-api install OK"
