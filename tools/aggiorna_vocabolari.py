#!/usr/bin/env python3
"""
Aggiorna gli elenchi chiusi usati dal profilo "vocabolari" del validatore:
formati (vocabolario EU file-type) e media type (registro IANA), presi dalle
API di data.europa.eu, le stesse usate dall'MQA.

Scrive tools/shapes/vocabolari-elenchi.ttl, letto sia dal validatore web
(tools/validatore-web, dopo `npm run build`) sia da validate_edp_shacl.py.
Si lancia a mano quando si vuole aggiornare l'elenco:

  python3 tools/aggiorna_vocabolari.py
  python3 tools/aggiorna_vocabolari.py --base https://ppe.data.europa.eu   # pre-produzione

Il confronto dei media type avviene su tipo/sottotipo, senza distinguere
http/https, www e maiuscole: EDP considera validi anche gli
https://iana.org/... prodotti da CKAN. I formati si confrontano sull'URI esatto.
"""
import argparse
import datetime
import json
import os
import re
import sys
import urllib.request

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shapes", "vocabolari-elenchi.ttl")
FILE_TYPE_NS = "http://publications.europa.eu/resource/authority/file-type/"
IANA_RE = re.compile(r"^https?://(www\.)?iana\.org/assignments/media-types/([^/\s]+)/([^/\s]+)$", re.I)


def fetch(base, vocab):
    url = f"{base.rstrip('/')}/api/hub/search/vocabularies/{vocab}"
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "validatore-dcatapit"})
    with urllib.request.urlopen(req, timeout=120) as r:
        res = json.load(r)["result"]
    items = [x["resource"] for x in res["results"] if x.get("resource")]
    if len(items) != res.get("count", len(items)):
        sys.exit(f"{vocab}: ricevute {len(items)} voci su {res.get('count')}: risposta incompleta, file non aggiornato")
    return url, items


def rx_escape(s):
    # solo i metacaratteri regex; niente escape di '-' (non valido in alcune modalita' JS)
    return re.sub(r"([.+*?^$()\[\]{}|\\/])", r"\\\1", s)


def ttl_string(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="https://data.europa.eu")
    a = ap.parse_args()

    ft_url, ft = fetch(a.base, "file-type")
    mt_url, mt = fetch(a.base, "iana-media-types")

    formats = sorted({u for u in ft if u.startswith(FILE_TYPE_NS)})
    by_type = {}
    skipped = []
    for u in mt:
        m = IANA_RE.match(u)
        if not m:
            skipped.append(u)
            continue
        by_type.setdefault(m.group(2).lower(), set()).add(m.group(3).lower())
    if len(formats) < 100 or sum(map(len, by_type.values())) < 1000:
        sys.exit("Elenchi troppo corti: risposta anomala, file non aggiornato")

    alts = "|".join(f"{rx_escape(t)}/(?:{'|'.join(rx_escape(s) for s in sorted(subs))})"
                    for t, subs in sorted(by_type.items()))
    pattern = r"^https?://(www\.)?iana\.org/assignments/media-types/(?:" + alts + r")$"
    n_mt = sum(map(len, by_type.values()))
    oggi = datetime.date.today().isoformat()

    lines = [
        "@prefix sh:   <http://www.w3.org/ns/shacl#> .",
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "@prefix dcat: <http://www.w3.org/ns/dcat#> .",
        "@prefix dct:  <http://purl.org/dc/terms/> .",
        "@prefix voc:  <urn:validatore-dcatapit:shapes:vocabolari#> .",
        "",
        "# FILE GENERATO da tools/aggiorna_vocabolari.py: non modificare a mano.",
        f"# Aggiornato il {oggi} da:",
        f"#   {ft_url}  ({len(formats)} formati)",
        f"#   {mt_url}  ({n_mt} media type)",
        "# Fa parte del profilo \"vocabolari\": controlla che formato e media type",
        "# delle distribuzioni siano voci esistenti dei vocabolari usati dall'MQA.",
        "",
        "voc:DistributionElenchi a sh:NodeShape ;",
        "  rdfs:label \"Formato e media type nei vocabolari di data.europa.eu\" ;",
        "  sh:targetClass dcat:Distribution ;",
        "  sh:property",
        "    [ sh:path dct:format ; sh:severity sh:Violation ;",
        "      sh:in (",
        *[f"        <{u}>" for u in formats],
        "      ) ;",
        f"      sh:message \"Formato non presente nel vocabolario EU file-type (elenco di data.europa.eu del {oggi})\" ] ,",
        "    [ sh:path dcat:mediaType ; sh:severity sh:Warning ;",
        "      sh:flags \"i\" ;",
        f"      sh:pattern {ttl_string(pattern)} ;",
        f"      sh:message \"Media type non presente nel registro IANA (elenco di data.europa.eu del {oggi})\" ] .",
        "",
    ]
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"Scritto {OUT}: {len(formats)} formati, {n_mt} media type"
          + (f", {len(skipped)} voci IANA ignorate (URI non standard)" if skipped else ""))
    print("Per il validatore web: cd tools/validatore-web && npm run build")


if __name__ == "__main__":
    main()
