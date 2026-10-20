#!/usr/bin/env bash
# Report settimanale di validazione dei cataloghi (lanciato da cron il lunedi').
# Richiede solo Python 3.9+: le librerie sono dentro report_settimanale.pyz.
#
# Configurazione: file run_validazione.conf nella stessa cartella dello script
# (non va nella repo), con le variabili
#   OUT=<cartella di uscita del report>               obbligatoria
#   URL=<indirizzo pubblico di index.html>            facoltativa, per il link su Telegram
#   TG=<file JSON del bot Telegram>                   facoltativa, default report-validazione.json qui
# In alternativa le stesse variabili si passano nell'ambiente.
#
# crontab -e:
#   0 7 * * 1  <cartella dello script>/run_validazione.sh
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$DIR/run_validazione.conf" ] && . "$DIR/run_validazione.conf"
OUT="${OUT:-}"
TG="${TG:-$DIR/report-validazione.json}"      # {"token": "...", "chat_id": "..."}, permessi 600 (fuori dalla web root)
URL="${URL:-}"
if [ -z "$OUT" ]; then
  echo "OUT non impostata: indicare la cartella di uscita in $DIR/run_validazione.conf" >&2
  exit 2
fi
LOG="$DIR/validazione.log"

# si scrive in una cartella temporanea e si sostituisce alla fine: chi apre la pagina
# durante l'esecuzione vede ancora il report della settimana precedente
TMP="${OUT}.tmp"
rm -rf "$TMP"
{
  echo "=== $(date '+%F %T') avvio"
  args=(--out "$TMP")
  [ -f "$TG" ] && args+=(--telegram "$TG")
  [ -f "$TG" ] && [ -n "$URL" ] && args+=(--url-report "$URL")
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
