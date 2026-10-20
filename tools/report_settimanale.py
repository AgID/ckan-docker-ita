#!/usr/bin/env python3
"""
Report settimanale di validazione dei cataloghi delle PA presenti su dati.gov.it.

Per ogni organizzazione di dati.gov.it con almeno un dataset:
  - se ha una harvest source DCAT-RDF, valida il catalogo SORGENTE (pagina 1;
    per i cataloghi grandi un campione di pagine distribuite);
  - altrimenti (dataset inseriti dal FE, o sorgenti CKAN/JSON senza catalogo RDF)
    valida l'output di dati.gov.it filtrato per organizzazione.
Controlla anche che l'endpoint e alcune risorse rispondano 200.
Applica gli stessi profili del validatore web: EDP (DCAT-AP 3.0.0 L1), DCAT-AP_IT,
vocabolari, HVD e indicazioni AgID (con verifica dei codici IPA su IndicePA).

Uscita (la cartella viene riscritta a ogni esecuzione, senza storico):
  <out>/index.html        pagina generale
  <out>/riepilogo.csv     una riga per PA
  <out>/<slug>/index.html report della PA
  <out>/<slug>/<slug>.csv elenco puntuale delle segnalazioni della PA

Uso:
  python3 report_settimanale.py --out /path
  python3 report_settimanale.py --out out --org regione-toscana --org comune-di-bitonto
  python3 report_settimanale.py --out out --limit 10            # prime 10 PA (prova)
  python3 report_settimanale.py --out out --telegram ~/.config/report-validazione.json

Il file Telegram e' un JSON {"token": "...", "chat_id": "..."} (permessi 600).
Dipendenze: rdflib e pyshacl; il pacchetto report_settimanale.pyz le contiene gia'
(si lancia con: python3 report_settimanale.pyz ...).
"""
import argparse
import collections
import concurrent.futures as cf
import csv
import datetime
import html
import io
import json
import logging
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

import validate_edp_shacl as V
from rdflib import BNode, Graph, Literal, URIRef
from pyshacl import validate

# rdflib scrive nel log un traceback per ogni letterale non valido (es. una xsd:date
# "20/10/2026"): sono errori del catalogo, gia' segnalati dalla validazione, non dello script
logging.getLogger("rdflib").setLevel(logging.ERROR)

HERE = os.path.dirname(os.path.abspath(__file__))
DCAT, DCT, SH = V.DCAT, "http://purl.org/dc/terms/", V.SH
RDF_TYPE = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
HYDRA = "http://www.w3.org/ns/hydra/core#"
VALIDATORE_WEB = "https://www.dati.gov.it/sviluppatori/validatoreshacl"
PROFILI = ("edp", "dcatapit", "vocabolari", "hvd", "agid")
LABEL = {"edp": "EDP · DCAT-AP 3.0.0 L1", "dcatapit": "DCAT-AP_IT", "vocabolari": "Vocabolari",
         "hvd": "HVD", "agid": "Indicazioni AgID"}
SEV_IT = {"Violation": "Violazione", "Warning": "Avviso", "Info": "Indicazione"}
SEV_ORD = {"Violation": 0, "Warning": 1, "Info": 2}
# avviso noto e non sanabile (piveau chiede il vocabolario ADMS 1.0): solo conteggio, non nel CSV
RUMORE = "StatusRestrictionADMS"
GRANDE = 2000          # oltre questa soglia di dataset si valida un campione di pagine
PAGINE_CAMPIONE = 6
RISORSE_CAMPIONE = 3
TIMEOUT = 90
TIMEOUT_CATALOGO = 240   # alcuni cataloghi impiegano oltre un minuto e mezzo a generare la pagina


# ---------------------------------------------------------------- shape (anche dentro lo .pyz)
def read_text(rel):
    p = os.path.join(HERE, rel)
    if os.path.isfile(p):
        with open(p, encoding="utf-8") as fh:
            return fh.read()
    m = re.match(r"(.+?\.pyz)", HERE)
    if m:
        with zipfile.ZipFile(m.group(1)) as z:
            return z.read(rel.replace(os.sep, "/")).decode("utf-8")
    raise FileNotFoundError(rel)


def shapes(*files):
    g = Graph()
    for f in files:
        g.parse(data=read_text(os.path.join("shapes", f)), format="turtle")
    return g


def load_profiles():
    return {
        "edp": shapes("edp/shapes.ttl", "edp/deprecateduris.ttl"),
        "dcatapit": shapes("dcatapit.ttl"),
        "vocabolari": shapes("vocabolari.ttl", "vocabolari-elenchi.ttl"),
        "hvd": shapes("hvd.ttl"),
        "agid": shapes("agid.ttl"),
    }


# ---------------------------------------------------------------- rete
# al massimo due richieste alla volta per server: molte PA stanno sullo stesso fornitore
# (oltre 100 sorgenti su opendata.maggioli.cloud) e con piu' richieste in parallelo rispondono 503
PER_HOST = 2
_host_locks = collections.defaultdict(lambda: threading.BoundedSemaphore(PER_HOST))
_host_guard = threading.Lock()


def _host_lock(url):
    host = urllib.parse.urlsplit(url).netloc.lower()
    with _host_guard:
        return _host_locks[host]


def http(url, method="GET", timeout=TIMEOUT, headers=None, data=None):
    with _host_lock(url):
        return _http(url, method, timeout, headers, data)


def _http(url, method="GET", timeout=TIMEOUT, headers=None, data=None):
    """Restituisce (status, body|None, info) senza sollevare eccezioni."""
    h = {"User-Agent": V.UA, "Accept": "text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.8, */*;q=0.1"}
    h.update(headers or {})
    req = urllib.request.Request(url, method=method, headers=h, data=data)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read() if method != "HEAD" else None
            return r.status, body, {"ms": int((time.time() - t0) * 1000), "url": r.geturl()}
    except urllib.error.HTTPError as e:
        return e.code, None, {"ms": int((time.time() - t0) * 1000), "error": f"HTTP {e.code}"}
    except Exception as e:
        return 0, None, {"ms": int((time.time() - t0) * 1000), "error": type(e).__name__ + ": " + str(e)[:150]}


def get(url, tries=3):
    """GET con nuovi tentativi (dopo 30 e 90 s) sugli errori di rete, 429 e 5xx."""
    for i in range(tries):
        st, body, info = http(url, timeout=TIMEOUT_CATALOGO)
        if st == 200 or (st and st < 500 and st != 429) or i == tries - 1:
            return st, body, info
        time.sleep(30 if i == 0 else 90)


def api(base, action, **params):
    q = urllib.parse.urlencode(params)
    st, body, info = http(f"{base}/api/3/action/{action}?{q}", headers={"Accept": "application/json"}, timeout=180)
    if st != 200:
        raise RuntimeError(f"{action}: {info.get('error') or st}")
    return json.loads(body)["result"]


def with_page(url, page):
    p = urllib.parse.urlsplit(url)
    q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True) if k != "page"]
    q.append(("page", str(page)))
    return urllib.parse.urlunsplit(p._replace(query=urllib.parse.urlencode(q)))


def probe(url):
    """HEAD e, se non ammesso, GET con Range: codice, tempo, eventuale redirect."""
    st, _, info = http(url, "HEAD", timeout=30)
    if st in (0, 405, 501) or st >= 500:
        st2, _, info2 = http(url, "GET", timeout=30, headers={"Range": "bytes=0-0"})
        return {"head": st, "get": st2, "ms": info2.get("ms"), "error": info2.get("error") or info.get("error", "")}
    return {"head": st, "get": None, "ms": info.get("ms"), "error": info.get("error", ""),
            "redirect": info.get("url") if info.get("url") and info.get("url") != url else ""}


def ok_status(p):
    return (p.get("get") or p.get("head")) in (200, 206)


# ---------------------------------------------------------------- messaggi EDP in italiano (come il web)
KIND = {"BlankNodeOrIRI": "un URI (o un nodo strutturato)", "IRI": "un URI", "Literal": "un testo (letterale)",
        "BlankNode": "un nodo strutturato", "BlankNodeOrLiteral": "un nodo o un testo", "IRIOrLiteral": "un URI o un testo"}


def spiega(msg, comp, value):
    m = re.search(r"node kind <[^#>]*#(\w+)>|NodeKind[^#]*#(\w+)", msg)
    if comp == "NodeKind" and m:
        k = m.group(1) or m.group(2)
        return f"Il valore deve essere {KIND.get(k, k)}" + (", non un testo tra virgolette" if value.startswith('"') and "IRI" in k else "")
    if comp == "MinCount":
        return "Proprietà obbligatoria assente"
    if comp == "MaxCount":
        return "Troppi valori: la proprietà ne ammette uno solo"
    if "StatusRestrictionADMS" in msg:
        return "Stato non preso dal vocabolario ADMS (avviso noto della regola piveau)"
    if "DateOrDateTimeDataType" in msg:
        return "La data deve essere xsd:date, xsd:dateTime, xsd:gYear o xsd:gYearMonth"
    if comp == "Datatype":
        m = re.search(r"datatype (\S+)", msg)
        return "Tipo di dato errato" + (": atteso " + V.short(m.group(1)).replace("http://www.w3.org/2001/XMLSchema#", "xsd:").rstrip(".,") if m else "")
    if comp == "Class":
        return "Il valore non è dichiarato con la classe attesa"
    if comp == "Node":
        return "Il valore non rispetta una regola strutturata"
    if comp == "Or":
        return "Il valore non rispetta nessuna delle forme ammesse"
    if comp == "In":
        return "Valore non tra quelli ammessi"
    if comp == "Pattern":
        return "Valore in una forma non ammessa"
    return msg[:200]


# ---------------------------------------------------------------- validazione di un grafo
def term_text(t):
    if t is None:
        return ""
    if isinstance(t, Literal):
        s = str(t)
        return json.dumps(s[:117] + "..." if len(s) > 120 else s, ensure_ascii=False)
    if isinstance(t, BNode):
        return "_:" + str(t)
    return str(t)


def owner_of(data, node):
    if not isinstance(node, BNode):
        return ""
    steps, cur = [], node
    for _ in range(4):
        if not isinstance(cur, BNode):
            break
        q = next(data.subject_predicates(cur), None)
        if not q:
            break
        steps.append(V.short(q[1]).replace("dcat#", "dcat:"))
        cur = q[0]
    if not steps:
        return ""
    return " di ".join(steps) + (" di " + str(cur) if isinstance(cur, URIRef) else "")


def validate_graph(data, profiles):
    out = []
    counts = collections.Counter()
    hvd_found = (0, 0, 0)
    for prof in PROFILI:
        sg = profiles[prof]
        if prof == "hvd":
            sg, hvd_found = V.hvd_shapes(sg, data)
            if sg is None:
                continue
        _, rg, _ = validate(data, shacl_graph=sg, inference="none", allow_warnings=True)
        for r in rg.objects(None, URIRef(SH + "result")):
            sev = str(rg.value(r, URIRef(SH + "resultSeverity"))).split("#")[-1]
            comp = str(rg.value(r, URIRef(SH + "sourceConstraintComponent")) or "").split("#")[-1].replace("ConstraintComponent", "")
            msg = str(rg.value(r, URIRef(SH + "resultMessage")) or comp)
            focus = rg.value(r, URIRef(SH + "focusNode"))
            value = term_text(rg.value(r, URIRef(SH + "value")))
            if prof == "edp":
                msg_it = spiega(msg, comp, value)
            else:
                msg_it = msg
            counts[(prof, sev)] += 1
            if RUMORE in msg:
                counts["rumore"] += 1
                continue
            out.append({"profilo": prof, "gravita": sev, "proprieta": V.path_text(rg, rg.value(r, URIRef(SH + "resultPath"))).replace("dcat#", "dcat:"),
                        "messaggio": msg_it, "vincolo": comp, "risorsa": term_text(focus), "contenuta_in": owner_of(data, focus), "valore": value})
        if prof == "agid":
            for x in V.agid_checks(data):
                counts[("agid", "Info")] += 1
                out.append({"profilo": "agid", "gravita": "Info", "proprieta": "dct:identifier", "messaggio": V.AGID_PREFIX_MSG,
                            "vincolo": "CodiceIPA", "risorsa": x["focus"], "contenuta_in": "", "valore": x["value"]})
    return out, counts, hvd_found


def holder_codes(data):
    """codice minuscolo -> [(dataset, codice come scritto)]"""
    by = collections.defaultdict(list)
    for d, h in data.subject_objects(URIRef(DCT + "rightsHolder")):
        for i in data.objects(h, URIRef(DCT + "identifier")):
            c = str(i).strip()
            if re.fullmatch(r"[A-Za-z0-9_]{2,40}", c):
                by[c.lower()].append((str(d), c))
    return by


def ipa_lookup(codes):
    """Una sola serie di query per tutti i codici della settimana: (official, hint) oppure errore."""
    codes = sorted(codes)
    official, hint = {}, {}
    for r in V.ipa_query(codes, lambda l: f'SELECT "Codice_IPA" AS c FROM "{V.IPA_ENTI}" WHERE lower("Codice_IPA") IN ({l})'):
        official[str(r["c"]).lower()] = str(r["c"])
    missing = [k for k in codes if k not in official]
    if missing:
        for r in V.ipa_query([k.upper() for k in missing], lambda l: (
                f'SELECT upper("Codice_uni_uo") AS c, "Codice_IPA" AS ipa, "Descrizione_uo" AS d '
                f'FROM "{V.IPA_UO}" WHERE upper("Codice_uni_uo") IN ({l})')):
            hint[str(r["c"]).lower()] = f"è il codice dell'unità organizzativa «{r['d']}» dell'ente {r['ipa']}: usare {r['ipa']}"
        cf_ = [k for k in missing if re.fullmatch(r"\d{11}", k)]
        if cf_:
            for r in V.ipa_query(cf_, lambda l: (
                    f'SELECT "Codice_fiscale_ente" AS c, "Codice_IPA" AS ipa, "Denominazione_ente" AS d '
                    f'FROM "{V.IPA_ENTI}" WHERE "Codice_fiscale_ente" IN ({l})')):
                hint[str(r["c"])] = f"è il codice fiscale di «{r['d']}»: usare il codice IPA {r['ipa']}"
    return official, hint


def ipa_rows(by, official, hint):
    rows = []
    for k, items in by.items():
        ok = official.get(k)
        if ok and not hint.get(k) and all(c == ok for _, c in items):
            continue
        h = hint.get(k) or (f"maiuscole/minuscole diverse da IndicePA: il codice è {ok}" if ok else "nessun ente con questo codice")
        for d, c in items:
            if c == ok:
                continue
            rows.append({"profilo": "agid", "gravita": "Info", "proprieta": "dct:rightsHolder/dct:identifier", "messaggio": V.IPA_MSG,
                         "vincolo": "IndicePA", "risorsa": d, "contenuta_in": "", "valore": f'"{c}" — {h}'})
    return rows


# ---------------------------------------------------------------- piano di lavoro per PA
def plan(org, sources, base):
    """Elenco delle pagine da scaricare per l'organizzazione."""
    rdf = [s for s in sources if s.get("source_type") == "dcat_rdf" and s.get("url")]
    if rdf:
        return "sorgente", [s["url"].strip() for s in rdf[:3]]
    fq = "organization:" + org["name"]
    return "dati.gov.it", [f"{base}/catalog.ttl?" + urllib.parse.urlencode({"fq": fq})]


def last_page(data):
    for p in ("lastPage", "last"):
        v = next(data.objects(None, URIRef(HYDRA + p)), None)
        if v is not None:
            m = re.search(r"[?&]page=(\d+)", str(v))
            if m:
                return int(m.group(1))
    return 1


def total_items(data):
    v = next(data.objects(None, URIRef(HYDRA + "totalItems")), None)
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def parse(body, url):
    text = body.decode("utf-8", errors="replace")
    g = Graph()
    g.parse(data=text, format=V.guess_format(text, urllib.parse.urlsplit(url).path))
    return g


def process_org(org, sources, base, profiles, rnd):
    origine, endpoints = plan(org, sources, base)
    rep = {"org": org, "origine": origine, "endpoints": [], "pagine": [], "righe": [], "conteggi": collections.Counter(),
           "dataset": 0, "distribuzioni": 0, "totale": None, "hvd": [0, 0, 0], "risorse": [], "codici": collections.defaultdict(list),
           "errore": ""}
    for ep in endpoints:
        pr = probe(ep)
        rep["endpoints"].append({"url": ep, **pr})
        first = with_page(ep, 1) if "catalog." in urllib.parse.urlsplit(ep).path else ep
        st, body, info = get(first)
        # l'errore resta sul singolo endpoint: se la PA ha piu' sorgenti, le altre si validano comunque
        if st != 200 or not body:
            rep["endpoints"][-1]["errore_catalogo"] = f"catalogo non scaricabile ({info.get('error') or st})"
            continue
        if len(body) > 100 * 1024 * 1024:
            rep["endpoints"][-1]["errore_catalogo"] = "catalogo oltre 100 MB"
            continue
        try:
            g = parse(body, first)
        except Exception as e:
            rep["endpoints"][-1]["errore_catalogo"] = f"catalogo non RDF valido: {str(e)[:150]}"
            continue
        pages = [(first, g)]
        lp = last_page(g)
        tot = total_items(g)
        rep["totale"] = (rep["totale"] or 0) + (tot or 0) if tot is not None else rep["totale"]
        if lp > 1 and (tot or 0) > GRANDE:
            cand = sorted({2, lp // 2, lp} | set(rnd.sample(range(2, lp + 1), min(3, lp - 1))))
            for n in [c for c in cand if 1 < c <= lp][:PAGINE_CAMPIONE - 1]:
                u = with_page(ep, n)
                st, body, info = get(u)
                if st == 200 and body:
                    try:
                        pages.append((u, parse(body, u)))
                    except Exception:
                        pass
        for u, g in pages:
            righe, cnt, hvd = validate_graph(g, profiles)
            rep["righe"] += righe
            rep["conteggi"] += cnt
            rep["hvd"] = [a + b for a, b in zip(rep["hvd"], hvd)]
            nds = len(set(g.subjects(RDF_TYPE, URIRef(DCAT + "Dataset"))))
            rep["dataset"] += nds
            rep["distribuzioni"] += len(set(g.subjects(RDF_TYPE, URIRef(DCAT + "Distribution"))))
            rep["pagine"].append({"url": u, "dataset": nds})
            for k, v in holder_codes(g).items():
                rep["codici"][k] += v
            # risorse a campione
            urls = [str(o) for o in g.objects(None, URIRef(DCAT + "downloadURL"))] + [str(o) for o in g.objects(None, URIRef(DCAT + "accessURL"))]
            urls = [x for x in dict.fromkeys(urls) if x.startswith("http")]
            for x in rnd.sample(urls, min(RISORSE_CAMPIONE, len(urls))) if len(rep["risorse"]) < RISORSE_CAMPIONE else []:
                rep["risorse"].append({"url": x, **probe(x)})
    falliti = [e["errore_catalogo"] for e in rep["endpoints"] if e.get("errore_catalogo")]
    if falliti and not rep["pagine"]:
        rep["errore"] = falliti[0]
    elif falliti:
        rep["avviso"] = f"{len(falliti)} sorgente/i su {len(rep['endpoints'])} non validabile/i: {falliti[0]}"
    if rep["totale"] is None:
        rep["totale"] = org.get("package_count")
    return rep


# ---------------------------------------------------------------- output
CSS = """
:root{--bg:#f4f6f9;--s:#fff;--ink:#17212f;--mu:#5a6779;--li:#d9dfe8;--ac:#0b5cad;--bad:#b3261e;--bads:#fbe9e7;--warn:#8a5a00;--warns:#fdf1d6;--good:#1e6b3a;--goods:#e3f3e8;--hint:#5b3fa0;--hints:#efe9fa}
@media (prefers-color-scheme:dark){:root{--bg:#0f151e;--s:#17202c;--ink:#e6ebf2;--mu:#9aa7b8;--li:#2a3646;--ac:#6fa8e8;--bad:#f28b82;--bads:#3a1d1b;--warn:#f1c065;--warns:#362a12;--good:#7fd19b;--goods:#15301f;--hint:#b9a3f0;--hints:#2a2140}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Titillium Web","Segoe UI",system-ui,sans-serif}
.w{max-width:1180px;margin:0 auto;padding:20px 16px 40px}h1{font-size:1.6rem;margin:.2em 0}h2{font-size:1.1rem;margin:1.4em 0 .5em}
.mu{color:var(--mu)}.card{background:var(--s);border:1px solid var(--li);border-radius:6px;padding:14px 16px;margin:12px 0}
table{border-collapse:collapse;width:100%;background:var(--s)}th,td{border-bottom:1px solid var(--li);padding:6px 8px;text-align:left;vertical-align:top;font-size:.9rem}
th{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--mu);position:sticky;top:0;background:var(--s)}
td.n{text-align:right;font-variant-numeric:tabular-nums}code,.mono{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:.82rem;overflow-wrap:anywhere}
.tag{display:inline-block;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border-radius:3px}
.Violation{background:var(--bads);color:var(--bad)}.Warning{background:var(--warns);color:var(--warn)}.Info{background:var(--hints);color:var(--hint)}
.ok{background:var(--goods);color:var(--good)}.ko{background:var(--bads);color:var(--bad)}
.stamp{display:inline-block;border:2px solid;border-radius:4px;padding:2px 10px;font-weight:700;letter-spacing:.05em}
details{background:var(--s);border:1px solid var(--li);border-radius:6px;margin:8px 0}summary{cursor:pointer;padding:8px 12px;display:flex;gap:10px;align-items:baseline}
summary .m{flex:1}details>div{padding:0 12px 10px;overflow-x:auto}a{color:var(--ac)}input[type=search]{width:100%;max-width:420px;padding:6px 8px;border:1px solid var(--li);border-radius:4px;background:var(--s);color:var(--ink)}
.kv{display:flex;flex-wrap:wrap;gap:18px}.kv div b{display:block;font-size:1.3rem}
"""


def esc(s):
    return html.escape(str(s if s is not None else ""), quote=True)


def link(u):
    u = str(u)
    if re.match(r"^https?://", u):
        return f'<a class="mono" href="{esc(u)}" target="_blank" rel="noopener noreferrer">{esc(u)}</a>'
    return f'<span class="mono">{esc(u)}</span>'


def tot(rep):
    c = collections.Counter()
    for r in rep["righe"]:
        c[r["gravita"]] += 1
    return c


def status_cell(p):
    if not p:
        return '<span class="mu">—</span>'
    s = p.get("get") or p.get("head")
    cls = "ok" if s in (200, 206) else "ko"
    det = f"HEAD {p.get('head')}" + (f", GET {p.get('get')}" if p.get("get") is not None else "")
    return f'<span class="tag {cls}">{esc(s or "errore")}</span> <span class="mu">{esc(det)} · {esc(p.get("ms"))} ms {esc(p.get("error") or "")}</span>'


def page(title, body):
    return (f'<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<meta name="referrer" content="no-referrer"><title>{esc(title)}</title><style>{CSS}</style></head><body><div class="w">{body}</div></body></html>')


def org_html(rep, generato):
    o = rep["org"]
    c = tot(rep)
    conforme = c["Violation"] == 0 and not rep["errore"]
    groups = collections.OrderedDict()
    for r in sorted(rep["righe"], key=lambda r: (SEV_ORD.get(r["gravita"], 3), r["profilo"], r["messaggio"])):
        groups.setdefault((r["gravita"], r["profilo"], r["proprieta"], r["messaggio"]), []).append(r)
    rows = []
    for (sev, prof, path, msg), items in sorted(groups.items(), key=lambda kv: (SEV_ORD.get(kv[0][0], 3), -len(kv[1]))):
        ex = "".join(f"<tr><td>{link(i['risorsa'])}{('<br><span class=mu>' + esc(i['contenuta_in']) + '</span>') if i['contenuta_in'] else ''}</td><td>{link(i['valore']) if i['valore'] else '<span class=mu>assente</span>'}</td></tr>"
                     for i in items[:50])
        more = f'<p class="mu">Mostrate 50 di {len(items)}: l\'elenco completo è nel CSV.</p>' if len(items) > 50 else ""
        rows.append(f'<details><summary><span class="tag {sev}">{SEV_IT.get(sev, sev)}</span><span class="m">{esc(msg)}<br><span class="mu">{esc(LABEL[prof])} · <code>{esc(path)}</code></span></span><b>{len(items)}</b></summary>'
                    f'<div><table><tr><th>Risorsa</th><th>Valore</th></tr>{ex}</table>{more}</div></details>')
    def ep_err(e):
        return ('<br><span class="tag ko">errore</span> ' + esc(e["errore_catalogo"])) if e.get("errore_catalogo") else ""
    eps = "".join(f"<tr><td>{link(e['url'])}</td><td>{status_cell(e)}{ep_err(e)}</td></tr>" for e in rep["endpoints"])
    ris = "".join(f"<tr><td>{link(e['url'])}</td><td>{status_cell(e)}</td></tr>" for e in rep["risorse"]) or '<tr><td colspan=2 class="mu">nessuna risorsa controllata</td></tr>'
    np_ = len(rep["pagine"])
    camp = f"{rep['dataset']} dataset validati su {rep['totale'] if rep['totale'] is not None else '?'} ({np_} {'pagina' if np_ == 1 else 'pagine'})"
    rumore = f" Avviso noto su adms:status escluso dall'elenco: {rep['conteggi']['rumore']} occorrenze." if rep["conteggi"]["rumore"] else ""
    origine = "catalogo sorgente (harvest source)" if rep["origine"] == "sorgente" else "catalogo esposto da dati.gov.it per l'organizzazione"
    body = f"""
<p class="mu"><a href="../index.html">← Tutte le PA</a> · report del {esc(generato)}</p>
<h1>{esc(o.get('title') or o['name'])}</h1>
<p class="mu">Organizzazione <code>{esc(o['name'])}</code> su dati.gov.it · validato il {esc(origine)}</p>
<div class="card"><span class="stamp" style="color:var({'--good' if conforme else '--bad'})">{'CONFORME' if conforme else 'NON CONFORME'}</span>
<div class="kv" style="margin-top:10px"><div><b>{c['Violation']}</b>violazioni</div><div><b>{c['Warning']}</b>avvisi</div><div><b>{c['Info']}</b>indicazioni AgID</div><div><b>{rep['dataset']}</b>dataset validati</div><div><b>{rep['distribuzioni']}</b>distribuzioni</div></div>
<p class="mu">{esc(camp)}. È un campione: l'intero catalogo si controlla con il <a href="{VALIDATORE_WEB}" target="_blank" rel="noopener">validatore di dati.gov.it</a>.
{rumore}</p>
{('<p><span class="tag ko">errore</span> ' + esc(rep['errore']) + '</p>') if rep['errore'] else ''}{('<p><span class="tag Warning">attenzione</span> ' + esc(rep.get('avviso', '')) + '</p>') if rep.get('avviso') else ''}
<p><a href="{esc(o['name'])}.csv" download>Scarica il CSV con l'elenco puntuale</a></p></div>
<h2>Raggiungibilità</h2>
<p class="mu">L'endpoint del catalogo e le risorse devono rispondere 200 alla richiesta HEAD (curl -I), senza WAF o altri blocchi.</p>
<table><tr><th>Endpoint del catalogo</th><th>Risposta</th></tr>{eps}</table>
<table style="margin-top:8px"><tr><th>Risorse a campione</th><th>Risposta</th></tr>{ris}</table>
<h2>Segnalazioni</h2>
{''.join(rows) or '<p class="mu">Nessuna segnalazione.</p>'}
<h2>Pagine validate</h2>
<table><tr><th>Pagina</th><th>Dataset</th></tr>{''.join(f"<tr><td>{link(p['url'])}</td><td class=n>{p['dataset']}</td></tr>" for p in rep['pagine'])}</table>
"""
    return page(f"Validazione – {o.get('title') or o['name']}", body)


CSV_COLS = ["profilo", "gravita", "proprieta", "messaggio", "vincolo", "risorsa", "contenuta_in", "valore"]


def safe_cell(v):
    t = str(v if v is not None else "")
    return "'" + t if re.match(r"^[=+\-@\t\r]", t) else t


def write_csv(path, rows, cols):
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for r in rows:
            w.writerow([safe_cell(r.get(c, "")) for c in cols])


def summary_row(rep):
    c = tot(rep)
    ep = rep["endpoints"][0] if rep["endpoints"] else {}
    ris_ko = sum(1 for r in rep["risorse"] if not ok_status(r))
    return {"slug": rep["org"]["name"], "organizzazione": rep["org"].get("title") or rep["org"]["name"],
            "origine": rep["origine"], "endpoint": ep.get("url", ""), "endpoint_http": (ep.get("get") or ep.get("head") or "") if ep else "",
            "dataset_totali": rep["totale"] if rep["totale"] is not None else "", "dataset_validati": rep["dataset"],
            "violazioni": c["Violation"], "avvisi": c["Warning"], "indicazioni": c["Info"],
            "risorse_non_raggiungibili": f"{ris_ko}/{len(rep['risorse'])}", "errore": rep["errore"] or rep.get("avviso", ""),
            "conforme": "sì" if c["Violation"] == 0 and not rep["errore"] else "no", "_bloccante": bool(rep["errore"])}


SUM_COLS = ["slug", "organizzazione", "origine", "endpoint", "endpoint_http", "dataset_totali", "dataset_validati",
            "violazioni", "avvisi", "indicazioni", "risorse_non_raggiungibili", "errore", "conforme"]


def index_html(rows, generato, durata, ipa_note):
    rows = sorted(rows, key=lambda r: (not r["_bloccante"], -r["violazioni"], -r["indicazioni"]))
    n_err = sum(1 for r in rows if r["_bloccante"])
    n_conf = sum(1 for r in rows if r["conforme"] == "sì")
    tr = "".join(
        f'<tr data-q="{esc((r["slug"] + " " + r["organizzazione"]).lower())}"><td><a href="{esc(r["slug"])}/index.html">{esc(r["organizzazione"])}</a><br><span class="mu mono">{esc(r["slug"])}</span></td>'
        f'<td>{"sorgente" if r["origine"] == "sorgente" else "dati.gov.it"}</td>'
        f'<td><span class="tag {"ok" if str(r["endpoint_http"]) in ("200", "206") else "ko"}">{esc(r["endpoint_http"] or "—")}</span></td>'
        f'<td class=n>{r["dataset_validati"]}/{r["dataset_totali"]}</td><td class=n>{r["violazioni"]}</td><td class=n>{r["avvisi"]}</td><td class=n>{r["indicazioni"]}</td>'
        f'<td class=n>{esc(r["risorse_non_raggiungibili"])}</td><td>{esc(r["errore"])}</td></tr>' for r in rows)
    body = f"""
<h1>Validazione settimanale dei cataloghi</h1>
<p class="mu">Report del {esc(generato)} · durata {esc(durata)} · profili EDP, DCAT-AP_IT, Vocabolari, HVD, Indicazioni AgID · {esc(ipa_note)}</p>
<div class="card kv"><div><b>{len(rows)}</b>PA</div><div><b>{n_conf}</b>senza violazioni</div><div><b>{n_err}</b>catalogo non validabile</div>
<div><b>{sum(r['violazioni'] for r in rows)}</b>violazioni</div><div><b>{sum(r['avvisi'] for r in rows)}</b>avvisi</div><div><b>{sum(r['indicazioni'] for r in rows)}</b>indicazioni</div></div>
<p class="mu">Per ogni PA si valida un campione: la pagina 1 del catalogo sorgente, o più pagine distribuite per i cataloghi con oltre {GRANDE} dataset. <a href="riepilogo.csv" download>Scarica il riepilogo CSV</a>.</p>
<p><input type="search" id="q" placeholder="Cerca una PA" oninput="for(const t of document.querySelectorAll('tbody tr'))t.hidden=!t.dataset.q.includes(this.value.toLowerCase())"></p>
<div style="overflow-x:auto"><table><thead><tr><th>PA</th><th>Origine</th><th>Endpoint</th><th>Dataset validati / totali</th><th>Violazioni</th><th>Avvisi</th><th>Indicazioni</th><th>Risorse KO</th><th>Errore / note</th></tr></thead><tbody>{tr}</tbody></table></div>
"""
    return page("Validazione settimanale dei cataloghi", body)


# ---------------------------------------------------------------- Telegram (solo libreria standard)
def telegram(cfg_path, text, files=()):
    with open(os.path.expanduser(cfg_path), encoding="utf-8") as fh:
        cfg = json.load(fh)
    base = f"https://api.telegram.org/bot{cfg['token']}"
    data = urllib.parse.urlencode({"chat_id": cfg["chat_id"], "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true"}).encode()
    st, _, info = http(base + "/sendMessage", "POST", data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    ok = st == 200
    for f in files:
        b = "----" + uuid.uuid4().hex
        with open(f, "rb") as fh:
            content = fh.read()
        parts = [f'--{b}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n{cfg["chat_id"]}\r\n'.encode(),
                 f'--{b}\r\nContent-Disposition: form-data; name="document"; filename="{os.path.basename(f)}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode(),
                 content, f"\r\n--{b}--\r\n".encode()]
        st, _, _ = http(base + "/sendDocument", "POST", data=b"".join(parts), headers={"Content-Type": f"multipart/form-data; boundary={b}"})
        ok = ok and st == 200
    return ok


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="cartella di uscita (viene riscritta)")
    ap.add_argument("--base", default="https://dati.gov.it/opendata", help="CKAN di dati.gov.it (senza www: la WAF blocca i client non browser)")
    ap.add_argument("--org", action="append", default=[], help="solo queste organizzazioni (ripetibile)")
    ap.add_argument("--limit", type=int, default=0, help="solo le prime N organizzazioni (prova)")
    ap.add_argument("--workers", type=int, default=6, help="PA elaborate in parallelo (default 6; sullo stesso server al massimo 2 richieste alla volta)")
    ap.add_argument("--no-ipa", action="store_true", help="non interrogare IndicePA")
    ap.add_argument("--telegram", help="file JSON con token e chat_id del bot")
    ap.add_argument("--url-report", default="", help="indirizzo pubblico della pagina generale, da citare nel messaggio Telegram")
    ap.add_argument("--seed", type=int, default=None, help="seme per il campione casuale (default: numero della settimana)")
    a = ap.parse_args()
    t0 = time.time()
    oggi = datetime.datetime.now()
    generato = oggi.strftime("%d/%m/%Y %H:%M")
    rnd = random.Random(a.seed if a.seed is not None else int(oggi.strftime("%G%V")))

    print("Organizzazioni e harvest source da", a.base, flush=True)
    # organization_list con all_fields restituisce al massimo 25 voci per chiamata: si pagina
    orgs, off = [], 0
    while True:
        chunk = api(a.base, "organization_list", all_fields="true", limit=25, offset=off)
        if not chunk:
            break
        orgs += chunk
        off += len(chunk)
    orgs = [o for o in orgs if (o.get("package_count") or 0) > 0]
    if a.org:
        orgs = [o for o in orgs if o["name"] in a.org]
    orgs.sort(key=lambda o: o["name"])
    if a.limit:
        orgs = orgs[:a.limit]
    hs = api(a.base, "package_search", fq="dataset_type:harvest", rows=1000, include_private="true")["results"]
    by_org = collections.defaultdict(list)
    for s in hs:
        by_org[(s.get("organization") or {}).get("name")].append(s)
    print(f"  {len(orgs)} PA, {len(hs)} harvest source", flush=True)

    profiles = load_profiles()
    reps = []

    def job(o):
        try:
            return process_org(o, by_org.get(o["name"], []), a.base, profiles, random.Random(rnd.random()))
        except Exception as e:
            return {"org": o, "origine": "?", "endpoints": [], "pagine": [], "righe": [], "conteggi": collections.Counter(),
                    "dataset": 0, "distribuzioni": 0, "totale": o.get("package_count"), "hvd": [0, 0, 0], "risorse": [],
                    "codici": {}, "errore": f"errore interno: {type(e).__name__}: {str(e)[:150]}"}

    with cf.ThreadPoolExecutor(max_workers=max(1, a.workers)) as ex:
        for i, rep in enumerate(ex.map(job, orgs), 1):
            reps.append(rep)
            c = tot(rep)
            print(f"  [{i}/{len(orgs)}] {rep['org']['name']}: {rep['dataset']} dataset, V{c['Violation']} A{c['Warning']} I{c['Info']} {rep['errore']}", flush=True)

    # IndicePA: una sola serie di query per tutti i codici
    ipa_note = "IndicePA non interrogato"
    if not a.no_ipa:
        allcodes = set()
        for r in reps:
            allcodes |= set(r["codici"])
        try:
            official, hint = ipa_lookup(allcodes)
            for r in reps:
                r["righe"] += ipa_rows(r["codici"], official, hint)
            ipa_note = f"IndicePA: {len(allcodes)} codici IPA verificati"
        except Exception as e:
            ipa_note = f"IndicePA non raggiungibile ({str(e)[:80]}): codici IPA non verificati"

    # scrittura
    os.makedirs(a.out, exist_ok=True)
    rows = []
    for r in reps:
        d = os.path.join(a.out, r["org"]["name"])
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "index.html"), "w", encoding="utf-8") as fh:
            fh.write(org_html(r, generato))
        write_csv(os.path.join(d, r["org"]["name"] + ".csv"), r["righe"], CSV_COLS)
        rows.append(summary_row(r))
    durata = f"{int((time.time() - t0) // 60)} min {int((time.time() - t0) % 60)} s"
    with open(os.path.join(a.out, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(index_html(rows, generato, durata, ipa_note))
    write_csv(os.path.join(a.out, "riepilogo.csv"), rows, SUM_COLS)
    # cartelle di PA non piu' presenti: si eliminano, cosi' la cartella rispecchia la settimana
    if not a.org and not a.limit:
        keep = {r["org"]["name"] for r in reps}
        for n in os.listdir(a.out):
            p = os.path.join(a.out, n)
            if os.path.isdir(p) and n not in keep and os.path.isfile(os.path.join(p, "index.html")):
                for f in os.listdir(p):
                    os.remove(os.path.join(p, f))
                os.rmdir(p)

    tv = sum(r["violazioni"] for r in rows)
    ta = sum(r["avvisi"] for r in rows)
    ti = sum(r["indicazioni"] for r in rows)
    nerr = [r for r in rows if r["_bloccante"]]
    peggiori = sorted([r for r in rows if not r["_bloccante"]], key=lambda r: -r["violazioni"])[:10]
    print(f"\nFatto in {durata}: {len(rows)} PA, {tv} violazioni, {ta} avvisi, {ti} indicazioni, {len(nerr)} cataloghi non validabili. {ipa_note}")
    if a.telegram:
        msg = (f"<b>Validazione settimanale cataloghi</b> – {esc(generato)}\n"
               f"{len(rows)} PA · {sum(1 for r in rows if r['conforme'] == 'sì')} senza violazioni · {len(nerr)} catalogo non validabile\n"
               f"Violazioni {tv} · avvisi {ta} · indicazioni AgID {ti}\n{esc(ipa_note)}\n\n<b>Più violazioni</b>\n"
               + "\n".join(f"{r['violazioni']:>5}  {esc(r['organizzazione'])}" for r in peggiori)
               + ("\n\n<b>Non validabili</b>\n" + "\n".join(f"{esc(r['organizzazione'])}: {esc(r['errore'])}" for r in nerr[:15]) + (f"\n… e altre {len(nerr) - 15}" if len(nerr) > 15 else "") if nerr else "")
               + (f"\n\n{esc(a.url_report)}" if a.url_report else ""))
        ok = telegram(a.telegram, msg[:4000], [os.path.join(a.out, "riepilogo.csv")])
        print("Telegram:", "inviato" if ok else "ERRORE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
