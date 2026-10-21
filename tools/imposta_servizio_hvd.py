#!/usr/bin/env python3
"""
Collega un servizio dati HVD (dcat:DataService) a tutte le risorse dei dataset che serve.

Per ogni dataset elencato in "serves_dataset" del file del servizio:
  - sulle risorse servite dal servizio, cioe' con l'indirizzo sullo stesso server di un
    endpoint_url (o tutte, con --tutte), scrive il campo access_services con il servizio
    (sostituisce un servizio con lo stesso "uri", lascia gli altri);
  - su tutte le risorse aggiunge applicable_legislation con l'ELI 2023/138 se manca
    (in un dataset HVD lo devono dichiarare tutte le distribuzioni; gli altri valori restano).

Il file del servizio e' un JSON come quello del campo access_services (un oggetto o
una lista con un oggetto), con le chiavi lette dal profilo DCAT-AP 2:
uri, title, description, endpoint_url, endpoint_description, page, hvd_category,
applicable_legislation, contact_point {name, email}, license, access_rights,
availability, serves_dataset.

Uso (serve un token API di un amministratore del portale):
  export CKAN_API_TOKEN=...
  python3 imposta_servizio_hvd.py --ckan https://dati.puglia.it/ckan --servizio servizio.json            # prova
  python3 imposta_servizio_hvd.py --ckan https://dati.puglia.it/ckan --servizio servizio.json --applica  # scrive

Solo libreria standard di Python 3.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HVD_ELI = "http://data.europa.eu/eli/reg_impl/2023/138/oj"


def call(base, action, data=None, token=None):
    url = f"{base.rstrip('/')}/api/3/action/{action}"
    headers = {"Content-Type": "application/json", "User-Agent": "imposta-servizio-hvd"}
    if token:
        headers["Authorization"] = token
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method="POST" if body else "GET")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            err = json.load(e).get("error")
        except Exception:
            err = str(e)
        raise RuntimeError(f"{action}: HTTP {e.code} {err}")
    if not res.get("success"):
        raise RuntimeError(f"{action}: {res.get('error')}")
    return res["result"]


def as_list(v):
    if v in (None, ""):
        return []
    if isinstance(v, list):
        return v
    try:
        x = json.loads(v)
        return x if isinstance(x, list) else [x]
    except (TypeError, ValueError):
        return [v]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ckan", required=True, help="indirizzo base del CKAN, es. https://dati.puglia.it/ckan")
    ap.add_argument("--servizio", required=True, help="file JSON del servizio")
    ap.add_argument("--applica", action="store_true", help="scrive davvero (senza: solo prova)")
    ap.add_argument("--tutte", action="store_true",
                    help="servizio su tutte le risorse, non solo su quelle sul server dell'endpoint")
    a = ap.parse_args()

    token = os.environ.get("CKAN_API_TOKEN", "")
    if a.applica and not token:
        sys.exit("Serve CKAN_API_TOKEN (token API di un amministratore) per scrivere")

    with open(a.servizio, encoding="utf-8") as fh:
        svc = json.load(fh)
    if isinstance(svc, list):
        if len(svc) != 1:
            sys.exit("Il file deve contenere un solo servizio")
        svc = svc[0]
    for k in ("uri", "serves_dataset", "endpoint_url"):
        if not svc.get(k):
            sys.exit(f"Nel servizio manca la chiave {k}")
    if svc.get("hvd_category") and not svc.get("applicable_legislation"):
        svc["applicable_legislation"] = [HVD_ELI]

    ids = [u.rstrip("/").rsplit("/", 1)[-1] for u in svc["serves_dataset"]]
    hosts = {urllib.parse.urlsplit(u).netloc.lower() for u in as_list(svc["endpoint_url"])}
    print(f"Servizio {svc['uri']} · {len(ids)} dataset · {'SCRITTURA' if a.applica else 'prova (nessuna modifica)'}\n")
    n_ris = n_mod = 0
    for did in ids:
        try:
            ds = call(a.ckan, "package_show", {"id": did}, token)
        except RuntimeError as e:
            print(f"  ! {did}: {e}")
            continue
        print(f"{ds['name']}  ({len(ds.get('resources', []))} risorse)")
        for r in ds.get("resources", []):
            n_ris += 1
            # access_services: si sostituisce solo il servizio con lo stesso uri
            servita = a.tutte or urllib.parse.urlsplit(r.get("url") or "").netloc.lower() in hosts
            altri = [s for s in as_list(r.get("access_services")) if isinstance(s, dict) and s.get("uri") != svc["uri"]]
            nuovo_as = json.dumps(altri + [svc], ensure_ascii=False)
            leg = [x for x in as_list(r.get("applicable_legislation")) if x]
            nuovo_leg = leg if HVD_ELI in leg else leg + [HVD_ELI]
            patch = {}
            if servita and r.get("access_services") != nuovo_as:
                patch["access_services"] = nuovo_as
            if nuovo_leg != leg:
                patch["applicable_legislation"] = json.dumps(nuovo_leg)
            nome = (r.get("name") or r["id"])[:60]
            if not patch:
                print(f"    = {nome}: gia' a posto")
                continue
            n_mod += 1
            print(f"    {'*' if a.applica else '~'} {nome}: {', '.join(sorted(patch))}")
            if a.applica:
                try:
                    call(a.ckan, "resource_patch", {"id": r["id"], **patch}, token)
                except RuntimeError as e:
                    print(f"      ! errore: {e}")
    print(f"\n{n_ris} risorse esaminate, {n_mod} {'aggiornate' if a.applica else 'da aggiornare'}")
    if not a.applica and n_mod:
        print("Per scrivere: rilancia con --applica")


if __name__ == "__main__":
    main()
