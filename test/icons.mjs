// The six pickup icons, rendered face-on and measured as silhouettes.
//
// Puzz reported "a yellow box on my screen when shooting". Yellow is hue 55 —
// Scattershot — and the icon that was supposed to be three shells was drawing
// as a solid rectangle. Nothing structural could have caught that: the mesh
// existed, was visible, was the right colour, and was in the right place. Only
// the pixels were wrong.
//
// So this renders each icon alone, face-on, in an orthographic camera, and
// measures the fraction of its bounding box that is lit. Every one of the six
// is a shape with gaps in it — a cross, a bolt, a shield, two chevrons, three
// diamonds, a down-arrow — so every one of them must come in under a full box.
//
// Run: node test/icons.mjs
import { build } from 'esbuild'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) {
  console.error('No Chrome found. Set CHROME_PATH.')
  process.exit(2)
}

mkdirSync('.scratch/icons', { recursive: true })
await build({
  entryPoints: ['test/icons-entry.ts'],
  bundle: true,
  format: 'esm',
  outfile: '.scratch/icons/icons.js',
  logLevel: 'silent',
})
writeFileSync(
  '.scratch/icons/index.html',
  '<!doctype html><meta charset=utf-8><body><script type=module src="./icons.js"></script>',
)

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--allow-file-access-from-files'],
})
let failures = 0
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 260 })
  page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failures++ })
  await page.goto(`file://${process.cwd()}/.scratch/icons/index.html`)
  await page.waitForFunction(() => typeof window.__iconFill === 'function', { timeout: 20_000 })
  const fill = await page.evaluate(() => window.__iconFill())
  await page.screenshot({ path: '.scratch/icons/icons.png' })

  // A filled rectangle is 1.0. The loosest real silhouette here is the shield,
  // a hexagon at about 0.82 of its box; everything else is well under. 0.92
  // fails a collapsed icon without being a hair-trigger on the shield.
  const CEILING = 0.92
  for (const [kind, frac] of Object.entries(fill)) {
    const ok = frac > 0.05 && frac < CEILING
    if (!ok) failures++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${kind.padEnd(8)} fills ${(frac * 100).toFixed(1)}% of its box`)
  }
  console.log('  wrote .scratch/icons/icons.png')
} finally {
  await browser.close()
  rmSync('.scratch/icons/icons.js', { force: true })
}
process.exit(failures ? 1 : 0)
