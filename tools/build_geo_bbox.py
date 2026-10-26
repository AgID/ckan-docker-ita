#!/usr/bin/env python3
"""
build_geo_bbox.py - rigenera geo_bbox.json, la tabella usata dal profilo RDF
per scrivere dcat:bbox e dcat:centroid sui luoghi (dct:Location) dei dataset.

Fonti:
  1. Cruscotto Italia (catalogo DCAT paginato): riquadro e centroide di ogni
     comune, chiave codice ISTAT
     https://cruscotto-italia.dati.gov.it/data/dcat/catalog_N.ttl
  2. GeoNames, dump Italia: id GeoNames -> codice ISTAT (campo admin3 dei comuni
     ADM3 e delle localita'); regioni (ADM1) e province (ADM2) ricevono l'unione
     dei riquadri dei loro comuni, con centroide = centro del riquadro
     https://download.geonames.org/export/dump/IT.zip
  3. Vocabolario EU place: codice ITA_XXX -> comune, per nome italiano
     http://publications.europa.eu/resource/authority/place/ITA_XXX

Uso:
  python3 build_geo_bbox.py -o geo_bbox.json
  python3 build_geo_bbox.py -o geo_bbox.json --place MIL FLR TRN   # codici EU place

Il file va copiato accanto al profilo:
  2.10: ckan/patches/ckanext-dcatapit/ckanext/dcatapit/dcat/geo_bbox.json
  2.12: ckan/ckanext-dcatita/ckanext/dcatita/geo_bbox.json
"""
import argparse
import csv
import io
import json
import re
import sys
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

from rdflib import Graph, URIRef
from rdflib.namespace import SKOS

CRUSCOTTO = 'https://cruscotto-italia.dati.gov.it/data/dcat/catalog_%d.ttl'
GEONAMES = 'https://download.geonames.org/export/dump/IT.zip'
PLACE = 'http://publications.europa.eu/resource/authority/place/ITA_%s'
ITALIA = ['POLYGON((6.626621 35.492853, 18.520382 35.492853, 18.520382 47.091784, '
          '6.626621 47.091784, 6.626621 35.492853))', 'POINT(12.573502 41.292318)']
# codici EU place usati su dati.gov.it (ottobre 2026)
PLACE_DEFAULT = ('AGR AOI BEK BGO BLQ BRI BZO CTA FLR FRR GOA MAN MEN MIL MOD MSN MTR NAP '
                 'NVR OMO OTA PAV PDA PMF PMO RAN REG RMI RNE ROM SIR SVN TAR TRN TRT VRN').split()
# nomi del vocabolario EU che non coincidono con il nome ISTAT
PLACE_ALIAS = {'brunico': 'brunico/bruneck', 'bolzano': 'bolzano/bozen', 'merano': 'merano/meran',
               'reggio calabria': 'reggio di calabria', 'reggio emilia': "reggio nell'emilia"}

RX = re.compile(r'geographicalIdentifier "ISTAT:(\d{6})" ;\s*skos:prefLabel "([^"]+)"@it ;\s*'
                r'dcat:bbox "([^"]+)"\^\^geo:wktLiteral ;\s*dcat:centroid "([^"]+)"')


def get(url, accept=None):
    req = urllib.request.Request(url, headers={'Accept': accept} if accept else {})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def cruscotto():
    first = get(CRUSCOTTO % 1).decode('utf-8')
    m = re.search(r'hydra:last "[^"]*catalog_(\d+)\.ttl"', first)
    last = int(m.group(1)) if m else 1
    pages = [first]
    with ThreadPoolExecutor(8) as ex:
        pages += list(ex.map(lambda n: get(CRUSCOTTO % n).decode('utf-8'), range(2, last + 1)))
    out = {}
    for s in pages:
        for m in RX.finditer(s):
            out[m.group(1)] = [m.group(2), m.group(3), m.group(4)]
    print('Cruscotto: %d pagine, %d comuni' % (last, len(out)), file=sys.stderr)
    return out


def box(wkt):
    c = [(float(a), float(b)) for a, b in re.findall(r'(-?\d+\.?\d*) (-?\d+\.?\d*)', wkt)]
    return (min(x for x, _ in c), min(y for _, y in c), max(x for x, _ in c), max(y for _, y in c))


def wkt(b):
    x1, y1, x2, y2 = b
    return ['POLYGON((%g %g, %g %g, %g %g, %g %g, %g %g))' % (x1, y1, x2, y1, x2, y2, x1, y2, x1, y1),
            'POINT(%.5f %.5f)' % ((x1 + x2) / 2, (y1 + y2) / 2)]


def union(a, b):
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])) if a else b


def geonames(comuni):
    z = zipfile.ZipFile(io.BytesIO(get(GEONAMES)))
    csv.field_size_limit(10 ** 9)
    rows = list(csv.reader(io.TextIOWrapper(z.open('IT.txt'), encoding='utf-8'),
                           delimiter='\t', quoting=csv.QUOTE_NONE))
    ids, adm1, adm2 = {}, {}, {}
    for r in rows:
        gid, fclass, fcode, a1, a2, a3 = r[0], r[6], r[7], r[10], r[11], r[12]
        if a3 in comuni and (fcode == 'ADM3' or fclass == 'P'):
            ids[gid] = a3
        if fcode == 'ADM3' and a3 in comuni:
            b = box(comuni[a3][1])
            adm1[a1] = union(adm1.get(a1), b)
            adm2[(a1, a2)] = union(adm2.get((a1, a2)), b)
    aree = {}
    for r in rows:
        if r[7] == 'ADM1' and r[10] in adm1:
            aree[r[0]] = wkt(adm1[r[10]])
        elif r[7] == 'ADM2' and (r[10], r[11]) in adm2:
            aree[r[0]] = wkt(adm2[(r[10], r[11])])
    print('GeoNames: %d id -> comune, %d regioni/province' % (len(ids), len(aree)), file=sys.stderr)
    return ids, aree


def places(codes, comuni):
    byname = {}
    for k, v in comuni.items():
        byname.setdefault(v[0].lower(), []).append(k)
    out = {}
    for c in codes:
        try:
            rdf = get(PLACE % c, 'application/rdf+xml').decode('utf-8')
        except Exception as err:  # noqa: BLE001
            print('  ITA_%s: %s' % (c, err), file=sys.stderr)
            continue
        g = Graph()
        g.parse(data=rdf, format='xml')
        labels = {o.language: str(o) for o in g.objects(URIRef(PLACE % c), SKOS.prefLabel)}
        name = (labels.get('it') or labels.get('en') or '').strip().lower()
        hit = byname.get(PLACE_ALIAS.get(name, name), [])
        if len(hit) == 1:
            out['ITA_' + c] = hit[0]
        else:
            print('  ITA_%s (%s): %d comuni corrispondenti, saltato' % (c, name, len(hit)), file=sys.stderr)
    print('EU place: %d codici' % len(out), file=sys.stderr)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('-o', '--output', default='geo_bbox.json')
    ap.add_argument('--place', nargs='*', default=PLACE_DEFAULT, help='codici EU place senza ITA_')
    a = ap.parse_args()
    comuni = cruscotto()
    ids, aree = geonames(comuni)
    aree['3175395'] = aree['ITA'] = ITALIA
    data = {'istat': {k: v[1:] for k, v in comuni.items()}, 'geonames': ids,
            'aree': aree, 'place': places(a.place, comuni)}
    with open(a.output, 'w') as fp:
        json.dump(data, fp, separators=(',', ':'))
    print('Scritto %s' % a.output, file=sys.stderr)


if __name__ == '__main__':
    main()
