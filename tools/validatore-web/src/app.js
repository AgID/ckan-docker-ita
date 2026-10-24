import { MAX_BYTES, buildProfiles, datasetFromText, detectFormat, runValidation, groupResults, stats, pagingInfo, catalogIris, mergePages, PROFILE_LABELS } from './engine.js'
import edp from '../../shapes/edp/shapes.ttl'
import edpDeprecated from '../../shapes/edp/deprecateduris.ttl'
import edpRecommended from '../../shapes/edp/shapes_recommended.ttl'
import dcatapit from '../../shapes/dcatapit.ttl'
import vocabolari from '../../shapes/vocabolari.ttl'
import vocabolariElenchi from '../../shapes/vocabolari-elenchi.ttl'
import hvd from '../../shapes/hvd.ttl'
import agid from '../../shapes/agid.ttl'
import esempio from '../test/esempio.ttl'

const SHAPES = { edp, edpDeprecated, edpRecommended, dcatapit, vocabolari, vocabolariElenchi, hvd, agid }
const ORDER = ['edp', 'edpRecommended', 'dcatapit', 'vocabolari', 'hvd', 'agid']
const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

let profilesP = null
const getProfiles = () => (profilesP ||= buildProfiles(SHAPES))

const state = {
  source: { kind: 'esempio', name: 'esempio-errori.ttl', text: esempio },
  last: null,          // { groups, results, stats, meta, selected, sourceName, ms }
  filterSev: new Set(['Violation', 'Info']),   // avvisi nascosti di default; indicazioni AgID visibili
  filterProfile: 'tutti',
  query: '',
}

// ------------------------------------------------------------ sorgente
let activeTab = 'file'
function setTab (kind) {
  activeTab = kind
  for (const b of document.querySelectorAll('[data-tab]')) {
    const on = b.dataset.tab === kind
    b.setAttribute('aria-selected', on)
    document.getElementById('pane-' + b.dataset.tab).hidden = !on
  }
}
function setSource (src) {
  state.source = src
  $('#src-name').textContent = src.name
  $('#src-size').textContent = src.text ? fmtBytes(src.text.length) : ''
  $('#src-example').hidden = src.kind !== 'esempio'
}
function fmtBytes (n) {
  return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B'
}

const troppoGrande = n => `File troppo grande (${fmtBytes(n)}): il limite è ${fmtBytes(MAX_BYTES)}. Valida una pagina alla volta (?page=N) o un sottoinsieme.`
// tetto di sicurezza per «Tutte le pagine»: oltre si interrompe (dati.gov.it ne ha ~650)
const MAX_PAGES = 2000

async function readFile (file) {
  if (file.size > MAX_BYTES) { setStatus('error', troppoGrande(file.size)); return }
  const text = await file.text()
  setSource({ kind: 'file', name: file.name, text })
  validate()
}

// pageOverride: numero di pagina imposto (modalita' «Tutte le pagine»)
function ckanUrl (pageOverride) {
  const base = $('#ckan-base').value.trim().replace(/\/+$/, '')
  if (!base) return ''
  const fmt = $('#ckan-format').value
  const params = new URLSearchParams()
  const page = pageOverride ? String(pageOverride) : $('#ckan-page').value.trim()
  if (pageOverride || (page && page !== '1')) params.set('page', page)
  const name = $('#ckan-name').value.trim()
  const fq = $('#ckan-fq').value.trim()
  if (name) params.set('fq', 'name:' + name)
  else if (fq) params.set('fq', fq)
  const q = params.toString()
  return `${base}/catalog.${fmt}${q ? '?' + q : ''}`
}
const allPages = () => $('#ckan-all').checked
function refreshCkanPreview () {
  const all = allPages()
  $('#ckan-page').disabled = all
  $('#ckan-all-note').hidden = !all
  const u = all ? ckanUrl(1) : ckanUrl()
  $('#ckan-preview').textContent = u ? (all ? u.replace(/page=1$/, 'page=1, 2, 3 … fino all\'ultima') : u) : 'https://…/catalog.ttl'
}

// legge la risposta fermandosi oltre MAX_BYTES (null se superato)
async function readCapped (r) {
  const len = +r.headers.get('content-length')
  if (len > MAX_BYTES) return null
  if (!r.body) return r.text()
  const reader = r.body.getReader()
  const parts = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > MAX_BYTES) { reader.cancel(); return null }
    parts.push(value)
  }
  return new TextDecoder().decode(await new Blob(parts).arrayBuffer())
}

// solo http/https, verificato con il parser URL del browser (non con una regex sul testo)
function isHttpUrl (u) {
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' } catch { return false }
}

class TooBig extends Error {}
// scarica un indirizzo http/https; null se l'indirizzo non e' valido
async function fetchText (url) {
  if (!isHttpUrl(url)) return null
  // al massimo 2 minuti: un server che non risponde non blocca la pagina
  const r = await fetch(url, { signal: AbortSignal.timeout(120000), referrerPolicy: 'no-referrer', credentials: 'omit', headers: { Accept: 'text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.8, */*;q=0.1' } })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const text = await readCapped(r)
  if (text === null) throw new TooBig()
  return text
}
const indirizzoNonValido = () => setStatus('error', 'Indirizzo non valido: sono ammessi solo indirizzi http:// o https://')
function fetchError (url, e) {
  if (e instanceof TooBig) { setStatus('error', troppoGrande(MAX_BYTES + 1)); return }
  setStatus('error', '')
  // il link compare solo per indirizzi http/https gia' verificati: mai javascript:, data: ecc.
  $('#status').innerHTML = `<strong>Il browser non può leggere questo indirizzo.</strong> Quasi sempre è il server che non permette la lettura da altre pagine (CORS). ` +
    `Apri <a href="${esc(new URL(url).href)}" target="_blank" rel="noopener noreferrer">il file</a>, salvalo e caricalo nella scheda File. <span class="mono">(${esc(e.message)})</span>`
  syncAlert()
}

async function fetchUrl (url) {
  setStatus('busy', 'Scarico ' + url)
  try {
    const text = await fetchText(url)
    if (text === null) { indirizzoNonValido(); return }
    const name = url.split('/').pop() || url
    setSource({ kind: 'url', name, text, url })
    validate()
  } catch (e) {
    fetchError(url, e)
  }
}

// «Tutte le pagine»: scarica e valida le pagine una alla volta seguendo hydra:lastPage/nextPage
// del catalogo; ogni pagina si valida da sola (come EDP) e i risultati si uniscono alla fine.
let stopRequested = false
async function fetchAllPages () {
  if (running) return
  const sel = selectedProfiles()
  if (!sel.length) { setStatus('error', 'Seleziona almeno un profilo.'); return }
  const first = ckanUrl(1)
  if (!isHttpUrl(first)) { indirizzoNonValido(); return }
  running = true
  stopRequested = false
  const t0 = performance.now()
  const pages = []
  const ipaCache = new Map()
  let last = null
  let total = null
  let bytes = 0
  let fmt = ''
  let stopped = ''
  try {
    const profiles = await getProfiles()
    for (let n = 1; n <= MAX_PAGES; n++) {
      if (stopRequested) { stopped = 'interrotta'; break }
      const url = ckanUrl(n)
      const di = last ? ` di ${last}` : ''
      const fatti = pages.length ? ` · ${pages.reduce((a, p) => a + p.stats.datasets, 0).toLocaleString('it-IT')} dataset finora` : ''
      setStatus('busy', `Pagina ${n}${di}: scarico…${fatti}`, true)
      let text
      try {
        text = await fetchText(url)
      } catch (e) {
        if (!pages.length) { fetchError(url, e); return }
        stopped = `pagina ${n} non scaricata (${e instanceof TooBig ? 'troppo grande' : e.message})`
        break
      }
      bytes += text.length
      setStatus('busy', `Pagina ${n}${di}: valido…${fatti}`, true)
      await new Promise(r => setTimeout(r, 0))
      if ($('#fmt').value === 'auto') fmt = detectFormat(text, url.split('?')[0])
      else fmt = $('#fmt').value
      let ds
      try {
        ds = await datasetFromText(text, fmt)
      } catch (e) {
        throw new Error(`La pagina ${n} non è RDF valido (${fmtLabel(fmt)}): ${e.message}`)
      }
      text = null
      const st = stats(ds)
      const pg = pagingInfo(ds)
      if (n === 1) { last = pg.last; total = pg.total }
      // pagina vuota oltre la fine (portali senza hydra): ci si ferma senza contarla
      if (n > 1 && !st.datasets && !st.services) break
      const { results, meta } = await runValidation(ds, profiles, sel, { ipaCache })
      pages.push({ results, meta, stats: st, catalogs: catalogIris(ds) })
      const hasNext = last ? n < last : pg.next != null && pg.next > n
      if (!hasNext) break
      if (n === MAX_PAGES) stopped = `fermata al tetto di ${MAX_PAGES} pagine`
    }
    const merged = mergePages(pages)
    const ms = Math.round(performance.now() - t0)
    const base = $('#ckan-base').value.trim().replace(/\/+$/, '')
    const nome = `${base.replace(/^https?:\/\//, '')} · catalog.${$('#ckan-format').value} · ${pages.length} ${pages.length === 1 ? 'pagina' : 'pagine'}`
    setSource({ kind: 'ckan-tutte', name: nome, text: '' })
    $('#src-size').textContent = fmtBytes(bytes)
    state.last = { results: merged.results, groups: groupResults(merged.results, Infinity), stats: merged.stats, meta: merged.meta, selected: sel, sourceName: nome, format: fmt, ms, at: new Date(),
      pages: { count: pages.length, last, total, duplicates: merged.duplicates, stopped } }
    if (!sel.includes(state.filterProfile)) state.filterProfile = 'tutti'
    const nota = stopped ? ` · ${stopped}` : ''
    setStatus(stopped ? 'error' : 'done', `Validate ${pages.length}${last ? ' di ' + last : ''} pagine in ${(ms / 1000).toFixed(1)} s${nota}`)
    render()
  } catch (e) {
    $('#results').hidden = true
    state.last = null
    setStatus('error', e.message)
  } finally {
    running = false
    $('#run').disabled = false
  }
}

// ------------------------------------------------------------ validazione
function selectedProfiles () {
  return ORDER.filter(k => document.getElementById('p-' + k).checked)
}
// stoppable: aggiunge il bottone «Interrompi» (validazione di tutte le pagine)
// copia l'errore in cima alla pagina: chi usa «Scarica e valida» in fondo al pannello
// potrebbe non vedere la riga di stato
function syncAlert () {
  const st = $('#status'), top = $('#alert-top')
  if (st.dataset.kind === 'error' && st.textContent.trim()) {
    $('#alert-text').innerHTML = st.innerHTML   // contenuto gia' costruito con esc()
    top.hidden = false
    top.scrollIntoView({ block: 'start', behavior: 'smooth' })
  } else top.hidden = true
}
function setStatus (kind, text, stoppable = false) {
  const el = $('#status')
  el.dataset.kind = kind
  el.textContent = text
  syncAlert()
  if (kind === 'busy') {
    el.insertAdjacentHTML('afterbegin', '<span class="spin" aria-hidden="true"></span>')
    if (stoppable) el.insertAdjacentHTML('beforeend', stopRequested ? ' <span class="muted">· mi fermo dopo questa pagina</span>' : ' <button class="btn small" type="button" id="stop">Interrompi</button>')
    $('#busy-text').textContent = text
  }
  busy(kind === 'busy')
}
// durante download ed elaborazione: bottone bloccato con la rotella, esito precedente attenuato
function busy (on) {
  const wrap = document.querySelector('.wrap')
  if (on) {
    wrap.dataset.busy = '1'
    wrap.setAttribute('aria-busy', 'true')
  } else {
    delete wrap.dataset.busy
    wrap.removeAttribute('aria-busy')
  }
  // i tre bottoni che avviano il lavoro: bloccati e con la rotella
  for (const [id, label] of [['run', 'Valida'], ['url-go', 'Scarica e valida'], ['ckan-go', 'Scarica e valida']]) {
    const b = $('#' + id)
    b.disabled = on
    if (on) b.innerHTML = '<span class="spin" aria-hidden="true"></span>Attendi…'
    else b.textContent = label
  }
}

let running = false
async function validate () {
  if (running) return
  const src = state.source
  if (src.kind === 'ckan-tutte') return fetchAllPages()
  if (!src.text || !src.text.trim()) { setStatus('error', 'Nessun contenuto da validare.'); return }
  const sel = selectedProfiles()
  if (!sel.length) { setStatus('error', 'Seleziona almeno un profilo.'); return }
  running = true
  $('#run').disabled = true
  setStatus('busy', 'Leggo il file…')
  await new Promise(r => setTimeout(r, 30))
  const t0 = performance.now()
  try {
    const fmt = $('#fmt').value === 'auto' ? detectFormat(src.text, src.name) : $('#fmt').value
    let ds
    try {
      ds = await datasetFromText(src.text, fmt)
    } catch (e) {
      throw new Error(`Il file non è RDF valido (${fmtLabel(fmt)}): ${e.message}`)
    }
    const st = stats(ds)
    setStatus('busy', `Valido ${st.triples.toLocaleString('it-IT')} triple…`)
    await new Promise(r => setTimeout(r, 30))
    const profiles = await getProfiles()
    const { results, meta } = await runValidation(ds, profiles, sel)
    const ms = Math.round(performance.now() - t0)
    state.last = { results, groups: groupResults(results, Infinity), stats: st, meta, selected: sel, sourceName: src.name, format: fmt, ms, at: new Date() }
    // il filtro per profilo non sopravvive se quel profilo non e' piu' selezionato
    if (!sel.includes(state.filterProfile)) state.filterProfile = 'tutti'
    setStatus('done', `Validato in ${(ms / 1000).toFixed(1)} s`)
    render()
  } catch (e) {
    // niente esito vecchio accanto a un errore: si nasconde il pannello dei risultati
    $('#results').hidden = true
    state.last = null
    setStatus('error', e.message)
  } finally {
    running = false
    $('#run').disabled = false
  }
}
const fmtLabel = f => ({ turtle: 'Turtle', rdfxml: 'RDF/XML', jsonld: 'JSON-LD', ntriples: 'N-Triples' }[f] || f)

// ------------------------------------------------------------ rendering
function countBy (results, profile) {
  const c = { Violation: 0, Warning: 0, Info: 0 }
  for (const r of results) if (!profile || r.profile === profile) c[r.severity] = (c[r.severity] || 0) + 1
  return c
}

function render () {
  const L = state.last
  if (!L) return
  $('#results').hidden = false
  const tot = countBy(L.results)
  const ok = tot.Violation === 0
  $('#verdict').dataset.ok = ok
  // conforme = nessuna violazione; gli avvisi non cambiano l'esito
  $('#verdict-text').textContent = ok ? 'Conforme' : 'Non conforme'
  const avvisi = tot.Warning ? ` · ${tot.Warning.toLocaleString('it-IT')} avvisi` : ''
  const indic = tot.Info ? ` · ${tot.Info.toLocaleString('it-IT')} indicazioni AgID` : ''
  const P = L.pages
  const dup = P && P.duplicates ? ` · ${P.duplicates.toLocaleString('it-IT')} segnalazioni ripetute fra le pagine contate una volta` : ''
  const parz = P && P.stopped ? ` · validazione parziale: ${P.stopped}` : ''
  $('#verdict-sub').textContent = `${L.sourceName} · ${fmtLabel(L.format)} · ${L.stats.triples.toLocaleString('it-IT')} triple${avvisi}${indic}${dup}${parz}`

  const st = L.stats
  const hvdM = L.meta.hvd
  $('#counts').innerHTML = [
    ['Cataloghi', st.catalogs], ['Dataset', st.datasets], ['Distribuzioni', st.distributions], ['Servizi', st.services],
    ...(hvdM ? [['Dataset HVD', hvdM.datasets]] : []),
  ].map(([k, v]) => `<div class="kv"><dt>${k}</dt><dd>${v.toLocaleString('it-IT')}</dd></div>`).join('')

  $('#profiles-sum').innerHTML = L.selected.map(p => {
    const c = countBy(L.results, p)
    const skipped = p === 'hvd' && hvdM && !hvdM.datasets && !hvdM.services
    const pass = p === 'agid' ? (c.Info ? 'hint' : 'true') : String(c.Violation === 0)
    const ipa = L.meta.ipa
    const ipaNote = !ipa ? '' : ipa.error
      ? `<span class="pnote">IndicePA non raggiungibile: codici IPA non verificati</span>`
      : ipa.checked ? `<span class="pnote">IndicePA: ${ipa.checked} codici verificati, ${ipa.notFound} non trovati</span>` : ''
    const conta = p === 'agid'
      ? `<span class="pcount"><b class="i">${c.Info}</b> indicazioni</span>${ipaNote}`
      : `<span class="pcount"><b class="v">${c.Violation}</b> violazioni · <b class="w">${c.Warning}</b> avvisi</span>`
    return `<button class="psum" data-profile="${p}" aria-pressed="${state.filterProfile === p}" data-pass="${pass}">
      <span class="pname">${PROFILE_LABELS[p]}</span>
      ${skipped ? '<span class="pnote">nessuna risorsa HVD</span>' : conta}
    </button>`
  }).join('')

  renderTable()
}

function renderTable () {
  const L = state.last
  const q = state.query.toLowerCase()
  const rows = L.groups.filter(g =>
    state.filterSev.has(g.severity) &&
    (state.filterProfile === 'tutti' || g.profile === state.filterProfile) &&
    (!q || (g.path + ' ' + g.message + ' ' + g.examples.map(e => e.focus + ' ' + e.value).join(' ')).toLowerCase().includes(q)))
  $('#rows-count').textContent = rows.length === L.groups.length ? `${rows.length} regole` : `${rows.length} di ${L.groups.length} regole`
  if (!rows.length) {
    const nascosti = !state.filterSev.has('Warning') && L.groups.some(g => g.severity === 'Warning')
    const msg = !L.groups.length ? 'Nessuna segnalazione: il file rispetta tutti i profili scelti.'
      : nascosti && !L.groups.some(g => g.severity === 'Violation') ? 'Nessuna violazione. Gli avvisi sono nascosti: attiva «Avvisi» per vederli.'
      : 'Nessuna segnalazione con questi filtri.'
    $('#rows').innerHTML = `<p class="empty">${msg}</p>`
    return
  }
  state.visible = rows
  $('#rows').innerHTML = rows.map((g, i) => `
    <details class="row" data-sev="${g.severity}" data-i="${i}"${atteso(g) ? ' data-atteso' : ''}>
      <summary>
        <span class="sev">${atteso(g) ? 'Avviso atteso' : sevLabel(g.severity)}</span>
        <span class="msg">${atteso(g) ? `<b>${esc(ATTESI[atteso(g)].titolo)}</b> · ` : ''}${esc(g.message)}</span>
        <span class="meta"><span class="tag">${PROFILE_LABELS[g.profile]}</span>${g.path ? `<code>${esc(g.path)}</code>` : ''}</span>
        <span class="n" title="${g.nodes} risorse coinvolte">${g.count.toLocaleString('it-IT')}</span>
      </summary>
      <div class="ex">
        <p class="exh">${g.nodes.toLocaleString('it-IT')} risorse coinvolte${g.component ? ` · vincolo <code>${esc(g.component)}</code>` : ''}${g.original && g.original !== g.message ? ` · messaggio originale: <code>${esc(g.original)}</code>` : ''}.</p>
        ${atteso(g) ? ATTESI[atteso(g)].nota : ''}
        <table><thead><tr><th>Risorsa</th><th>Valore</th></tr></thead><tbody>${exampleRows(g, 0, FIRST)}</tbody></table>
        ${moreBar(g, Math.min(FIRST, g.examples.length))}
      </div>
    </details>`).join('')
}
// righe di esempio: le prime FIRST subito, poi a blocchi di STEP
const FIRST = 10
const STEP = 200
function exampleRows (g, from, to) {
  return g.examples.slice(from, to).map(e => `<tr><td>${focusCell(e)}</td><td>${e.value ? linkish(e.value) : '<span class="muted">assente</span>'}</td></tr>`).join('')
}
// nodo anonimo: si mostra chi lo contiene, es. "dct:publisher di <https://...>"
function focusCell (e) {
  if (!e.where) return linkish(e.focus)
  const owner = e.where.owner ? ' ' + linkish(e.where.owner) : ''
  return `<span class="mono">${esc(e.where.path)}</span> di${owner} <span class="muted mono">(${esc(e.focus)})</span>`
}
function moreBar (g, shown) {
  const rest = g.examples.length - shown
  if (rest <= 0) return ''
  const next = Math.min(STEP, rest)
  return `<div class="more" data-shown="${shown}">
    <span class="muted">Mostrate ${shown.toLocaleString('it-IT')} di ${g.examples.length.toLocaleString('it-IT')}</span>
    <button class="btn small" type="button" data-more="${next}">Mostra altre ${next.toLocaleString('it-IT')}</button>
    ${rest > next ? `<button class="btn small" type="button" data-more="all">Mostra tutte</button>` : ''}
  </div>`
}
function showMore (btn) {
  const det = btn.closest('details.row'); const bar = btn.closest('.more')
  const g = state.visible[+det.dataset.i]
  const shown = +bar.dataset.shown
  const to = btn.dataset.more === 'all' ? g.examples.length : shown + (+btn.dataset.more)
  det.querySelector('tbody').insertAdjacentHTML('beforeend', exampleRows(g, shown, to))
  bar.outerHTML = moreBar(g, to)
}

// avviso noto della regola piveau StatusRestrictionADMS (SEMICeu/DCAT-AP#490): resta un Warning,
// ma si mostra come atteso finche' data.europa.eu non corregge la regola
const atteso = g => (g.severity === 'Warning' && (g.atteso || (/StatusRestrictionADMS/.test(g.original || '') ? 'stato' : ''))) || ''
const ATTESO_NOTA_STATO = '<p class="exh">Le regole di data.europa.eu (piveau) contengono due vincoli incompatibili sullo stato: ' +
  'il profilo usato per la validazione chiede il vocabolario ADMS, mentre DCAT-AP 3 prevede distribution-status. ' +
  'Segnalato in <a href="https://gitlab.com/piveau/community/issues/-/work_items/124" target="_blank" rel="noopener noreferrer">piveau #124</a> ' +
  'e in <a href="https://github.com/SEMICeu/DCAT-AP/issues/490" target="_blank" rel="noopener noreferrer">SEMICeu/DCAT-AP#490</a>; non richiede correzioni.</p>'
const ATTESI = {
  stato: { titolo: 'Avviso in fase di verifica con il portale europeo', nota: ATTESO_NOTA_STATO },
  sottocataloghi: {
    titolo: 'Catalogo federato',
    nota: '<p class="exh">La regola raccomandata di data.europa.eu chiede che ogni catalogo elenchi direttamente almeno un dataset (<code>dcat:dataset</code>) ' +
      'o un servizio (<code>dcat:service</code>). In un catalogo federato il catalogo radice elenca invece i sottocataloghi (<code>dct:hasPart</code>), ' +
      'che contengono i dataset: è la struttura prevista da DCAT-AP_IT per i portali che raccolgono più enti, quindi l\'avviso è atteso e non richiede correzioni.</p>',
  },
}
const sevLabel = s => ({ Violation: 'Violazione', Warning: 'Avviso', Info: 'Indicazione' }[s] || s)
function linkish (v) {
  if (/^https?:\/\//.test(v) && isHttpUrl(v)) return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer" class="mono">${esc(v)}</a>`
  return `<span class="mono">${esc(v)}</span>`
}

// ------------------------------------------------------------ esportazione
function reportJson () {
  const L = state.last
  return JSON.stringify({
    strumento: 'Validatore DCAT-AP_IT',
    file: L.sourceName, formato: L.format, generato: L.at.toISOString(),
    profili: L.selected.map(p => PROFILE_LABELS[p]),
    conforme: countBy(L.results).Violation === 0,
    conteggi: L.stats, hvd: L.meta.hvd || null, indicepa: L.meta.ipa || null,
    pagine: L.pages ? { validate: L.pages.count, ultima: L.pages.last, dataset_dichiarati: L.pages.total, ripetute_fuse: L.pages.duplicates, interruzione: L.pages.stopped || null } : null,
    totali: Object.fromEntries(L.selected.map(p => [PROFILE_LABELS[p], countBy(L.results, p)])),
    risultati: L.results,
  }, null, 2)
}
function reportCsv () {
  const L = state.last
  // valori che iniziano con = + - @ diventerebbero formule in Excel/LibreOffice: si antepone '
  const q = v => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"' }
  const head = ['profilo', 'gravita', 'proprieta', 'messaggio', 'vincolo', 'risorsa', 'contenuta_in', 'valore']
  return [head.join(','), ...L.results.map(r => [PROFILE_LABELS[r.profile], r.severity, r.path, r.message, r.component, r.focus, r.where ? (r.where.path + ' di ' + r.where.owner).trim() : '', r.value].map(q).join(','))].join('\n')
}
let downloadsP = null
async function save (kind) {
  if (!state.last) return
  const base = (state.last.pages ? state.last.sourceName.split(' · ')[0].replace(/[^\w.-]+/g, '_') + '-catalogo' : state.last.sourceName.replace(/\.[^.]+$/, '')) + '-validazione'
  const data = kind === 'json' ? reportJson() : reportCsv()
  const filename = base + '.' + kind
  if (!window.claude?.use) {
    // pagina ospitata normalmente (es. GitHub Pages): download diretto
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([data], { type: kind === 'json' ? 'application/json' : 'text/csv' }))
    a.download = filename
    document.body.append(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    return
  }
  downloadsP ||= window.claude.use('downloads')
  const dl = await downloadsP
  if (dl) {
    try { await dl.save({ filename, data }); toast('Report salvato'); return } catch (e) { /* rifiutato: si ripiega sulla copia */ }
  }
  try { await navigator.clipboard.writeText(data); toast('Report copiato negli appunti') } catch { toast('Salvataggio non disponibile qui') }
}
function toast (t) {
  const el = $('#toast'); el.textContent = t; el.hidden = false
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true }, 2400)
}

// ------------------------------------------------------------ eventi
function init () {
  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab))
  $('#alert-close').addEventListener('click', () => { $('#alert-top').hidden = true })
  const fi = $('#file')
  fi.addEventListener('change', () => fi.files[0] && readFile(fi.files[0]))
  const drop = $('#drop')
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.dataset.over = '1' })
  drop.addEventListener('dragleave', () => { delete drop.dataset.over })
  drop.addEventListener('drop', e => { e.preventDefault(); delete drop.dataset.over; const f = e.dataTransfer.files[0]; if (f) readFile(f) })
  // il testo incollato diventa subito la sorgente: "Valida" lo usa senza altri passaggi
  const usePaste = () => {
    const t = $('#paste').value
    if (t.length > MAX_BYTES) { setStatus('error', troppoGrande(t.length)); return false }
    if (t.trim()) setSource({ kind: 'incolla', name: 'testo incollato', text: t })
    return true
  }
  $('#paste').addEventListener('input', usePaste)
  for (const id of ['ckan-base', 'ckan-page', 'ckan-name', 'ckan-fq', 'ckan-format', 'ckan-all']) $('#' + id).addEventListener('input', refreshCkanPreview)
  $('#ckan-all').addEventListener('change', refreshCkanPreview)
  const goCkan = () => {
    const u = ckanUrl(); if (!u) { setStatus('error', "Indica l'indirizzo base del portale CKAN."); return }
    return allPages() ? fetchAllPages() : fetchUrl(u)
  }
  $('#ckan-go').addEventListener('click', goCkan)
  $('#status').addEventListener('click', e => {
    if (e.target.id !== 'stop') return
    stopRequested = true
    e.target.replaceWith(Object.assign(document.createElement('span'), { className: 'muted', textContent: '· mi fermo dopo questa pagina' }))
  })
  $('#url-go').addEventListener('click', () => { const u = $('#url').value.trim(); if (u) fetchUrl(u) })
  // "Valida" lavora sulla scheda aperta
  $('#run').addEventListener('click', () => {
    if (activeTab === 'incolla') {
      if (!$('#paste').value.trim()) { setStatus('error', 'Incolla prima il testo RDF nel riquadro.'); return }
      if (!usePaste()) return
    } else if (activeTab === 'ckan') {
      return goCkan()
    } else if (activeTab === 'url') {
      const u = $('#url').value.trim(); if (!u) { setStatus('error', "Indica l'indirizzo del file RDF."); return }
      return fetchUrl(u)
    }
    validate()
  })
  $('#load-example').addEventListener('click', () => { setSource({ kind: 'esempio', name: 'esempio-errori.ttl', text: esempio }); validate() })
  $('#profiles-sum').addEventListener('click', e => {
    const b = e.target.closest('.psum'); if (!b) return
    state.filterProfile = state.filterProfile === b.dataset.profile ? 'tutti' : b.dataset.profile
    render()
  })
  for (const c of document.querySelectorAll('[data-sevfilter]')) c.addEventListener('change', () => {
    c.checked ? state.filterSev.add(c.dataset.sevfilter) : state.filterSev.delete(c.dataset.sevfilter)
    state.last && renderTable()
  })
  $('#rows').addEventListener('click', e => { const b = e.target.closest('[data-more]'); if (b) showMore(b) })
  $('#q').addEventListener('input', e => { state.query = e.target.value; state.last && renderTable() })
  $('#exp-json').addEventListener('click', () => save('json'))
  $('#exp-csv').addEventListener('click', () => save('csv'))
  $('#expand').addEventListener('click', () => {
    const all = [...document.querySelectorAll('#rows details')]
    const open = all.some(d => !d.open)
    all.forEach(d => { d.open = open })
  })
  refreshCkanPreview()
  setSource(state.source)
  validate()
}
init()
