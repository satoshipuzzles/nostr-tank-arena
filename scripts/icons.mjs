// Render the app icons from one SVG, so there is one place to change the mark.
//
//   node scripts/icons.mjs
//
// Committed output rather than a build step: three PNGs that change twice a
// year do not need to cost every `vite build` a browser launch, and a manifest
// that points at files the repo does not contain is a manifest that fails
// install review on a phone with no error anybody sees.

import { existsSync, writeFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))
if (!CHROME) {
  console.error('No Chrome found. Set CHROME_PATH.')
  process.exit(2)
}

// `pad` is the fraction of the canvas left empty around the mark. A maskable
// icon is cropped to a circle by Android, so anything closer than ~10% to the
// edge is cut off; the plain icon is drawn as-is and can fill more of the tile.
const mark = (pad) => {
  const s = 512
  const inner = s * (1 - pad * 2)
  const o = s * pad
  const scale = inner / 32
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#141c2c"/>
        <stop offset="1" stop-color="#070a11"/>
      </linearGradient>
    </defs>
    <rect width="${s}" height="${s}" rx="${pad > 0.15 ? 0 : s * 0.22}" fill="url(#bg)"/>
    <g transform="translate(${o} ${o}) scale(${scale})">
      <rect x="2" y="21" width="28" height="5" rx="2.5" fill="#1e2838"/>
      <rect x="5" y="12" width="16" height="10" rx="2" fill="#ffc44d"/>
      <rect x="19" y="15" width="10" height="4" rx="1.5" fill="#ffc44d"/>
      <rect x="8" y="8" width="9" height="5" rx="2" fill="#ffd888"/>
      <circle cx="8.5" cy="24" r="3" fill="#8d97a8"/>
      <circle cx="15" cy="24" r="3" fill="#8d97a8"/>
      <circle cx="21.5" cy="24" r="3" fill="#8d97a8"/>
    </g>
  </svg>`
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()

for (const [file, size, pad] of [
  ['public/icon-192.png', 192, 0.12],
  ['public/icon-512.png', 512, 0.12],
  ['public/icon-maskable-512.png', 512, 0.22],
  ['public/icon-180.png', 180, 0.12],
]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
  await page.setContent(
    `<body style="margin:0">${mark(pad).replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body>`,
  )
  const buf = await page.screenshot({ omitBackground: false, type: 'png' })
  writeFileSync(file, buf)
  console.log(`${file}  ${size}x${size}`)
}

await browser.close()
