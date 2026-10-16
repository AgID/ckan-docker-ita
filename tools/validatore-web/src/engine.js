// Motore di validazione: parsing RDF + SHACL (rdf-validate-shacl), usabile in browser e in Node.
import rdf from '@zazuko/env/web.js'
import SHACLValidator from 'rdf-validate-shacl'
import { Parser as N3Parser } from 'n3'
import { RdfXmlParser } from 'rdfxml-streaming-parser'
import { JsonLdParser } from 'jsonld-streaming-parser'

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  sh: 'http://www.w3.org/ns/shacl#',
  dcat: 'http://www.w3.org/ns/dcat#',
  dcatap: 'http://data.europa.eu/r5r/',
}
export const HVD_ELI = 'http://data.europa.eu/eli/reg_impl/2023/138/oj'

export const PREFIXES = [
  ['http://www.w3.org/ns/dcat#', 'dcat:'], ['http://purl.org/dc/terms/', 'dct:'],
  ['http://data.europa.eu/r5r/', 'dcatap:'], ['http://xmlns.com/foaf/0.1/', 'foaf:'],
  ['http://www.w3.org/2006/vcard/ns#', 'vcard:'], ['http://www.w3.org/ns/adms#', 'adms:'],
  ['http://dati.gov.it/onto/dcatapit#', 'dcatapit:'], ['http://www.w3.org/2004/02/skos/core#', 'skos:'],
  ['http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'rdf:'], ['http://www.w3.org/2001/XMLSchema#', 'xsd:'],
  ['http://www.w3.org/ns/shacl#', 'sh:'], ['http://www.w3.org/ns/locn#', 'locn:'],
  ['http://www.w3.org/2002/07/owl#', 'owl:'], ['http://schema.org/', 'schema:'],
  ['http://www.w3.org/ns/prov#', 'prov:'], ['http://www.w3.org/ns/odrl/2/', 'odrl:'],
  ['http://spdx.org/rdf/terms#', 'spdx:'],
]
export function shorten (iri) {
  if (!iri) return ''
  for (const [ns, p] of PREFIXES) if (iri.startsWith(ns)) return p + iri.slice(ns.length)
  return iri
}

export function detectFormat (text, name = '') {
  const n = name.toLowerCase()
  if (/\.(rdf|xml|owl)$/.test(n)) return 'rdfxml'
  if (/\.(jsonld|json)$/.test(n)) return 'jsonld'
  if (/\.nt$/.test(n)) return 'ntriples'
  if (/\.(ttl|n3)$/.test(n)) return 'turtle'
  const head = text.slice(0, 2000).trimStart()
  if (head.startsWith('<?xml') || /^<rdf:RDF/.test(head) || /<rdf:RDF[\s>]/.test(head)) return 'rdfxml'
  if (head.startsWith('{') || head.startsWith('[')) return 'jsonld'
  return 'turtle'
}

function streamToQuads (parser, text, baseIRI) {
  return new Promise((resolve, reject) => {
    const quads = []
    parser.on('data', q => quads.push(q))
    parser.on('error', reject)
    parser.on('end', () => resolve(quads))
    parser.write(text)
    parser.end()
  })
}

export async function parseRdf (text, format, baseIRI = 'urn:x-base:') {
  if (format === 'rdfxml') return streamToQuads(new RdfXmlParser({ baseIRI, dataFactory: rdf }), text)
  if (format === 'jsonld') return streamToQuads(new JsonLdParser({ baseIRI, dataFactory: rdf }), text)
  const fmt = format === 'ntriples' ? 'N-Triples' : 'Turtle'
  return new N3Parser({ baseIRI, format: fmt, factory: rdf }).parse(text)
}

export async function datasetFromText (text, format) {
  const quads = await parseRdf(text, format)
  return rdf.dataset(quads)
}

// ---- conteggi sui dati
export function stats (ds) {
  const type = rdf.namedNode(NS.rdf + 'type')
  const count = c => new Set([...ds.match(null, type, rdf.namedNode(NS.dcat + c))].map(q => q.subject.value)).size
  return {
    triples: ds.size,
    catalogs: count('Catalog'),
    datasets: count('Dataset'),
    distributions: count('Distribution'),
    services: count('DataService'),
  }
}

// ---- individuazione delle risorse HVD (le shape HVD non hanno target propri)
export function hvdTargets (ds) {
  const t = p => rdf.namedNode(p)
  const type = t(NS.rdf + 'type'), al = t(NS.dcatap + 'applicableLegislation'), cat = t(NS.dcatap + 'hvdCategory')
  const eli = t(HVD_ELI)
  const isA = (s, c) => ds.match(s, type, t(NS.dcat + c)).size > 0
  const datasets = new Map()
  for (const q of ds.match(null, al, eli)) if (isA(q.subject, 'Dataset')) datasets.set(q.subject.value, q.subject)
  for (const q of ds.match(null, cat, null)) if (isA(q.subject, 'Dataset')) datasets.set(q.subject.value, q.subject)
  const distributions = new Map()
  for (const d of datasets.values()) for (const q of ds.match(d, t(NS.dcat + 'distribution'), null)) distributions.set(q.object.value, q.object)
  const services = new Map()
  for (const q of ds.match(null, type, t(NS.dcat + 'DataService'))) {
    const s = q.subject
    const serves = [...ds.match(s, t(NS.dcat + 'servesDataset'), null)].some(x => datasets.has(x.object.value))
    if (serves || ds.match(s, al, eli).size || ds.match(s, cat, null).size) services.set(s.value, s)
  }
  return { datasets: [...datasets.values()], distributions: [...distributions.values()], services: [...services.values()] }
}

function withTargets (shapesDs, map) {
  const out = rdf.dataset([...shapesDs])
  const tn = rdf.namedNode(NS.sh + 'targetNode')
  for (const [shape, nodes] of map) for (const n of nodes) out.add(rdf.quad(rdf.namedNode(shape), tn, n))
  return out
}

// ---- validazione di un profilo
const SEV = { Violation: 0, Warning: 1, Info: 2 }

function termText (t) {
  if (!t) return ''
  if (t.termType === 'Literal') return JSON.stringify(t.value.length > 120 ? t.value.slice(0, 117) + '...' : t.value)
  if (t.termType === 'BlankNode') return '_:' + t.value
  return t.value
}
function pathText (p) {
  if (!p) return ''
  if (Array.isArray(p)) return p.map(pathText).join('/')
  if (p.termType === 'BlankNode') return ''
  if (p.termType) return shorten(p.value)
  if (p.inverse) return '^' + pathText(p.inverse)
  return String(p)
}
function messageText (m) {
  if (!m || !m.length) return ''
  const it = m.find(x => x.language === 'it') || m.find(x => x.language === 'en') || m[0]
  return it.value
}

// Le shape EDP non hanno messaggi propri: si traducono quelli generici del motore SHACL.
const KIND = {
  BlankNodeOrIRI: 'un URI (o un nodo strutturato)', IRI: 'un URI', Literal: 'un testo (letterale)',
  BlankNode: 'un nodo strutturato', BlankNodeOrLiteral: 'un nodo o un testo', IRIOrLiteral: 'un URI o un testo',
}
export function spiega (message, component, value) {
  let m
  if ((m = /node kind <[^#>]*#(\w+)>/.exec(message))) {
    const atteso = KIND[m[1]] || m[1]
    const testo = value && value.startsWith('"')
    return `Il valore deve essere ${atteso}` + (testo && /IRI/.test(m[1]) ? ', non un testo tra virgolette' : '')
  }
  if ((m = /^Less than (\d+) values?/.exec(message))) return m[1] === '1' ? 'Proprietà obbligatoria assente' : `Servono almeno ${m[1]} valori`
  if ((m = /^More than (\d+) values?/.exec(message))) return m[1] === '1' ? 'Troppi valori: la proprietà ne ammette uno solo' : `Troppi valori: al massimo ${m[1]}`
  if (/StatusRestrictionADMS/.test(message)) return 'Stato non preso dal vocabolario ADMS (regola piveau che chiede il vocabolario DCAT-AP 2.1; con il vocabolario EU distribution-status il warning è atteso)'
  if (/DateOrDateTimeDataType/.test(message)) return 'La data deve essere xsd:date, xsd:dateTime, xsd:gYear o xsd:gYearMonth'
  if ((m = /does not have datatype <([^>]+)>/.exec(message))) return `Tipo di dato errato: atteso ${shorten(m[1])}`
  if ((m = /does not have class <([^>]+)>/.exec(message))) return `Il valore non è dichiarato come ${shorten(m[1])}`
  if ((m = /does not have shape <([^>]+)>/.exec(message))) return `Il valore non rispetta la regola ${shorten(m[1]).replace(/^.*#/, '')}`
  if (component === 'Or' || message === 'Or') return 'Il valore non rispetta nessuna delle forme ammesse'
  if (component === 'In') return 'Valore non tra quelli ammessi'
  if (component === 'Pattern') return 'Valore in una forma non ammessa'
  return message
}

export async function validateProfile (dataDs, shapesDs, profile) {
  const validator = new SHACLValidator(shapesDs, { factory: rdf, allowNamedNodeInList: true, importGraph: () => rdf.dataset(), maxNodeChecks: 0 })
  const report = await validator.validate(dataDs)
  const results = []
  for (const r of report.results) {
    const sev = (r.severity && r.severity.value.split('#')[1]) || 'Violation'
    const comp = r.sourceConstraintComponent ? r.sourceConstraintComponent.value.split('#')[1].replace(/ConstraintComponent$/, '') : ''
    const original = messageText(r.message) || comp
    results.push({
      profile,
      severity: sev,
      path: pathText(r.path),
      message: profile.startsWith('edp') ? spiega(original, comp, termText(r.value)) : original,
      original,
      component: comp,
      focus: termText(r.focusNode),
      value: termText(r.value),
      shape: r.sourceShape && r.sourceShape.termType === 'NamedNode' ? shorten(r.sourceShape.value) : '',
    })
  }
  return results
}

export function groupResults (results, examples = 3) {
  const groups = new Map()
  for (const r of results) {
    const k = [r.profile, r.severity, r.path, r.message].join('\u0001')
    let g = groups.get(k)
    if (!g) groups.set(k, g = { profile: r.profile, severity: r.severity, path: r.path, message: r.message, original: r.original, component: r.component, count: 0, focus: new Set(), examples: [] })
    g.count++
    g.focus.add(r.focus)
    if (g.examples.length < examples) g.examples.push({ focus: r.focus, value: r.value })
  }
  return [...groups.values()]
    .map(g => ({ ...g, nodes: g.focus.size, focus: undefined }))
    .sort((a, b) => (SEV[a.severity] - SEV[b.severity]) || (b.count - a.count))
}

// ---- profili
// shapeTexts: { edp, edpDeprecated, edpRecommended, dcatapit, vocabolari, hvd } (Turtle)
export async function buildProfiles (shapeTexts) {
  const p = async t => rdf.dataset(await parseRdf(t, 'turtle', 'urn:x-shapes:'))
  return {
    edp: rdf.dataset([...(await p(shapeTexts.edp)), ...(await p(shapeTexts.edpDeprecated))]),
    edpRecommended: await p(shapeTexts.edpRecommended),
    dcatapit: await p(shapeTexts.dcatapit),
    vocabolari: await p(shapeTexts.vocabolari),
    hvd: await p(shapeTexts.hvd),
  }
}

export const PROFILE_LABELS = {
  edp: 'EDP · DCAT-AP 3.0.0 L1',
  edpRecommended: 'EDP · raccomandate',
  dcatapit: 'DCAT-AP_IT',
  vocabolari: 'Vocabolari',
  hvd: 'HVD',
}

// Esegue i profili selezionati sui dati. selected: array di chiavi di PROFILE_LABELS.
export async function runValidation (dataDs, profiles, selected) {
  const all = []
  const meta = {}
  for (const key of selected) {
    let shapes = profiles[key]
    if (key === 'hvd') {
      const t = hvdTargets(dataDs)
      meta.hvd = { datasets: t.datasets.length, distributions: t.distributions.length, services: t.services.length }
      if (!t.datasets.length && !t.services.length) continue
      shapes = withTargets(shapes, [
        ['urn:validatore-dcatapit:shapes:hvd#Dataset', t.datasets],
        ['urn:validatore-dcatapit:shapes:hvd#Distribution', t.distributions],
        ['urn:validatore-dcatapit:shapes:hvd#DataService', t.services],
      ])
    }
    all.push(...await validateProfile(dataDs, shapes, key))
  }
  return { results: all, meta }
}
