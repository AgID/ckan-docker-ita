# -*- coding: utf-8 -*-
"""
Punteggio MQA (Metadata Quality Assessment) di data.europa.eu per un dataset CKAN.

Metodologia MQA v2 (set. 2026): scala 0-7,5
  Sufficiente < 2,5 | Buono 2,5-5 | Eccellente >= 5

Il valore mostrato e' "datasetFinal" (l'"Agregated rating" della pagina qualita'
di data.europa.eu), letto da /api/mqa/cache/datasets/{id}. Quell'API rifiuta le
chiamate dal browser (HTTP 500 con header Origin diverso da data.europa.eu),
quindi il calcolo avviene qui, lato server, durante il rendering della pagina.

Flusso:
  1. risolve l'ID EDP della copia che sta nel catalogo dati-gov-it (vedi sotto)
  2. API MQA v2 per leggere datasetFinal (o "No v2 metrics found" = non rivalutato)
  3. risultato in cache Redis (successo 6 ore, esito negativo 30 minuti)
  4. se data.europa.eu non risponde, si sospendono le chiamate per 5 minuti
     (circuit breaker) per non rallentare le pagine

Uso nei template:  {% set mqa = h.dcatapit_edp_mqa(pkg) %}
"""

import json
import logging
import re
import unicodedata

import requests

log = logging.getLogger(__name__)

SEARCH_URL = 'https://data.europa.eu/api/hub/search/search'
DATASET_URL = 'https://data.europa.eu/api/hub/search/datasets/'
MQA_URL = 'https://data.europa.eu/api/mqa/cache/datasets/'

# Catalogo di data.europa.eu che corrisponde a questo portale.
#
# Lo stesso dct:identifier puo' arrivare a EDP da due cataloghi: per esempio la
# cartografia della Provincia di Bolzano arriva sia da dati.gov.it sia
# dall'RNDT. EDP assegna l'URI canonico a chi arriva prima e il suffisso ~~N
# agli altri. Bisogna mostrare il punteggio del record di dati.gov.it, non
# quello di un altro catalogo: i metadati sono diversi e il voto anche.
CATALOGO = 'dati-gov-it'
SUFFISSI = ('', '~~1', '~~2', '~~3')
EDP_PAGE = 'https://data.europa.eu/data/datasets/'
EDP_HOME = 'https://data.europa.eu/data/datasets?locale=it'

TIMEOUT = (3, 8)            # (connessione, lettura) in secondi; la lettura e'
                            # piu' lenta su /datasets/<id> che sulla search
CACHE_TTL_OK = 6 * 3600     # esito con punteggio o "in attesa di rivalutazione"
CACHE_TTL_KO = 30 * 60      # dataset non trovato / errore
BREAKER_TTL = 5 * 60        # pausa dopo un errore di rete verso data.europa.eu
# v3: dalla scelta della copia per catalogo; v2 aveva in cache le copie RNDT
KEY_PREFIX = 'dcatapit:edp_mqa:v3:'
BREAKER_KEY = 'dcatapit:edp_mqa:breaker'

HEADERS = {'Accept': 'application/json', 'User-Agent': 'CKAN dcatapit edp_mqa'}


# ------------------------------------------------------------------ redis

def _redis():
    try:
        from ckan.lib.redis import connect_to_redis
        return connect_to_redis()
    except Exception:
        return None


def _cache_get(key):
    r = _redis()
    if r is None:
        return None
    try:
        raw = r.get(key)
        return json.loads(raw) if raw else None
    except Exception:
        return None


def _cache_set(key, value, ttl):
    r = _redis()
    if r is None:
        return
    try:
        r.setex(key, ttl, json.dumps(value))
    except Exception:
        pass


# ------------------------------------------------------------------ id EDP

def _normalize(s):
    """Stessa normalizzazione del JS CKAN e del blocco Drupal:
    lower, niente diacritici, solo ':' e '.' -> '-', underscore intatti."""
    s = (s or '').strip().lower()
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = s.replace(':', '-').replace('.', '-')
    for q in (u'\u2019', u'\u2018', u'\u00b4', '`'):
        s = s.replace(q, "'")
    s = re.sub(r'\s+', '-', s)
    s = re.sub(r'-+', '-', s)
    return s.strip('-')


def _edp_id_from_resource(resource):
    rid = re.sub(r'[?#].*$', '', resource or '')
    return re.sub(r'^.*/dataset/', '', rid)


def _candidates(pkg):
    raw = (pkg.get('identifier') or '').strip()
    if not raw:
        for e in pkg.get('extras') or []:
            if e.get('key') == 'identifier':
                raw = (e.get('value') or '').strip()
                break
    cands = []
    for c in (_normalize(raw), raw, raw.lower()):
        if c and c != 'none' and c not in cands:
            cands.append(c)
    return cands


def _catalogo_di(edp_id):
    """Catalogo EDP che contiene il dataset, None se il dataset non esiste."""
    resp = requests.get(DATASET_URL + requests.utils.quote(edp_id, safe=''),
                        headers=HEADERS, timeout=TIMEOUT)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    data = resp.json()
    record = data.get('result') or data
    return (record.get('catalog') or {}).get('id')


def _copia_del_catalogo(base):
    """Fra la copia canonica e le varianti ~~N, quella del catalogo dati-gov-it.

    La ricerca testuale non restituisce le varianti ~~N, quindi le si interroga
    direttamente per indirizzo.
    """
    verificata = False
    errore = None
    for suffisso in SUFFISSI:
        candidato = base + suffisso
        try:
            catalogo = _catalogo_di(candidato)
        except requests.exceptions.RequestException as err:
            # una variante lenta non deve far scattare il circuit breaker:
            # si prova la successiva, l'errore si propaga solo se nessuna
            # delle chiamate e' andata a buon fine
            errore = err
            continue
        verificata = True
        if catalogo == CATALOGO:
            return candidato
    if not verificata and errore is not None:
        raise errore
    return None


def _resolve_edp_id(cands):
    """ID EDP della copia di questo portale, o None se non ce n'e' una.

    Prima versione: sceglieva fra le copie quella con quality_meas.scoring piu'
    alto, a prescindere dal catalogo. Per i dataset presenti anche nell'RNDT
    finiva per mostrare il voto del record RNDT sotto un dataset di dati.gov.it.
    """
    # 1. tentativo diretto: l'identificativo normalizzato e' quasi sempre l'ID
    if cands:
        trovato = _copia_del_catalogo(re.sub(r'~~\d+$', '', cands[0]))
        if trovato:
            return trovato

    # 2. ripiego: la ricerca, per quando la normalizzazione non coincide con
    #    quella di EDP; se ne ricavano le basi da provare
    expected = set(cands)
    basi = []
    for cand in cands:
        params = {
            'filters': 'dataset',
            'q': '"%s"' % cand,
            'limit': 20,
            'includes': 'id,resource',
        }
        resp = requests.get(SEARCH_URL, params=params, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        results = (resp.json().get('result') or {}).get('results') or []
        for r in results:
            rid = _edp_id_from_resource(r.get('resource'))
            base = re.sub(r'~~\d+$', '', rid or '')
            if base and (rid in expected or base in expected) and base not in basi:
                basi.append(base)
    for base in basi:
        trovato = _copia_del_catalogo(base)
        if trovato:
            return trovato
    return None


# ------------------------------------------------------------------ punteggio

def _band(score):
    if score >= 5:
        return 'Eccellente', 'green'
    if score >= 2.5:
        return 'Buono', 'goldenrod'
    return 'Sufficiente', 'red'


def _result(status, edp_id=None, score=None):
    out = {
        'status': status,   # ok | pending | notfound | error
        'score': score,
        'score_fmt': None,
        'label': None,
        'color': None,
        'link': (EDP_PAGE + requests.utils.quote(edp_id, safe='') + '/quality?locale=it')
                if edp_id else EDP_HOME,
    }
    if status == 'ok' and score is not None:
        out['score_fmt'] = ('%.1f' % score).replace('.', ',') + ' / 7,5'
        out['label'], out['color'] = _band(score)
    return out


def edp_mqa(pkg):
    """Helper di template: dict con status, score_fmt, label, color, link."""
    if not isinstance(pkg, dict) or not pkg.get('id'):
        return _result('notfound')

    key = KEY_PREFIX + pkg['id']
    cached = _cache_get(key)
    if cached:
        return cached

    if _cache_get(BREAKER_KEY):
        return _result('error')

    cands = _candidates(pkg)
    if not cands:
        res = _result('notfound')
        _cache_set(key, res, CACHE_TTL_KO)
        return res

    try:
        edp_id = _resolve_edp_id(cands)
        if not edp_id:
            res = _result('notfound')
            _cache_set(key, res, CACHE_TTL_KO)
            return res

        resp = requests.get(MQA_URL + requests.utils.quote(edp_id, safe=''),
                            headers=HEADERS, timeout=TIMEOUT)
        try:
            data = resp.json()
        except ValueError:
            data = {}

        final = None
        results = (data.get('result') or {}).get('results') or []
        if results:
            final = results[0].get('datasetFinal')

        if isinstance(final, (int, float)):
            res = _result('ok', edp_id, float(final))
            ttl = CACHE_TTL_OK
        elif 'no v2 metrics' in str(data.get('message', '')).lower():
            res = _result('pending', edp_id)
            ttl = CACHE_TTL_OK
        else:
            res = _result('notfound', edp_id)
            ttl = CACHE_TTL_KO

        log.debug('EDP MQA %s -> %s (%s)', pkg.get('name'), res['status'], edp_id)
        _cache_set(key, res, ttl)
        return res

    except requests.RequestException as e:
        log.warning('EDP MQA non raggiungibile per %s: %s', pkg.get('name'), e)
        _cache_set(BREAKER_KEY, {'down': True}, BREAKER_TTL)
        return _result('error')
    except Exception as e:
        log.warning('EDP MQA errore per %s: %s', pkg.get('name'), e)
        return _result('error')
