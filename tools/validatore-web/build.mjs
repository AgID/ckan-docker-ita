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
writeFileSync('dist/frammento.html', body)
console.log('dist/index.html', (page.length / 1024).toFixed(0), 'KB')
