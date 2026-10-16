#!/usr/bin/env python3
"""
Validazione SHACL del catalog.ttl con lo stesso profilo usato da data.europa.eu,
e, a richiesta, con i profili italiani (DCAT-AP_IT, vocabolari controllati, HVD).

data.europa.eu (piveau) valida i metadati harvestati con il profilo
"DCAT-AP 3.0.0 Level 1" (dct:isVersionOf "dcatap300level1" nel DQV) = shapes.ttl + deprecateduris.ttl del progetto
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
  python3 validate_edp_shacl.py --file catalog.ttl --profile edp,it       # EDP + profili italiani

Opzioni:
  --name NOME       uno o piu' dataset (ripetibile), via catalog.ttl?fq=name:NOME
  --fq FILTRO       filtro Solr libero sul catalog.ttl (ripetibile)
  --pages N         pagine del catalog.ttl da validare (default 1, 100 dataset/pagina)
  --level 1|2       1 = profilo EDP (default), 2 = aggiunge le shape raccomandate
  --profile LISTA   profili separati da virgola (default: edp):
                      edp         shape piveau usate da data.europa.eu
                      dcatapit    Linee guida AgID per i cataloghi dati (DCAT-AP_IT)
                      vocabolari  valori dai vocabolari controllati EU
                      hvd         dati di elevato valore (Reg. UE 2023/138), solo sulle
                                  risorse che dichiarano l'ELI o una hvdCategory
                      it          = dcatapit,vocabolari,hvd    tutti = edp,it
  --dcatap 3.0.0    versione delle shape (default 3.0.0: il DQV di EDP riporta
                    "dcatap300level1", anche se la pagina violazioni dice 3.0.1)
  --examples N      esempi per ogni tipo di segnalazione (default 2)
  --json FILE       salva il riepilogo anche in JSON

Le shape italiane stanno in tools/shapes/ accanto allo script; se lo script e'
stato scaricato da solo vengono prese da SHAPES_IT_BASE.

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
# Shape italiane: cartella locale, altrimenti questo URL (va aggiornato in un fork).
SHAPES_IT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shapes")
SHAPES_IT_BASE = "https://raw.githubusercontent.com/piersoft/ckan-docker-ita/main/tools/shapes/"
PROFILES_IT = ("dcatapit", "vocabolari", "hvd")
HVD_ELI = "http://data.europa.eu/eli/reg_impl/2023/138/oj"
DCAT = "http://www.w3.org/ns/dcat#"
DCATAP = "http://data.europa.eu/r5r/"
HVD_NS = "urn:validatore-dcatapit:shapes:hvd#"
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


def load_it_shapes(name):
    path = os.path.join(SHAPES_IT_DIR, name + ".ttl")
    g = Graph()
    if os.path.exists(path):
        g.parse(path, format="turtle")
    else:
        g.parse(data=fetch(SHAPES_IT_BASE + name + ".ttl"), format="turtle")
    return g


def parse_profiles(value):
    out = []
    for p in value.split(","):
        p = p.strip().lower()
        if p == "tutti":
            out += ["edp", *PROFILES_IT]
        elif p == "it":
            out += list(PROFILES_IT)
        elif p in ("edp", *PROFILES_IT):
            out.append(p)
        elif p:
            raise ValueError(f"profilo sconosciuto: {p}")
    return list(dict.fromkeys(out))


def hvd_shapes(base, data):
    """Le shape HVD non hanno target: si applicano solo alle risorse HVD."""
    RDF_TYPE = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
    al, cat, eli = URIRef(DCATAP + "applicableLegislation"), URIRef(DCATAP + "hvdCategory"), URIRef(HVD_ELI)
    is_a = lambda s, c: (s, RDF_TYPE, URIRef(DCAT + c)) in data
    datasets = {s for s in data.subjects(al, eli) if is_a(s, "Dataset")}
    datasets |= {s for s in data.subjects(cat, None) if is_a(s, "Dataset")}
    dists = {o for d in datasets for o in data.objects(d, URIRef(DCAT + "distribution"))}
    services = set()
    for s in data.subjects(RDF_TYPE, URIRef(DCAT + "DataService")):
        serves = any(o in datasets for o in data.objects(s, URIRef(DCAT + "servesDataset")))
        if serves or (s, al, eli) in data or any(True for _ in data.objects(s, cat)):
            services.add(s)
    if not datasets and not services:
        return None, (0, 0, 0)
    g = Graph()
    for t in base:
        g.add(t)
    tn = URIRef(SH + "targetNode")
    for shape, nodes in (("Dataset", datasets), ("Distribution", dists), ("DataService", services)):
        for n in nodes:
            g.add((URIRef(HVD_NS + shape), tn, n))
    return g, (len(datasets), len(dists), len(services))


def guess_format(text, name=""):
    n = name.lower()
    if n.endswith((".rdf", ".xml")):
        return "xml"
    if n.endswith((".jsonld", ".json")):
        return "json-ld"
    if n.endswith(".nt"):
        return "nt"
    head = text[:2000].lstrip()
    if head.startswith("<?xml") or "<rdf:RDF" in head:
        return "xml"
    if head.startswith(("{", "[")):
        return "json-ld"
    return "turtle"


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
    ap.add_argument("--dcatap", default="3.0.0")
    ap.add_argument("--examples", type=int, default=2)
    ap.add_argument("--profile", default="edp")
    ap.add_argument("--json")
    a = ap.parse_args()
    if not a.base and not a.file:
        ap.error("serve l'URL base del CKAN oppure --file")
    try:
        profiles = parse_profiles(a.profile)
    except ValueError as e:
        ap.error(str(e))

    shapes_by_profile = {}
    try:
        if "edp" in profiles:
            shapes_by_profile["edp"], files = load_shapes(a.dcatap, a.level)
            print(f"Profilo: DCAT-AP {a.dcatap} Level {a.level} (piveau: {', '.join(files)})")
        for p in profiles:
            if p != "edp":
                shapes_by_profile[p] = load_it_shapes(p)
        it = [p for p in profiles if p != "edp"]
        if it:
            print(f"Profili italiani: {', '.join(it)}")
    except Exception as e:
        print(f"ERRORE nel caricamento delle shape: {e}", file=sys.stderr)
        return 2

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
    hvd_found = [0, 0, 0]
    for src, text in sources:
        data = Graph()
        data.parse(data=text, format=guess_format(text, src))
        n_ds += len(set(data.subjects(RDF_TYPE, URIRef("http://www.w3.org/ns/dcat#Dataset"))))
        n_dist += len(set(data.subjects(RDF_TYPE, URIRef("http://www.w3.org/ns/dcat#Distribution"))))
        n_triples += len(data)
        for prof in profiles:
            shapes = shapes_by_profile[prof]
            if prof == "hvd":
                shapes, found = hvd_shapes(shapes, data)
                hvd_found = [x + y for x, y in zip(hvd_found, found)]
                if shapes is None:
                    continue
            _, rg, _ = validate(data, shacl_graph=shapes, inference="none", allow_warnings=True)
            for r in rg.objects(None, URIRef(SH + "result")):
                sev = str(rg.value(r, URIRef(SH + "resultSeverity"))).split("#")[-1]
                path = short(rg.value(r, URIRef(SH + "resultPath")) or "-")
                msg = str(rg.value(r, URIRef(SH + "resultMessage")) or "")
                if prof == "edp":
                    shape = rg.value(r, URIRef(SH + "sourceShape"))
                    node = rg.value(shape, URIRef(SH + "node")) if shape is not None else None
                    rule = short(node) if node is not None else \
                        str(rg.value(r, URIRef(SH + "sourceConstraintComponent"))).split("#")[-1]
                else:
                    rule = msg
                key = (sev, prof, path, rule)
                counts[key] += 1
                if len(examples[key]) < a.examples:
                    examples[key].append({
                        "source": src,
                        "focus": str(rg.value(r, URIRef(SH + "focusNode"))),
                        "value": str(rg.value(r, URIRef(SH + "value")) or ""),
                        "message": msg,
                    })
    print(f"Dataset: {n_ds}  Distribuzioni: {n_dist}  Triple: {n_triples}")
    if "hvd" in profiles:
        print(f"Risorse HVD: {hvd_found[0]} dataset, {hvd_found[1]} distribuzioni, {hvd_found[2]} servizi")

    n_viol = sum(v for (s, *_), v in counts.items() if s == "Violation")
    n_warn = sum(v for (s, *_), v in counts.items() if s == "Warning")
    conforms = n_viol == 0
    print(f"\nEsito: {'CONFORME' if conforms else 'NON CONFORME'}  "
          f"Violation: {n_viol}  Warning: {n_warn}  Info: {sum(counts.values()) - n_viol - n_warn}\n")
    multi = len(profiles) > 1
    order = {"Violation": 0, "Warning": 1, "Info": 2}
    for key, n in sorted(counts.items(), key=lambda kv: (order.get(kv[0][0], 3), -kv[1])):
        sev, prof, path, rule = key
        tag = f"{prof:<10} " if multi else ""
        if prof == "edp":
            print(f"[{sev}] {n:6d}  {tag}{path}  ({rule})")
        else:
            print(f"[{sev}] {n:6d}  {tag}{path}  {rule}")
        for ex in examples[key]:
            print(f"           focus: {ex['focus'][:110]}")
            if ex["value"]:
                print(f"           value: {ex['value'][:110]}")
            if prof == "edp":
                print(f"           msg:   {ex['message'][:160]}")

    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump({"profile": f"DCAT-AP {a.dcatap} Level {a.level}", "profiles": profiles,
                       "conforms": conforms,
                       "datasets": n_ds, "distributions": n_dist,
                       "violations": n_viol, "warnings": n_warn,
                       "results": [{"severity": s, "profilo": pr, "path": p, "rule": r, "count": n,
                                    "examples": examples[(s, pr, p, r)]}
                                   for (s, pr, p, r), n in counts.items()]},
                      fh, ensure_ascii=False, indent=2)
        print(f"\nRiepilogo JSON: {a.json}")
    return 1 if n_viol else 0


if __name__ == "__main__":
    sys.exit(main())
