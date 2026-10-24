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

// I @context remoti non vengono scaricati: un file potrebbe far fare al browser
// richieste verso indirizzi scelti da chi l'ha scritto. Vale solo il contesto
// scritto nel file, come nel JSON-LD prodotto da CKAN.
const noRemoteContexts = {
  load (url) {
    return Promise.reject(new Error(`@context remoto non ammesso (${url}): inserisci il contesto nel file o usa Turtle/RDF-XML`))
  },
}

// Dimensione massima accettata per file, testo incollato e URL.
export const MAX_BYTES = 100 * 1024 * 1024

// Base per gli IRI relativi del catalogo (es. vcard:hasEmail <nome@ente.it> senza mailto:):
// nel report si mostrano come scritti nel file, segnalati. .invalid non esiste (RFC 2606).
export const REL_BASE = 'https://iri-relativo.invalid/'
export function rel (s) {
  return s && s.includes(REL_BASE) ? s.split(REL_BASE).join('') + ' (IRI relativo: manca lo schema, es. mailto: o https://)' : s
}

export async function parseRdf (text, format, baseIRI = REL_BASE) {
  if (format === 'rdfxml') return streamToQuads(new RdfXmlParser({ baseIRI, dataFactory: rdf }), text)
  if (format === 'jsonld') return streamToQuads(new JsonLdParser({ baseIRI, dataFactory: rdf, documentLoader: noRemoteContexts }), text)
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

// ---- paginazione del catalogo (hydra:PagedCollection di ckanext-dcat)
// Numero dell'ultima pagina e della successiva, letti dal ?page=N degli URL hydra;
// null se il file non e' paginato.
const HYDRA = 'http://www.w3.org/ns/hydra/core#'
export function pagingInfo (ds) {
  const pageOf = p => {
    for (const q of ds.match(null, rdf.namedNode(HYDRA + p))) {
      const m = /[?&]page=(\d+)/.exec(q.object.value)
      if (m) return +m[1]
    }
    return null
  }
  let total = null
  for (const q of ds.match(null, rdf.namedNode(HYDRA + 'totalItems'))) total = +q.object.value
  return { last: pageOf('lastPage'), next: pageOf('nextPage'), total: Number.isFinite(total) ? total : null }
}

// IRI dei cataloghi: in un catalogo paginato il catalogo radice si ripete in ogni pagina
export function catalogIris (ds) {
  return [...new Set([...ds.match(null, rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.dcat + 'Catalog'))].map(q => q.subject.value))]
}

// Unisce le validazioni di piu' pagine dello stesso catalogo. Ogni pagina si valida da sola
// (unendo i grafi, i nodi anonimi ripetuti come il dct:publisher darebbero falsi MaxCount);
// qui si toglie solo cio' che le pagine ripetono identico: una segnalazione su una risorsa
// con IRI gia' segnalata in una pagina precedente (tipicamente il catalogo radice).
// I nodi anonimi hanno etichette diverse in ogni pagina e non vengono mai fusi.
// pages: [{ results, meta, stats, catalogs }]
export function mergePages (pages) {
  const seen = new Set()
  const results = []
  let duplicates = 0
  for (const p of pages) {
    const mine = new Set()
    for (const r of p.results) {
      const key = r.focus && !r.focus.startsWith('_:') ? [r.profile, r.severity, r.path, r.message, r.focus, r.value].join('\u0001') : null
      if (key && seen.has(key)) { duplicates++; continue }
      if (key) mine.add(key)
      results.push(r)
    }
    for (const k of mine) seen.add(k)
  }
  const cats = new Set()
  const st = { triples: 0, catalogs: 0, datasets: 0, distributions: 0, services: 0 }
  for (const p of pages) {
    for (const k of ['triples', 'datasets', 'distributions', 'services']) st[k] += p.stats[k]
    for (const c of p.catalogs || []) cats.add(c)
  }
  st.catalogs = cats.size
  const meta = {}
  const hvds = pages.map(p => p.meta.hvd).filter(Boolean)
  if (hvds.length) meta.hvd = hvds.reduce((a, h) => ({ datasets: a.datasets + h.datasets, distributions: a.distributions + h.distributions, services: a.services + h.services }), { datasets: 0, distributions: 0, services: 0 })
  const ipas = pages.map(p => p.meta.ipa).filter(Boolean)
  if (ipas.length) {
    const codes = new Set(); const missing = new Set()
    for (const m of ipas) { (m.codes || []).forEach(c => codes.add(c)); (m.missing || []).forEach(c => missing.add(c)) }
    meta.ipa = { checked: codes.size, notFound: missing.size, error: ipas.map(m => m.error).find(Boolean) || '' }
  }
  return { results, meta, stats: st, duplicates }
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
  return rel(t.value)
}
function pathText (p, ds) {
  if (!p) return ''
  if (Array.isArray(p)) return p.map(x => pathText(x, ds)).join('/')
  if (p.termType === 'BlankNode') return ds ? listPath(p, ds) : ''
  if (p.termType) return shorten(p.value)
  if (p.inverse) return '^' + pathText(p.inverse)
  return String(p)
}
// percorso a sequenza (es. dct:publisher/foaf:mbox): nel report e' una lista RDF
function listPath (node, ds) {
  const first = rdf.namedNode(NS.rdf + 'first'), rest = rdf.namedNode(NS.rdf + 'rest'), nil = NS.rdf + 'nil'
  const parts = []
  for (let n = node, i = 0; n && n.value !== nil && i < 10; i++) {
    let f = null, r = null
    for (const q of ds.match(n, first)) f = q.object
    for (const q of ds.match(n, rest)) r = q.object
    if (!f) break
    parts.push(f.termType === 'NamedNode' ? shorten(f.value) : '')
    n = r
  }
  return parts.join('/')
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
// regola raccomandata EDP :Catalog_Shape2 (sh:or senza proprieta'): il catalogo deve elencare
// direttamente almeno un dcat:dataset o un dcat:service
const CATALOG_OR = /Catalog_Shape2$/
export function spiega (message, component, value, severity = 'Violation', shape = '', federato = false) {
  let m
  if (component === 'Or' && CATALOG_OR.test(shape)) {
    return federato
      ? 'Catalogo che elenca solo sottocataloghi (dct:hasPart): la regola raccomandata chiede almeno un dcat:dataset o dcat:service diretto'
      : 'Catalogo senza dataset né servizi: la regola raccomandata chiede almeno un dcat:dataset o un dcat:service'
  }
  if ((m = /node kind <[^#>]*#(\w+)>/.exec(message))) {
    const atteso = KIND[m[1]] || m[1]
    const testo = value && value.startsWith('"')
    return `Il valore deve essere ${atteso}` + (testo && /IRI/.test(m[1]) ? ', non un testo tra virgolette' : '')
  }
  // piveau usa lo stesso vincolo sia per le obbligatorie (Violation) sia per le raccomandate (Warning)
  if ((m = /^Less than (\d+) values?/.exec(message))) return m[1] === '1' ? (severity === 'Violation' ? 'Proprietà obbligatoria assente' : 'Proprietà raccomandata assente') : `Servono almeno ${m[1]} valori`
  if ((m = /^More than (\d+) values?/.exec(message))) return m[1] === '1' ? 'Troppi valori: la proprietà ne ammette uno solo' : `Troppi valori: al massimo ${m[1]}`
  if (/StatusRestrictionADMS/.test(message)) return 'Stato non preso dal vocabolario ADMS (regola piveau che chiede il vocabolario DCAT-AP 2.1; con il vocabolario EU distribution-status il warning è atteso)'
  if (/DateOrDateTimeDataType/.test(message)) return 'La data deve essere xsd:date, xsd:dateTime, xsd:gYear o xsd:gYearMonth'
  if ((m = /does not have datatype <([^>]+)>/.exec(message))) return `Tipo di dato errato: atteso ${shorten(m[1])}`
  if ((m = /does not have class <([^>]+)>/.exec(message))) return `Il valore non è dichiarato come ${shorten(m[1])}`
  if ((m = /does not have shape <([^>]+)>/.exec(message))) return `Il valore non rispetta la regola ${shorten(m[1]).replace(/^.*#/, '')}`
  if (component === 'Or' || message === 'Or') return 'Il valore non rispetta nessuna delle forme ammesse' + (shape ? ` (regola ${shape.replace(/^.*[#:]/, '')})` : '')
  if (component === 'In') return 'Valore non tra quelli ammessi'
  if (component === 'Pattern') return 'Valore in una forma non ammessa'
  return message
}

// Per un nodo anonimo risale a chi lo contiene: "dct:publisher di <URI>".
// Si ferma al primo URI o dopo 4 passaggi; null se il nodo non e' anonimo.
function ownerOf (dataDs, node, cache) {
  if (!node || node.termType !== 'BlankNode') return null
  if (cache.has(node.value)) return cache.get(node.value)
  const steps = []
  let cur = node
  for (let i = 0; i < 4 && cur.termType === 'BlankNode'; i++) {
    let q = null
    for (const x of dataDs.match(null, null, cur)) { q = x; break }
    if (!q) break
    steps.push(shorten(q.predicate.value))
    cur = q.subject
  }
  const out = steps.length ? { path: steps.join(' di '), owner: cur.termType === 'NamedNode' ? rel(cur.value) : '' } : null
  cache.set(node.value, out)
  return out
}

export async function validateProfile (dataDs, shapesDs, profile) {
  const validator = new SHACLValidator(shapesDs, { factory: rdf, allowNamedNodeInList: true, importGraph: () => rdf.dataset(), maxNodeChecks: 0 })
  const report = await validator.validate(dataDs)
  const results = []
  const owners = new Map()
  for (const r of report.results) {
    const sev = (r.severity && r.severity.value.split('#')[1]) || 'Violation'
    const comp = r.sourceConstraintComponent ? r.sourceConstraintComponent.value.split('#')[1].replace(/ConstraintComponent$/, '') : ''
    const original = messageText(r.message) || comp
    const shape = r.sourceShape && r.sourceShape.termType === 'NamedNode' ? shorten(r.sourceShape.value) : ''
    const catalogOr = comp === 'Or' && CATALOG_OR.test(shape)
    const federato = catalogOr && r.focusNode && dataDs.match(r.focusNode, rdf.namedNode('http://purl.org/dc/terms/hasPart')).size > 0
    results.push({
      profile,
      severity: sev,
      path: pathText(r.path, report.dataset) || (catalogOr ? 'dcat:dataset / dcat:service' : ''),
      message: profile.startsWith('edp') ? spiega(original, comp, termText(r.value), sev, shape, federato) : original,
      // avvisi attesi: stato ADMS (regola piveau, issue #124) e catalogo radice federato
      atteso: sev !== 'Warning' ? '' : /StatusRestrictionADMS/.test(original) ? 'stato' : federato ? 'sottocataloghi' : '',
      original,
      component: comp,
      focus: termText(r.focusNode),
      where: ownerOf(dataDs, r.focusNode, owners),
      value: termText(r.value),
      shape,
    })
  }
  return results
}

export function groupResults (results, examples = 3) {
  const groups = new Map()
  for (const r of results) {
    const k = [r.profile, r.severity, r.path, r.message].join('\u0001')
    let g = groups.get(k)
    if (!g) groups.set(k, g = { profile: r.profile, severity: r.severity, path: r.path, message: r.message, original: r.original, component: r.component, atteso: r.atteso || '', count: 0, focus: new Set(), examples: [] })
    g.count++
    g.focus.add(r.focus)
    if (g.examples.length < examples) g.examples.push({ focus: r.focus, where: r.where, value: r.value })
  }
  return [...groups.values()]
    .map(g => ({ ...g, nodes: g.focus.size, focus: undefined }))
    .sort((a, b) => (SEV[a.severity] - SEV[b.severity]) || (b.count - a.count))
}

// ---- profili
// shapeTexts: { edp, edpDeprecated, edpRecommended, dcatapit, vocabolari, vocabolariElenchi, hvd, agid } (Turtle)
export async function buildProfiles (shapeTexts) {
  const p = async t => rdf.dataset(await parseRdf(t, 'turtle', 'urn:x-shapes:'))
  return {
    edp: rdf.dataset([...(await p(shapeTexts.edp)), ...(await p(shapeTexts.edpDeprecated))]),
    edpRecommended: await p(shapeTexts.edpRecommended),
    dcatapit: await p(shapeTexts.dcatapit),
    // regole sui vocabolari + elenchi chiusi di data.europa.eu (formati, media type)
    vocabolari: rdf.dataset([...(await p(shapeTexts.vocabolari)), ...(await p(shapeTexts.vocabolariElenchi || ''))]),
    hvd: await p(shapeTexts.hvd),
    agid: await p(shapeTexts.agid),
  }
}

// Regola operativa AgID non esprimibile in SHACL Core: il prefisso dell'identificativo
// del dataset (codiceIPA:...) deve coincidere con il codice IPA del titolare.
// Stessa logica di agid_checks() in tools/validate_edp_shacl.py.
const DCT = 'http://purl.org/dc/terms/'
export const AGID_PREFIX_MSG = "Il prefisso dell'identificativo del dataset non coincide con il codice IPA del titolare (dct:rightsHolder/dct:identifier)"
export const AGID_PREFIX_EDITORE_MSG = "Il prefisso dell'identificativo del dataset è il codice IPA dell'editore (dct:publisher), non quello del titolare (dct:rightsHolder): l'identificativo va costruito con il codice IPA del titolare"
export function agidChecks (dataDs) {
  const out = []
  const owners = new Map()
  const ident = rdf.namedNode(DCT + 'identifier')
  const holderP = rdf.namedNode(DCT + 'rightsHolder')
  const first = (s, p) => { for (const q of dataDs.match(s, p)) return q.object; return null }
  const datasets = new Set([...dataDs.match(null, rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.dcat + 'Dataset'))].map(q => q.subject))
  for (const d of datasets) {
    const id = first(d, ident)
    if (!id || id.termType !== 'Literal') continue
    // il titolare puo' essere piu' d'uno (1..N): basta che il prefisso sia il codice di uno di loro
    const hids = []
    for (const q of dataDs.match(d, holderP)) {
      for (const x of dataDs.match(q.object, ident)) if (x.object.termType === 'Literal' && x.object.value.trim()) hids.push(x.object.value.trim())
    }
    const m = /^([^:]+):/.exec(id.value)
    if (!m || !hids.length) continue
    if (hids.includes(m[1])) continue   // confronto esatto: i codici IPA vanno scritti come in IndicePA
    // caso frequente: l'ente che pubblica (editore) usa il proprio codice per un dataset
    // di cui il titolare e' un altro soggetto (es. Comune di Bari per AMIU)
    const pubs = []
    for (const q of dataDs.match(d, rdf.namedNode(DCT + 'publisher'))) {
      for (const x of dataDs.match(q.object, ident)) if (x.object.termType === 'Literal') pubs.push(x.object.value.trim())
    }
    const editore = pubs.includes(m[1])
    const msg = editore ? AGID_PREFIX_EDITORE_MSG : AGID_PREFIX_MSG
    const tit = [...new Set(hids)].sort().map(x => JSON.stringify(x)).join(' / ')
    out.push({
      profile: 'agid', severity: 'Info', path: 'dct:identifier', message: msg, original: msg,
      component: 'CodiceIPA', focus: termText(d), where: ownerOf(dataDs, d, owners),
      value: editore ? `${JSON.stringify(id.value)}: prefisso dell'editore ${JSON.stringify(m[1])}, titolare ${tit}` : `${JSON.stringify(id.value)} ≠ titolare ${tit}`, shape: '',
    })
  }
  return out
}

export const PROFILE_LABELS = {
  edp: 'EDP · DCAT-AP 3.0.0 L1',
  edpRecommended: 'EDP · raccomandate',
  dcatapit: 'DCAT-AP_IT',
  vocabolari: 'Vocabolari',
  hvd: 'HVD',
  agid: 'Indicazioni AgID',
}

// Esegue i profili selezionati sui dati. selected: array di chiavi di PROFILE_LABELS.
// ---- IndicePA: il codice IPA del titolare deve esistere nell'elenco degli enti
// (https://indicepa.gov.it/ipa-dati, CKAN con datastore, CORS aperto).
// Si inviano solo i codici, gia' filtrati sul formato del codice IPA, quindi la
// query SQL non puo' contenere altro. Stessa logica di ipa_check() nello script.
export const IPA_API = 'https://indicepa.gov.it/ipa-dati/api/3/action/datastore_search_sql'
export const IPA_ENTI = 'd09adf99-dc10-4349-8c53-27b1e5aa97b6'   // dataset "enti"
export const IPA_UO = 'b0aa1f6c-f135-4c8a-b416-396fed4e1a5d'     // dataset "unita-organizzative"
export const IPA_MSG = "Il codice IPA del titolare (dct:rightsHolder/dct:identifier) non è allineato a IndicePA"
// cache (facoltativa, Map codice minuscolo -> { ok, hint }): condivisa fra le pagine di uno
// stesso catalogo, cosi' ogni codice si chiede a IndicePA una volta sola.
export async function ipaCheck (dataDs, fetchFn = globalThis.fetch, cache = null) {
  const ident = rdf.namedNode(DCT + 'identifier')
  const byCode = new Map()   // codice minuscolo -> nodi titolare
  for (const q of dataDs.match(null, rdf.namedNode(DCT + 'rightsHolder'))) {
    for (const i of dataDs.match(q.object, ident)) {
      const c = i.object.termType === 'Literal' ? i.object.value.trim() : ''
      if (!/^[A-Za-z0-9_]{2,40}$/.test(c)) continue   // fuori formato: lo segnala gia' la regola sul formato
      const k = c.toLowerCase()
      if (!byCode.has(k)) byCode.set(k, { codes: new Set(), nodes: [] })
      byCode.get(k).codes.add(c)
      byCode.get(k).nodes.push([q.subject, c])
    }
  }
  const meta = { checked: byCode.size, notFound: 0, error: '', codes: [...byCode.keys()], missing: [] }
  if (!byCode.size) return { results: [], meta }
  const todo = cache ? [...byCode.keys()].filter(k => !cache.has(k)) : [...byCode.keys()]
  const official = new Map()
  const hint = new Map()   // codice minuscolo -> suggerimento (UO o codice fiscale di un ente)
  // a blocchi di 150 codici; ogni codice e' gia' [A-Za-z0-9_], quindi sicuro dentro la stringa SQL
  const query = async (codes, build) => {
    const out = []
    for (let i = 0; i < codes.length; i += 150) {
      const list = codes.slice(i, i + 150).map(c => `'${c}'`).join(',')
      const r = await fetchFn(IPA_API + '?sql=' + encodeURIComponent(build(list)), { signal: AbortSignal.timeout(30000), referrerPolicy: 'no-referrer', credentials: 'omit' })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const j = await r.json()
      if (!j.success) throw new Error('risposta non valida')
      out.push(...j.result.records)
    }
    return out
  }
  try {
    // ricerca senza distinguere maiuscole, poi confronto esatto: "unito" non e' "UNITO"
    // official: minuscolo -> codice come scritto in IndicePA
    if (todo.length) for (const rec of await query(todo, l => `SELECT "Codice_IPA" AS c FROM "${IPA_ENTI}" WHERE lower("Codice_IPA") IN (${l})`)) official.set(String(rec.c).toLowerCase(), String(rec.c))
    const missing = todo.filter(k => !official.has(k))
    // spesso al posto del codice dell'ente c'e' il codice di una sua unita' organizzativa o il codice fiscale
    if (missing.length) {
      for (const rec of await query(missing.map(k => k.toUpperCase()), l => `SELECT upper("Codice_uni_uo") AS c, "Codice_IPA" AS ipa, "Descrizione_uo" AS d FROM "${IPA_UO}" WHERE upper("Codice_uni_uo") IN (${l})`)) {
        hint.set(String(rec.c).toLowerCase(), `è il codice dell'unità organizzativa «${rec.d}» dell'ente ${rec.ipa}: usare ${rec.ipa}`)
      }
      const cf = missing.filter(k => /^\d{11}$/.test(k))
      if (cf.length) {
        for (const rec of await query(cf, l => `SELECT "Codice_fiscale_ente" AS c, "Codice_IPA" AS ipa, "Denominazione_ente" AS d FROM "${IPA_ENTI}" WHERE "Codice_fiscale_ente" IN (${l})`)) {
          hint.set(String(rec.c), `è il codice fiscale di «${rec.d}»: usare il codice IPA ${rec.ipa}`)
        }
      }
    }
  } catch (e) {
    meta.error = e.message || String(e)
    return { results: [], meta }
  }
  if (cache) {
    for (const k of todo) cache.set(k, { ok: official.get(k) || null, hint: hint.get(k) || '' })
    for (const k of byCode.keys()) {
      const c = cache.get(k)
      if (c.ok) official.set(k, c.ok)
      if (c.hint) hint.set(k, c.hint)
    }
  }
  for (const [k, { codes }] of byCode) {
    const ok = official.get(k)
    if (ok && [...codes].some(c => c !== ok)) hint.set(k, `maiuscole/minuscole diverse da IndicePA: il codice è ${ok}`)
  }
  const owners = new Map()
  const results = []
  for (const [k, { nodes }] of byCode) {
    const ok = official.get(k)
    const bad = nodes.filter(([, c]) => c !== ok)
    if (!bad.length) continue
    meta.notFound++
    meta.missing.push(k)
    for (const [d, code] of bad) {
      results.push({
        profile: 'agid', severity: 'Info', path: 'dct:rightsHolder/dct:identifier', message: IPA_MSG, original: IPA_MSG,
        component: 'IndicePA', focus: termText(d), where: ownerOf(dataDs, d, owners),
        value: JSON.stringify(code) + ' — ' + (hint.get(k) || 'nessun ente con questo codice'), shape: '',
      })
    }
  }
  return { results, meta }
}

// opts.ipa === false salta la verifica su IndicePA (es. test senza rete)
export async function runValidation (dataDs, profiles, selected, opts = {}) {
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
    if (key === 'agid') {
      all.push(...agidChecks(dataDs))
      if (opts.ipa !== false) {
        const r = await ipaCheck(dataDs, globalThis.fetch, opts.ipaCache || null)
        meta.ipa = r.meta
        all.push(...r.results)
      }
    }
  }
  return { results: all, meta }
}
