#!/usr/bin/env python3
"""
Validazione SHACL del catalog.ttl con lo stesso profilo usato da data.europa.eu.

data.europa.eu (piveau) valida i metadati harvestati con il profilo
"DCAT-AP 3.0.1 Level 1" = shapes.ttl + deprecateduris.ttl del progetto
piveau-metrics-validating-shacl. Non sono le shape SEMIC "pure": piveau aggiunge
regole proprie (es. StatusRestrictionADMS) e nel Level 1 non controlla i
vocabolari. Questo script riproduce quella validazione su un campione del
catalogo, per vedere violazioni e warning PRIMA che compaiano su EDP.

Uso:
  python3 validate_edp_shacl.py https://dati.gov.it/opendata
  python3 validate_edp_shacl.py https://dati.gov.it/opendata --name interventi-aerei-aib-protezione-civile
  python3 validate_edp_shacl.py https://dati.gov.it/opendata --pages 3
  python3 validate_edp_shacl.py https://dati.gov.it/opendata --fq organization:regione-puglia --pages 2
  python3 validate_edp_shacl.py --file catalog.ttl   # TTL gia' scaricato in locale
  python3 validate_edp_shacl.py https://dati.gov.it/opendata --level 2   # anche le raccomandate

Opzioni:
  --name NOME       uno o piu' dataset (ripetibile), via catalog.ttl?fq=name:NOME
  --fq FILTRO       filtro Solr libero sul catalog.ttl (ripetibile)
  --pages N         pagine del catalog.ttl da validare (default 1, 100 dataset/pagina)
  --level 1|2       1 = profilo EDP (default), 2 = aggiunge le shape raccomandate
  --dcatap 3.0.1    versione delle shape (default 3.0.1, come EDP oggi)
  --examples N      esempi per ogni tipo di segnalazione (default 2)
  --json FILE       salva il riepilogo anche in JSON

Uscita: codice 0 se non ci sono Violation, 1 se ce ne sono, 2 per errori.
Dipendenze: pip install rdflib pyshacl
Nota: dati.gov.it va interrogato senza "www" (la WAF blocca le richieste non-browser).
"""
import argparse
import collections
import json
import os
import sys
import tempfile
import urllib.parse
import urllib.request

try:
    from rdflib import Graph, URIRef
    from pyshacl import validate
except ImportError:
    sys.exit("Servono rdflib e pyshacl: pip install rdflib pyshacl")

SHAPES_BASE = ("https://gitlab.com/piveau/metrics/piveau-metrics-validating-shacl/"
               "-/raw/develop/src/main/resources/rdf/shapes/dcat-ap/{v}/{f}")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
SH = "http://www.w3.org/ns/shacl#"
CACHE = os.path.join(tempfile.gettempdir(), "edp-shacl-shapes")


def fetch(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/turtle"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def load_shapes(version, level):
    files = ["shapes.ttl", "deprecateduris.ttl"]
    if level >= 2:
        files.append("shapes_recommended.ttl")
    os.makedirs(os.path.join(CACHE, version), exist_ok=True)
    g = Graph()
    for f in files:
        path = os.path.join(CACHE, version, f)
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(fetch(SHAPES_BASE.format(v=version, f=f)))
        g.parse(path, format="turtle")
    return g, files


def catalog_urls(base, names, fqs, pages):
    base = base.rstrip("/") + "/catalog.ttl"
    if names:
        return [f"{base}?fq=name:{urllib.parse.quote(n)}" for n in names]
    q = "&".join(f"fq={urllib.parse.quote(x)}" for x in fqs)
    return [f"{base}?{q + '&' if q else ''}page={p}" for p in range(1, pages + 1)]


def short(u):
    u = str(u)
    for k, v in (("http://www.w3.org/ns/", ""), ("http://purl.org/dc/terms/", "dct:"),
                 ("http://data.europa.eu/r5r/", "dcatap:"), ("http://xmlns.com/foaf/0.1/", "foaf:")):
        u = u.replace(k, v)
    return u


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("base", nargs="?", help="URL base CKAN, es. https://dati.gov.it/opendata")
    ap.add_argument("--file", help="valida un file TTL locale invece di scaricarlo")
    ap.add_argument("--name", action="append", default=[])
    ap.add_argument("--fq", action="append", default=[])
    ap.add_argument("--pages", type=int, default=1)
    ap.add_argument("--level", type=int, default=1, choices=(1, 2))
    ap.add_argument("--dcatap", default="3.0.1")
    ap.add_argument("--examples", type=int, default=2)
    ap.add_argument("--json")
    a = ap.parse_args()
    if not a.base and not a.file:
        ap.error("serve l'URL base del CKAN oppure --file")

    try:
        shapes, files = load_shapes(a.dcatap, a.level)
    except Exception as e:
        print(f"ERRORE nel caricamento delle shape: {e}", file=sys.stderr)
        return 2
    print(f"Profilo: DCAT-AP {a.dcatap} Level {a.level} (piveau: {', '.join(files)})")

    # Ogni pagina si valida da sola, come fa EDP: unire le pagine in un unico
    # grafo duplicherebbe i nodi anonimi dei sottocataloghi (es. dct:publisher
    # di dati.trentino.it ripetuto in piu' pagine) e creerebbe falsi
    # MaxCount sul publisher.
    sources = []
    if a.file:
        if not os.path.isfile(a.file):
            print(f"ERRORE: file non trovato: {a.file}", file=sys.stderr)
            return 2
        sources.append((a.file, open(a.file, encoding="utf-8").read()))
    else:
        for u in catalog_urls(a.base, a.name, a.fq, a.pages):
            try:
                sources.append((u, fetch(u)))
                print(f"  OK  {u}")
            except Exception as e:
                print(f"  ERR {u}: {e}", file=sys.stderr)
    if not sources:
        print("Nessun dato da validare", file=sys.stderr)
        return 2

    RDF_TYPE = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
    counts = collections.Counter()
    examples = collections.defaultdict(list)
    n_ds = n_dist = n_triples = 0
    conforms = True
    for src, ttl in sources:
        data = Graph()
        data.parse(data=ttl, format="turtle")
        n_ds += len(set(data.subjects(RDF_TYPE, URIRef("http://www.w3.org/ns/dcat#Dataset"))))
        n_dist += len(set(data.subjects(RDF_TYPE, URIRef("http://www.w3.org/ns/dcat#Distribution"))))
        n_triples += len(data)
        ok, rg, _ = validate(data, shacl_graph=shapes, inference="none", allow_warnings=True)
        conforms = conforms and ok
        for r in rg.objects(None, URIRef(SH + "result")):
            sev = str(rg.value(r, URIRef(SH + "resultSeverity"))).split("#")[-1]
            path = short(rg.value(r, URIRef(SH + "resultPath")) or "-")
            shape = rg.value(r, URIRef(SH + "sourceShape"))
            node = rg.value(shape, URIRef(SH + "node")) if shape is not None else None
            rule = short(node) if node is not None else \
                str(rg.value(r, URIRef(SH + "sourceConstraintComponent"))).split("#")[-1]
            key = (sev, path, rule)
            counts[key] += 1
            if len(examples[key]) < a.examples:
                examples[key].append({
                    "source": src,
                    "focus": str(rg.value(r, URIRef(SH + "focusNode"))),
                    "value": str(rg.value(r, URIRef(SH + "value")) or ""),
                    "message": str(rg.value(r, URIRef(SH + "resultMessage")) or ""),
                })
    print(f"Dataset: {n_ds}  Distribuzioni: {n_dist}  Triple: {n_triples}")

    n_viol = sum(v for (s, _, _), v in counts.items() if s == "Violation")
    n_warn = sum(v for (s, _, _), v in counts.items() if s == "Warning")
    print(f"\nEsito: {'CONFORME' if conforms else 'NON CONFORME'}  "
          f"Violation: {n_viol}  Warning: {n_warn}  Info: {sum(counts.values()) - n_viol - n_warn}\n")
    order = {"Violation": 0, "Warning": 1, "Info": 2}
    for (sev, path, rule), n in sorted(counts.items(), key=lambda kv: (order.get(kv[0][0], 3), -kv[1])):
        print(f"[{sev}] {n:6d}  {path}  ({rule})")
        for ex in examples[(sev, path, rule)]:
            print(f"           focus: {ex['focus'][:110]}")
            if ex["value"]:
                print(f"           value: {ex['value'][:110]}")
            print(f"           msg:   {ex['message'][:160]}")

    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump({"profile": f"DCAT-AP {a.dcatap} Level {a.level}", "conforms": conforms,
                       "datasets": n_ds, "distributions": n_dist,
                       "violations": n_viol, "warnings": n_warn,
                       "results": [{"severity": s, "path": p, "rule": r, "count": n,
                                    "examples": examples[(s, p, r)]}
                                   for (s, p, r), n in counts.items()]},
                      fh, ensure_ascii=False, indent=2)
        print(f"\nRiepilogo JSON: {a.json}")
    return 1 if n_viol else 0


if __name__ == "__main__":
    sys.exit(main())
