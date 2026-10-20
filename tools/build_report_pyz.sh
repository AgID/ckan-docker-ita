#!/usr/bin/env bash
# Crea tools/dist/report_settimanale.pyz: un unico file eseguibile con
#   python3 report_settimanale.pyz --out ...
# che contiene lo script, le regole (tools/shapes) e le librerie rdflib e pyshacl
# (tutte in puro Python). Sul server serve solo Python 3.9 o successivo:
# niente pip, niente installazioni.
#
# Uso: tools/build_report_pyz.sh [versione-python-minima]   (default 3.9)
set -euo pipefail
cd "$(dirname "$0")"
PYV="${1:-3.9}"
B=build/report_pyz
rm -rf "$B" && mkdir -p "$B" dist
# librerie compatibili con la versione minima, solo pacchetti in puro Python
python3 -m pip install --quiet --disable-pip-version-check --target "$B" \
  --python-version "$PYV" --only-binary=:all: --implementation py --no-compile \
  rdflib pyshacl isodate importlib-metadata zipp typing-extensions   # dipendenze condizionali per Python < 3.11
rm -rf "$B"/bin "$B"/*.dist-info/RECORD
cp validate_edp_shacl.py report_settimanale.py "$B"/
mkdir -p "$B"/shapes/edp
cp shapes/*.ttl "$B"/shapes/
cp shapes/edp/*.ttl "$B"/shapes/edp/
cat > "$B"/__main__.py <<'EOF'
import sys
import report_settimanale
sys.exit(report_settimanale.main())
EOF
python3 -m zipapp "$B" -c -o dist/report_settimanale.pyz -p "/usr/bin/env python3"
ls -la dist/report_settimanale.pyz
