#!/usr/bin/env bash
# One-time conversion of the webroot into the atomic release layout. Idempotent; root only.
#
#   before   /var/www/immobilieneichmann.de/            plain directory, edited in place by deploys and publishes
#   after    /var/www/immobilieneichmann.de  ->  /var/lib/eichmann/releases/current  ->  <release-id>/
#
# What stays where it is, outside the releases (linked into every release):
#   media/                          -> /var/lib/eichmann/media            (own uploads, Immowelt pictures)
#   admin/config.json               -> /var/lib/eichmann/admin-config.json
#   data/immowelt-sync-status.json  -> /var/lib/eichmann/status/immowelt-sync-status.json
#   .well-known/acme-challenge      -> /var/lib/eichmann/acme-challenge   (Let's Encrypt)
#
# The first release is built from the database AS IT IS (last known good) – no Immowelt call,
# no content change. nginx needs no change: its root path stays the same.
#
# Rollback of this script:  see the last lines it prints (one mv back).
set -euo pipefail

SITE="${EICHMANN_WEBROOT:-/var/www/immobilieneichmann.de}"
STATE=/var/lib/eichmann
APP="$STATE/app"
REL="$STATE/releases"

[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausführen."; exit 1; }

if [ -L "$SITE" ] && [ "$(readlink -f "$SITE")" != "${SITE}" ] && readlink -f "$SITE" | grep -q "^$REL/"; then
  echo "Release-Layout ist bereits aktiv: $SITE -> $(readlink "$SITE") -> $(readlink "$REL/current")"
  exit 0
fi
[ -d "$SITE" ] || { echo "Webroot $SITE nicht gefunden."; exit 1; }
[ -f "$APP/scripts/release.mjs" ] || { echo "Fehlt: $APP/scripts/release.mjs – erst App-Stand übertragen"; exit 1; }
[ -d "$APP/node_modules/better-sqlite3" ] || { echo "Fehlt: node_modules in $APP (npm ci)"; exit 1; }
[ -f "$STATE/listings.db" ] || { echo "Fehlt: $STATE/listings.db"; exit 1; }

install -d -m 755 "$REL" "$STATE/status" "$STATE/acme-challenge"

echo "0/5 App-Sicherung (Datenbank, eigene Bilder, Admin-Einstellungen) vor der Umstellung"
# Same command as the 12-hourly cron. The conversion does not start without a fresh backup.
( cd "$APP" && EICHMANN_DB_PATH="$STATE/listings.db" EICHMANN_SITE_ROOT="$SITE" node scripts/snapshot-cli.mjs create ) \
  || { echo "App-Sicherung fehlgeschlagen – Umstellung nicht begonnen."; exit 1; }

echo "1/5 Dauerhafte Teile aus dem Webroot übernehmen (Kopie, das Original bleibt bis zum Schluss unangetastet)"
copy_media() {  # re-runnable: adds what is missing, never overwrites
  install -d -m 775 "$STATE/media" "$STATE/media/eigen"
  [ ! -d "$SITE/media" ] || [ -L "$SITE" ] || cp -a -n "$SITE/media/." "$STATE/media/"
}
copy_media
SRC_N=$( { find "$SITE/media" -type f 2>/dev/null || true; } | wc -l)
DST_N=$(find "$STATE/media" -type f -not -path "$STATE/media/immowelt/*" | wc -l)
[ "$DST_N" -ge "$SRC_N" ] || { echo "Medien unvollständig kopiert ($DST_N von $SRC_N)."; exit 1; }
chown -R www-data:www-data "$STATE/media/eigen" || true
if [ -f "$SITE/admin/config.json" ] && [ ! -L "$SITE/admin/config.json" ] && [ ! -f "$STATE/admin-config.json" ]; then
  cp -a "$SITE/admin/config.json" "$STATE/admin-config.json"
fi
if [ -f "$SITE/data/immowelt-sync-status.json" ] && [ ! -f "$STATE/status/immowelt-sync-status.json" ]; then
  cp -a "$SITE/data/immowelt-sync-status.json" "$STATE/status/immowelt-sync-status.json"
fi
if [ -d "$SITE/.well-known/acme-challenge" ]; then cp -a "$SITE/.well-known/acme-challenge/." "$STATE/acme-challenge/" 2>/dev/null || true; fi

echo "2/5 Erstes Release aus der Datenbank bauen und prüfen (noch nicht sichtbar)"
( cd "$APP" && EICHMANN_DB_PATH="$STATE/listings.db" node scripts/release.mjs build --bootstrap --reason bootstrap --wait 600 )
CUR="$(readlink "$REL/current")"
[ -f "$REL/$CUR/index.html" ] || { echo "Release wurde nicht erzeugt."; exit 1; }

echo "3/5 Gegenprobe: gleiche Angebote wie bisher?"
OLD_N=$(find "$SITE/objekt" -maxdepth 1 -name '*.html' 2>/dev/null | wc -l)
NEW_N=$(find "$REL/$CUR/objekt" -maxdepth 1 -name '*.html' | wc -l)
echo "    Objektseiten bisher: $OLD_N · im Release: $NEW_N"
if [ "$OLD_N" -ne "$NEW_N" ] && [ "${ALLOW_COUNT_CHANGE:-0}" != "1" ]; then
  echo "    Anzahl weicht ab – Abbruch, nichts wurde umgeschaltet. (Bewusst fortfahren: ALLOW_COUNT_CHANGE=1)"
  exit 1
fi

echo "4/5 Webroot atomar gegen den Symlink tauschen"
nginx -t
copy_media   # uploads made while the release was being built
STAMP="$(date +%Y%m%d-%H%M%S)"
NEWLINK="${SITE}.release-link"
KEEP="${SITE}.pre-release-${STAMP}"
rm -f "$NEWLINK"
ln -s "$REL/current" "$NEWLINK"
# renameat2(RENAME_EXCHANGE): directory and symlink swap places in one step – no moment without a webroot.
if python3 - "$NEWLINK" "$SITE" <<'PY'
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
AT_FDCWD, RENAME_EXCHANGE = -100, 2
r = libc.syscall(316 if os.uname().machine == "x86_64" else 276, AT_FDCWD, sys.argv[1].encode(), AT_FDCWD, sys.argv[2].encode(), RENAME_EXCHANGE)
sys.exit(0 if r == 0 else 1)
PY
then
  mv "$NEWLINK" "$KEEP"          # $NEWLINK now holds the old directory
else
  echo "    (Tausch in einem Schritt nicht möglich – zwei Schritte, Lücke < 1 ms)"
  mv "$SITE" "$KEEP"
  mv "$NEWLINK" "$SITE"
fi

echo "5/5 Prüfen, dass der Webserver das Release ausliefert"
OK=0
for i in 1 2 3 4 5; do
  if curl -fsS --max-time 5 http://127.0.0.1/ai/build.json | grep -q "\"release_id\": \"$CUR\""; then OK=1; break; fi
  sleep 1
done
if [ "$OK" -ne 1 ]; then
  if curl -fsS --max-time 5 -o /dev/null https://immobilieneichmann.de/ 2>/dev/null && [ -f "$SITE/ai/build.json" ] && grep -q "\"release_id\": \"$CUR\"" "$SITE/ai/build.json"; then
    echo "    http://127.0.0.1 liefert die Kennung nicht (abweichende nginx-Konfiguration), die Seite selbst ist erreichbar."
    echo "    Die Prüfung nach dem Umschalten wird deshalb abgeschaltet: EICHMANN_SMOKE_URL= in $STATE/sync.env"
    grep -q '^EICHMANN_SMOKE_URL=' "$STATE/sync.env" 2>/dev/null || echo 'EICHMANN_SMOKE_URL=' >> "$STATE/sync.env"
  else
    echo "    Webserver liefert das Release NICHT aus – Umstellung wird zurückgenommen."
    rm -f "$SITE" && mv "$KEEP" "$SITE"
    exit 1
  fi
fi

echo
echo "Release-Layout aktiv: $SITE -> $REL/current -> $CUR"
echo "Das bisherige Verzeichnis liegt unverändert unter: $KEEP"
echo "Zurück zum alten Zustand (falls nötig):  cp -a -n $STATE/media/. $KEEP/media/ && rm $SITE && mv $KEEP $SITE"
echo "Aufräumen, wenn alles passt (frühestens nach einigen Tagen):  rm -rf $KEEP"
