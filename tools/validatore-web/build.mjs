// Genera dist/index.html: un'unica pagina autonoma (motore, shape e interfaccia inclusi).
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const r = await build({
  entryPoints: ['src/app.js'], bundle: true, minify: true, format: 'iife', platform: 'browser',
  loader: { '.ttl': 'text' }, write: false, legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
})
// Caratteri di controllo come escape \uXXXX: alcuni sistemi di upload (es. Drupal) li tolgono,
// cambiando lo script e invalidando l'hash della CSP. Nel bundle stanno solo in letterali stringa.
const js = r.outputFiles[0].text
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  .replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
const body = readFileSync('src/template.html', 'utf8').replace('/*__BUNDLE__*/', () => js)

// Versione per un normale sito statico (GitHub Pages): documento completo.
const page = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<!-- Sicurezza: niente script, frame o form esterni; le uniche richieste sono i font e i cataloghi da validare.
     Script e stili inline sono ammessi solo tramite hash, calcolati da build.mjs. -->
<meta http-equiv="Content-Security-Policy" content="__CSP__">
<meta name="referrer" content="no-referrer">
<style>body{margin:0}</style>
</head>
<body>
${body}
</body>
</html>
`
// CSP con gli hash sha256 di ogni <script> e <style> inline e degli attributi style="".
// Va ricalcolata a ogni build: basta un byte diverso nello script per invalidarla.
const h = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`
const tutti = (re, s) => [...s.matchAll(re)].map((m) => m[1])
function conCsp (html) {
  const script = [...new Set(tutti(/<script>([\s\S]*?)<\/script>/g, html).map(h))]
  const style = [...new Set(tutti(/<style>([\s\S]*?)<\/style>/g, html).map(h))]
  const attr = [...new Set(tutti(/<[a-zA-Z][^>]*\sstyle="([^"]*)"/g, html.replace(/<script>[\s\S]*?<\/script>/g, '')).map(h))]
  const csp = [
    "default-src 'none'",
    `script-src ${script.join(' ')}`,
    `style-src ${style.join(' ')} https://fonts.googleapis.com`,
    ...(attr.length ? [`style-src-attr 'unsafe-hashes' ${attr.join(' ')}`] : []),
    'font-src https://fonts.gstatic.com', 'img-src data:', 'connect-src https:',
    "base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-src 'none'",
    "child-src 'none'", "worker-src 'none'", "manifest-src 'none'",
  ].join('; ')
  return html.replace('__CSP__', csp)
}

mkdirSync('dist', { recursive: true })
writeFileSync('dist/index.html', conCsp(page))
// Versione per un <iframe> dentro un'altra pagina (es. Drupal di dati.gov.it): documento completo,
// quindi con charset UTF-8, CSP e referrer propri, ma senza il titolo <h1> che la pagina ospite ha gia'.
// Il charset nel file serve: se il server non lo dichiara, senza <meta charset> le lettere accentate
// verrebbero lette come windows-1252 ("ProprietÃ ").
writeFileSync('dist/incorporato.html', conCsp(page.replace(/\s*<h1>[^<]*<\/h1>/, '')))
// Versione frammento, per ambienti che aggiungono da se' l'involucro del documento.
// Senza il titolo <h1>: la pagina che lo ospita (es. Drupal di dati.gov.it) ha gia' il suo.
writeFileSync('dist/frammento.html', body.replace(/\s*<h1>[^<]*<\/h1>/, ''))
console.log('dist/index.html', (page.length / 1024).toFixed(0), 'KB')
