// Validazione da riga di comando con lo stesso motore della pagina.
// Uso: node test/run.mjs FILE [profili]   (profili: edp,edpRecommended,dcatapit,vocabolari,hvd)
import { readFileSync } from 'node:fs'
import { buildProfiles, datasetFromText, detectFormat, runValidation, groupResults, stats } from '../src/engine.js'

const S = new URL('../../shapes/', import.meta.url)
const r = f => readFileSync(new URL(f, S), 'utf8')
const profiles = await buildProfiles({
  edp: r('edp/shapes.ttl'), edpDeprecated: r('edp/deprecateduris.ttl'), edpRecommended: r('edp/shapes_recommended.ttl'),
  dcatapit: r('dcatapit.ttl'), vocabolari: r('vocabolari.ttl'), hvd: r('hvd.ttl'), agid: r('agid.ttl'),
})
const file = process.argv[2]
if (!file) { console.error('Uso: node test/run.mjs FILE [profili]'); process.exit(2) }
const sel = (process.argv[3] || 'edp,dcatapit,vocabolari,hvd,agid').split(',')
const text = readFileSync(file, 'utf8')
const ds = await datasetFromText(text, detectFormat(text, file))
const { results, meta } = await runValidation(ds, profiles, sel)
console.log(JSON.stringify(stats(ds)), JSON.stringify(meta))
const tot = {}
for (const x of results) { const k = x.profile + ' ' + x.severity; tot[k] = (tot[k] || 0) + 1 }
console.log(JSON.stringify(tot))
for (const g of groupResults(results, 1)) console.log(`${g.profile.padEnd(14)} ${g.severity.padEnd(9)} ${String(g.count).padStart(5)}  ${g.path || '-'}  ${g.message}`)
process.exit(results.some(x => x.severity === 'Violation') ? 1 : 0)
