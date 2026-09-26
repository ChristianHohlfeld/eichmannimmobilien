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

# Upload gallery lives on the droplet (not in git). Keep across rsync --delete.
mkdir -p "$SITE/media/eigen"
chown -R www-data:www-data "$SITE/media"
chmod 775 "$SITE/media" "$SITE/media/eigen"
chmod g+s "$SITE/media" "$SITE/media/eigen" || true


# App-Sicherungen: Ordner + Cron (alle 12h, 14 Stände)
mkdir -p /var/lib/eichmann/snapshots
chmod 755 /var/lib/eichmann/snapshots
if [ -f "$APP/deploy/eichmann-snapshot.cron" ]; then
  cp -f "$APP/deploy/eichmann-snapshot.cron" /etc/cron.d/eichmann-snapshot
  chmod 644 /etc/cron.d/eichmann-snapshot
fi
touch /var/log/eichmann-snapshot.log
chmod 644 /var/log/eichmann-snapshot.log || true

systemctl daemon-reload
systemctl enable eichmann-admin-api.service
systemctl restart eichmann-admin-api.service
sleep 1
systemctl is-active eichmann-admin-api.service

# Patch nginx (idempotent): insert /admin/api/ if missing, ensure client_max_body_size 40m
if [ -f "$NGINX_SITE" ]; then
  python3 "$APP/deploy/patch-nginx-admin-api.py"
fi
mkdir -p "$SITE/media/eigen"
chown -R www-data:www-data "$SITE/media" || true

nginx -t
systemctl reload nginx

curl -fsS http://127.0.0.1:3847/admin/api/health || curl -fsS http://127.0.0.1:3847/health
echo
echo "admin-api install OK"
