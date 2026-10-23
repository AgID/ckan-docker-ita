#!/bin/bash
# CSS predefinito del portale (tema accessibile WCAG 2.1 AA, file css.example).
#
# Il CSS personalizzato di CKAN (Admin > Config > "Custom CSS") vive nel DB,
# tabella system_info, chiave ckan.site_custom_css. A ogni avvio, prima che
# parta il web server:
#   - se il CSS personalizzato e' vuoto, viene impostato css.example;
#   - se contiene ancora il css.example applicato in precedenza (nessuna
#     modifica dall'admin), viene aggiornato alla versione dell'immagine;
#   - se l'admin l'ha modificato, non viene toccato.
# Per tornare al predefinito: svuotare il "Custom CSS" dall'admin e riavviare,
# oppure CKAN_CUSTOM_CSS_FORCE=true per un avvio.
# CKAN_CUSTOM_CSS_DEFAULT=false disattiva del tutto lo script.

CSS_FILE="${APP_DIR:-/srv/app}/css.example"
CSS_MARKER="${CKAN_STORAGE_PATH:-/var/lib/ckan}/.ckan-docker-ita.custom-css.sha256"

if [[ "${CKAN_CUSTOM_CSS_DEFAULT:-true}" != "true" ]]; then
  echo "[css] CKAN_CUSTOM_CSS_DEFAULT=false: CSS predefinito non applicato"
elif [ ! -f "$CSS_FILE" ]; then
  echo "[css] ATTENZIONE: $CSS_FILE assente, CSS predefinito non applicato"
else
  python3 - "$CSS_FILE" "$CSS_MARKER" "${CKAN_CUSTOM_CSS_FORCE:-false}" <<'PY'
import hashlib, os, sys, psycopg2

css_file, marker, force = sys.argv[1], sys.argv[2], sys.argv[3] == "true"
KEY = "ckan.site_custom_css"
sha = lambda s: hashlib.sha256((s or "").strip().encode("utf-8")).hexdigest()

new_css = open(css_file, encoding="utf-8").read()
try:
    applied = open(marker).read().strip()
except OSError:
    applied = ""

try:
    conn = psycopg2.connect(os.environ["CKAN_SQLALCHEMY_URL"])
    cur = conn.cursor()
    cur.execute("select value from system_info where key = %s and state = 'active'", (KEY,))
    row = cur.fetchone()
    current = (row[0] if row else "") or ""

    if sha(current) == sha(new_css):
        action = None
    elif force or not current.strip() or sha(current) == applied:
        action = "applicato" if not current.strip() else "aggiornato"
    else:
        print("[css] Custom CSS modificato dall'admin: lasciato invariato "
              "(svuotarlo dall'admin e riavviare per tornare al predefinito)")
        action = None

    if action:
        cur.execute(
            "insert into system_info (key, value, state) values (%s, %s, 'active') "
            "on conflict (key) do update set value = excluded.value, state = 'active'",
            (KEY, new_css))
        conn.commit()
        print(f"[css] CSS predefinito {action} (css.example)")
    if action or sha(current) == sha(new_css):
        with open(marker, "w") as fh:
            fh.write(sha(new_css))
    conn.close()
except Exception as exc:
    print(f"[css] ATTENZIONE: CSS predefinito non applicato: {exc}")
PY
fi
