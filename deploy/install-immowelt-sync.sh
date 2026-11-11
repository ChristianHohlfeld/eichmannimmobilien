#!/usr/bin/env bash
# Install/refresh the Immowelt sync units on eichmann-web. Idempotent; run as root by the deploy.
#
#   install-immowelt-sync.sh                 units installed, timers left as they are
#   install-immowelt-sync.sh --enable        … and both timers enabled + started (go-live)
#   install-immowelt-sync.sh --disable       … and both timers stopped (maintenance)
#
# The sync never publishes without (1) the release layout, (2) the API key and (3) an approved
# identity migration – enabling the timer early is safe, it just reports why it cannot publish.
set -euo pipefail

APP=/var/lib/eichmann/app
STATE=/var/lib/eichmann
MODE="${1:-}"

[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausführen."; exit 1; }
[ -f "$APP/scripts/immowelt-sync.mjs" ] || { echo "Fehlt: $APP/scripts/immowelt-sync.mjs – erst App-Stand übertragen"; exit 1; }

install -d -m 755 "$STATE" "$STATE/releases" "$STATE/status" "$STATE/media" "$STATE/acme-challenge"
install -d -m 750 "$STATE/immowelt" "$STATE/immowelt/snapshots" "$STATE/immowelt/originals" "$STATE/immowelt/runs" "$STATE/immowelt/db-backups" "$STATE/locks"
install -d -m 700 "$STATE/secrets"

# Settings file (no secrets). Created once, never overwritten.
if [ ! -f "$STATE/sync.env" ]; then
  cat > "$STATE/sync.env" <<'ENV'
# Einstellungen für den Immowelt-Abgleich (keine Geheimnisse; der API-Schlüssel liegt in secrets/immowelt-api.json).
# Adresse: "locality" = nur PLZ/Ort (Standard) | "street" = Straße so, wie die API sie liefert.
#IMMOWELT_ADDRESS_MODE=locality
# Größere Bildvariante anfragen (undokumentiert; fällt je Bild auf die gelieferte 640er-Variante zurück):
#IMMOWELT_IMAGE_SIZE=1920x0
# Prüfung nach dem Umschalten: leer = aus
#EICHMANN_SMOKE_URL=http://127.0.0.1/ai/build.json
ENV
  chmod 644 "$STATE/sync.env"
fi

for unit in eichmann-immowelt-sync.service eichmann-immowelt-sync.timer eichmann-sync-watchdog.service eichmann-sync-watchdog.timer; do
  install -m 644 "$APP/deploy/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload

# Old schedulers must not run next to the timer. They would only start the same (locked) run,
# but a second schedule is exactly the kind of thing nobody remembers later – report it.
if grep -rsl "sync-immowelt" /etc/cron.d /etc/crontab /var/spool/cron 2>/dev/null | grep -q .; then
  echo "HINWEIS: Alte Cron-Einträge mit sync-immowelt gefunden – bitte entfernen:"
  grep -rsl "sync-immowelt" /etc/cron.d /etc/crontab /var/spool/cron 2>/dev/null || true
fi

case "$MODE" in
  --enable)
    systemctl enable --now eichmann-immowelt-sync.timer eichmann-sync-watchdog.timer
    ;;
  --disable)
    systemctl disable --now eichmann-immowelt-sync.timer eichmann-sync-watchdog.timer || true
    ;;
  "") ;;
  *) echo "Unbekannte Option: $MODE"; exit 2 ;;
esac

echo "Timer:"
systemctl list-timers --all --no-pager 'eichmann-*' 2>/dev/null | sed -n '1,6p' || true
echo "Schlüssel:"
( cd "$APP" && node scripts/immowelt-secret-install.mjs --status ) || true
echo "immowelt-sync install OK"
