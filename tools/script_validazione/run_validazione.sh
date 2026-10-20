#!/usr/bin/env bash
# Report settimanale di validazione dei cataloghi (lanciato da cron il lunedi').
# Richiede solo Python 3.9+: le librerie sono dentro report_settimanale.pyz.
#
# crontab -e:
#   0 7 * * 1  /home/ubuntu/PORTALE-DATIGOV-Crontab/script_validazione/run_validazione.sh
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-/home/ubuntu/portale-datigov/volume-drupal/default/files/monitoraggio/files/validazione}"
TG="${TG:-$HOME/.config/report-validazione.json}"      # {"token": "...", "chat_id": "..."}, permessi 600
URL="${URL:-https://www.dati.gov.it/sites/default/files/monitoraggio/files/validazione/index.html}"
LOG="$DIR/validazione.log"

# si scrive in una cartella temporanea e si sostituisce alla fine: chi apre la pagina
# durante l'esecuzione vede ancora il report della settimana precedente
TMP="${OUT}.tmp"
rm -rf "$TMP"
{
  echo "=== $(date '+%F %T') avvio"
  args=(--out "$TMP")
  [ -f "$TG" ] && args+=(--telegram "$TG" --url-report "$URL")
  if python3 "$DIR/report_settimanale.pyz" "${args[@]}"; then
    rm -rf "${OUT}.old"
    [ -d "$OUT" ] && mv "$OUT" "${OUT}.old"
    mv "$TMP" "$OUT" && rm -rf "${OUT}.old"
    echo "=== $(date '+%F %T') fine: report in $OUT"
  else
    echo "=== $(date '+%F %T') ERRORE: report precedente lasciato invariato"
  fi
} >> "$LOG" 2>&1
# tiene il log corto: ultime 2000 righe
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
