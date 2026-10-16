import { buildProfiles, datasetFromText, detectFormat, runValidation, groupResults, stats, PROFILE_LABELS } from './engine.js'
import edp from '../../shapes/edp/shapes.ttl'
import edpDeprecated from '../../shapes/edp/deprecateduris.ttl'
import edpRecommended from '../../shapes/edp/shapes_recommended.ttl'
import dcatapit from '../../shapes/dcatapit.ttl'
import vocabolari from '../../shapes/vocabolari.ttl'
import hvd from '../../shapes/hvd.ttl'
import esempio from '../test/esempio.ttl'

const SHAPES = { edp, edpDeprecated, edpRecommended, dcatapit, vocabolari, hvd }
const ORDER = ['edp', 'edpRecommended', 'dcatapit', 'vocabolari', 'hvd']
const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

let profilesP = null
const getProfiles = () => (profilesP ||= buildProfiles(SHAPES))

const state = {
  source: { kind: 'esempio', name: 'esempio-errori.ttl', text: esempio },
  last: null,          // { groups, results, stats, meta, selected, sourceName, ms }
  filterSev: new Set(['Violation', 'Warning', 'Info']),
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

async function readFile (file) {
  const text = await file.text()
  setSource({ kind: 'file', name: file.name, text })
  validate()
}

function ckanUrl () {
  const base = $('#ckan-base').value.trim().replace(/\/+$/, '')
  if (!base) return ''
  const fmt = $('#ckan-format').value
  const params = new URLSearchParams()
  const page = $('#ckan-page').value.trim()
  if (page && page !== '1') params.set('page', page)
  const name = $('#ckan-name').value.trim()
  const fq = $('#ckan-fq').value.trim()
  if (name) params.set('fq', 'name:' + name)
  else if (fq) params.set('fq', fq)
  const q = params.toString()
  return `${base}/catalog.${fmt}${q ? '?' + q : ''}`
}
function refreshCkanPreview () {
  const u = ckanUrl()
  $('#ckan-preview').textContent = u || 'https://…/catalog.ttl'
}

async function fetchUrl (url) {
  setStatus('busy', 'Scarico ' + url)
  try {
    const r = await fetch(url, { headers: { Accept: 'text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.8, */*;q=0.1' } })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const text = await r.text()
    const name = url.split('/').pop() || url
    setSource({ kind: 'url', name, text, url })
    validate()
  } catch (e) {
    setStatus('error', '')
    $('#status').innerHTML = `<strong>Il browser non può leggere questo indirizzo.</strong> Quasi sempre è il server che non permette la lettura da altre pagine (CORS); dati.gov.it è tra questi. ` +
      `Apri <a href="${esc(url)}" target="_blank" rel="noopener">il file</a>, salvalo e caricalo nella scheda File. <span class="mono">(${esc(e.message)})</span>`
  }
}

// ------------------------------------------------------------ validazione
function selectedProfiles () {
  return ORDER.filter(k => document.getElementById('p-' + k).checked)
}
function setStatus (kind, text) {
  const el = $('#status')
  el.dataset.kind = kind
  el.textContent = text
}

let running = false
async function validate () {
  if (running) return
  const src = state.source
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
    state.last = { results, groups: groupResults(results, 5), stats: st, meta, selected: sel, sourceName: src.name, format: fmt, ms, at: new Date() }
    setStatus('done', `Validato in ${(ms / 1000).toFixed(1)} s`)
    render()
  } catch (e) {
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
  $('#verdict-text').textContent = ok ? 'Conforme' : 'Non conforme'
  $('#verdict-sub').textContent = `${L.sourceName} · ${fmtLabel(L.format)} · ${L.stats.triples.toLocaleString('it-IT')} triple`

  const st = L.stats
  const hvdM = L.meta.hvd
  $('#counts').innerHTML = [
    ['Cataloghi', st.catalogs], ['Dataset', st.datasets], ['Distribuzioni', st.distributions], ['Servizi', st.services],
    ...(hvdM ? [['Dataset HVD', hvdM.datasets]] : []),
  ].map(([k, v]) => `<div class="kv"><dt>${k}</dt><dd>${v.toLocaleString('it-IT')}</dd></div>`).join('')

  $('#profiles-sum').innerHTML = L.selected.map(p => {
    const c = countBy(L.results, p)
    const skipped = p === 'hvd' && hvdM && !hvdM.datasets && !hvdM.services
    const pass = c.Violation === 0
    return `<button class="psum" data-profile="${p}" aria-pressed="${state.filterProfile === p}" data-pass="${pass}">
      <span class="pname">${PROFILE_LABELS[p]}</span>
      ${skipped ? '<span class="pnote">nessuna risorsa HVD</span>' : `<span class="pcount"><b class="v">${c.Violation}</b> violazioni · <b class="w">${c.Warning}</b> avvisi</span>`}
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
    $('#rows').innerHTML = `<p class="empty">${L.groups.length ? 'Nessuna segnalazione con questi filtri.' : 'Nessuna segnalazione: il file rispetta tutti i profili scelti.'}</p>`
    return
  }
  $('#rows').innerHTML = rows.map((g, i) => `
    <details class="row" data-sev="${g.severity}">
      <summary>
        <span class="sev">${sevLabel(g.severity)}</span>
        <span class="msg">${esc(g.message)}</span>
        <span class="meta"><span class="tag">${PROFILE_LABELS[g.profile]}</span>${g.path ? `<code>${esc(g.path)}</code>` : ''}</span>
        <span class="n" title="${g.nodes} risorse coinvolte">${g.count.toLocaleString('it-IT')}</span>
      </summary>
      <div class="ex">
        <p class="exh">${g.nodes.toLocaleString('it-IT')} risorse coinvolte${g.component ? ` · vincolo <code>${esc(g.component)}</code>` : ''}. Esempi:</p>
        <table><thead><tr><th>Risorsa</th><th>Valore</th></tr></thead><tbody>
        ${g.examples.map(e => `<tr><td>${linkish(e.focus)}</td><td>${e.value ? linkish(e.value) : '<span class="muted">assente</span>'}</td></tr>`).join('')}
        </tbody></table>
      </div>
    </details>`).join('')
}
const sevLabel = s => ({ Violation: 'Violazione', Warning: 'Avviso', Info: 'Info' }[s] || s)
function linkish (v) {
  if (/^https?:\/\//.test(v)) return `<a href="${esc(v)}" target="_blank" rel="noopener" class="mono">${esc(v)}</a>`
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
    conteggi: L.stats, hvd: L.meta.hvd || null,
    totali: Object.fromEntries(L.selected.map(p => [PROFILE_LABELS[p], countBy(L.results, p)])),
    risultati: L.results,
  }, null, 2)
}
function reportCsv () {
  const L = state.last
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"'
  const head = ['profilo', 'gravita', 'proprieta', 'messaggio', 'vincolo', 'risorsa', 'valore']
  return [head.join(','), ...L.results.map(r => [PROFILE_LABELS[r.profile], r.severity, r.path, r.message, r.component, r.focus, r.value].map(q).join(','))].join('\n')
}
let downloadsP = null
async function save (kind) {
  if (!state.last) return
  const base = state.last.sourceName.replace(/\.[^.]+$/, '') + '-validazione'
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
  const fi = $('#file')
  fi.addEventListener('change', () => fi.files[0] && readFile(fi.files[0]))
  const drop = $('#drop')
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.dataset.over = '1' })
  drop.addEventListener('dragleave', () => { delete drop.dataset.over })
  drop.addEventListener('drop', e => { e.preventDefault(); delete drop.dataset.over; const f = e.dataTransfer.files[0]; if (f) readFile(f) })
  // il testo incollato diventa subito la sorgente: "Valida" lo usa senza altri passaggi
  const usePaste = () => {
    const t = $('#paste').value
    if (t.trim()) setSource({ kind: 'incolla', name: 'testo incollato', text: t })
  }
  $('#paste').addEventListener('input', usePaste)
  for (const id of ['ckan-base', 'ckan-page', 'ckan-name', 'ckan-fq', 'ckan-format']) $('#' + id).addEventListener('input', refreshCkanPreview)
  $('#ckan-go').addEventListener('click', () => { const u = ckanUrl(); if (u) fetchUrl(u) })
  $('#url-go').addEventListener('click', () => { const u = $('#url').value.trim(); if (u) fetchUrl(u) })
  // "Valida" lavora sulla scheda aperta
  $('#run').addEventListener('click', () => {
    if (activeTab === 'incolla') {
      if (!$('#paste').value.trim()) { setStatus('error', 'Incolla prima il testo RDF nel riquadro.'); return }
      usePaste()
    } else if (activeTab === 'ckan') {
      const u = ckanUrl(); if (!u) { setStatus('error', "Indica l'indirizzo base del portale CKAN."); return }
      return fetchUrl(u)
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
