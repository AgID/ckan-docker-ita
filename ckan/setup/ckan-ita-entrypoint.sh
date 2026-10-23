#!/bin/bash
# =====================================================================
#  ENTRYPOINT dell'immagine CKAN 2.10.
#
#  Segreti applicativi: se nel .env CKAN___BEAKER__SESSION__SECRET e i segreti
#  JWT sono assenti, vuoti o lasciati a CHANGE_ME, vengono generati una sola
#  volta e salvati nel volume ckan_storage
#  (${CKAN_STORAGE_PATH}/.ckan-docker-ita.secrets), cosi' restano stabili tra
#  un riavvio e l'altro e i token API non si invalidano a ogni ricreazione
#  del container. Se nel .env ci sono valori reali, lo script non tocca nulla.
#
#  I segreti vengono esportati per il processo avviato e scritti anche in
#  ckan.ini, cosi' valgono anche per i comandi lanciati con `docker compose exec`
#  (purche' nel .env le righe dei segreti siano commentate, non CHANGE_ME).
# =====================================================================
set -e

is_placeholder() {
  case "$1" in
    ""|CHANGE_ME|string:CHANGE_ME) return 0 ;;
    *) return 1 ;;
  esac
}

if is_placeholder "${CKAN___BEAKER__SESSION__SECRET:-}" \
   || is_placeholder "${CKAN___API_TOKEN__JWT__ENCODE__SECRET:-}" \
   || is_placeholder "${CKAN___API_TOKEN__JWT__DECODE__SECRET:-}"; then

  SECRETS_FILE="${CKAN_STORAGE_PATH:-/var/lib/ckan}/.ckan-docker-ita.secrets"

  if [ ! -s "$SECRETS_FILE" ]; then
    echo "[entrypoint] Segreti non impostati nel .env: li genero in $SECRETS_FILE"
    mkdir -p "$(dirname "$SECRETS_FILE")"
    umask 077
    {
      echo "GEN_BEAKER_SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
      echo "GEN_JWT_SECRET=string:$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
    } > "${SECRETS_FILE}.tmp"
    mv "${SECRETS_FILE}.tmp" "$SECRETS_FILE"
  fi

  # shellcheck disable=SC1090
  . "$SECRETS_FILE"

  is_placeholder "${CKAN___BEAKER__SESSION__SECRET:-}" && export CKAN___BEAKER__SESSION__SECRET="$GEN_BEAKER_SECRET"
  is_placeholder "${CKAN___API_TOKEN__JWT__ENCODE__SECRET:-}" && export CKAN___API_TOKEN__JWT__ENCODE__SECRET="$GEN_JWT_SECRET"
  is_placeholder "${CKAN___API_TOKEN__JWT__DECODE__SECRET:-}" && export CKAN___API_TOKEN__JWT__DECODE__SECRET="$GEN_JWT_SECRET"

  if [ -w "${CKAN_INI:-/srv/app/ckan.ini}" ]; then
    ckan config-tool "${CKAN_INI:-/srv/app/ckan.ini}" \
      "beaker.session.secret=${CKAN___BEAKER__SESSION__SECRET}" \
      "api_token.jwt.encode.secret=${CKAN___API_TOKEN__JWT__ENCODE__SECRET}" \
      "api_token.jwt.decode.secret=${CKAN___API_TOKEN__JWT__DECODE__SECRET}" >/dev/null \
      || echo "[entrypoint] ATTENZIONE: impossibile scrivere i segreti in ckan.ini"
  fi
fi

exec "$@"
