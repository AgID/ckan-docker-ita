// Genera dist/index.html: un'unica pagina autonoma (motore, shape e interfaccia inclusi).
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const r = await build({
  entryPoints: ['src/app.js'], bundle: true, minify: true, format: 'iife', platform: 'browser',
  loader: { '.ttl': 'text' }, write: false, legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
})
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
const body = readFileSync('src/template.html', 'utf8').replace('/*__BUNDLE__*/', () => js)

// Versione per un normale sito statico (GitHub Pages): documento completo.
const page = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<!-- Sicurezza: niente script, frame o form esterni; le uniche richieste sono i font e i cataloghi da validare. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src https: http:; img-src data:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'">
<meta name="referrer" content="no-referrer">
<style>body{margin:0}</style>
</head>
<body>
${body}
</body>
</html>
`
mkdirSync('dist', { recursive: true })
writeFileSync('dist/index.html', page)
// Versione frammento, per ambienti che aggiungono da se' l'involucro del documento.
// Senza il titolo <h1>: la pagina che lo ospita (es. Drupal di dati.gov.it) ha gia' il suo.
writeFileSync('dist/frammento.html', body.replace(/\s*<h1>[^<]*<\/h1>/, ''))
console.log('dist/index.html', (page.length / 1024).toFixed(0), 'KB')
