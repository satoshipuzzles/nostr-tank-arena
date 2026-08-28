// The moon's lob, fired by the real game rather than by arithmetic.
//
// `test/moonmirror.mjs` proves `lobRange` doubles when gravity is half. That
// is the rule; this is the plumbing, and the two fail independently. A
// `lobRange` that no call site uses leaves every arithmetic check green with
// the mortar still throwing 620 units — the same shape as the coolant tower's
// multiplier never reaching `Game.blast`, and as the kill cam's frame gate.
//
// So: pin Moon Base, charge a lob to full through the field the game itself
// charges, let the real update loop release it, and read the range off the
// shell that comes out. Then the same on an ordinary board, which is the
// control — if both come out long, the board is not what decided it.
//
//   npm run build && npx vite preview --port 4341 &
//   node test/moonlob.mjs

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4341/'
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

const browser = await puppeteer.launch({
  executablePath, headless: 'new',
  args: ['--no-sandbox', '--window-size=1280,800', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--mute-audio',
    '--disable-background-timer-throttling'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await page.goto(`${URL_}?room=moon${Math.floor(Math.random() * 1e6)}`)
  await page.type('#name', 'moon')
  await page.click('#play-guest')
  await page.waitForFunction(() => !!window.__game && !!window.__arena, { timeout: 20_000 })

  // Charge a lob to full and let the game's own update release it. Setting
  // `lobFrom` back in time is exactly what holding the key for the full charge
  // window does; the release, the range and the fire all stay on the real path.
  // Pin the board through the block clock, not with a bare `setLayout`.
  //
  // The first version called `setLayout` directly and passed locally and
  // failed on the deployed URL, with the shell at 620 and the aiming ring at
  // 1240 — which reads exactly like the fix not being in the bundle. It was:
  // the live chain tip arrives on the deployed site and calls `setLayout`
  // straight back to whatever board the real block picks, so the lob was fired
  // on Crossroads a moment after the test asked for the moon. A height above
  // the real tip is ignored by nothing and ignores everything, which is the
  // only way to hold a board still while the chain is running.
  let height = 999_000
  const pin = async (name) => {
    height += 1
    const got = await page.evaluate(({ board, h }) => {
      const a = window.__arena
      const i = a.LAYOUTS.findIndex((l) => l.name === board)
      // Any byte congruent to the index. The index itself is, for any
      // rotation with more boards than this one has.
      const suffix = '03' + i.toString(16).padStart(2, '0')
      window.__clock.accept({ height: h, hash: 'ab'.repeat(30) + suffix, time: Math.floor(Date.now() / 1000) - 30 })
      return i
    }, { board: name, h: height })
    // Poll for the board itself rather than sleeping: a round transition takes
    // as long as it takes, and the name is the exact thing being waited on.
    await page.waitForFunction(
      (board) => window.__arena.layoutName === board,
      { timeout: 25_000, polling: 100 },
      name,
    )
    return got
  }

  const throwOne = async (name) => {
    await pin(name)
    await page.evaluate(() => {
      const g = window.__game
      g.shells.clear()
      g.tank.dead = false
      g.tank.hp = 3
      g.tank.x = 300
      g.tank.y = 300
      g.tank.gun = 0
      g.tank.mag = 4
      g.tank.reloadUntil = 0
      g.tank.nextShotAt = 0
      // Charging to full is exactly what holding the key for the charge window
      // does; the release, the range and the fire all stay on the real path.
      g.lobFrom = performance.now() - 2000
    })
    const got = await page.waitForFunction(() => {
      const g = window.__game
      for (const s of g.shells.values()) {
        // The board this shell was actually fired on, read at the same moment
        // as its range. Without it a chain-driven board change between the two
        // reads is invisible and the number is attributed to the wrong map.
        if (s.lob > 0) return { lob: s.lob, board: window.__arena.layoutName }
      }
      return null
    }, { timeout: 15_000, polling: 50 }).then((h) => h.jsonValue()).catch(() => null)
    return got
  }

  const moon = await throwOne('Moon Base')
  check('a lob comes out on Moon Base', moon?.board === 'Moon Base', JSON.stringify(moon))
  const earth = await throwOne('Crossroads')
  check('and one on Crossroads', earth?.board === 'Crossroads', JSON.stringify(earth))

  check(
    'the moon throws about twice as far, fired by the game itself',
    !!moon && !!earth && moon.lob > earth.lob * 1.9,
    `${Math.round(moon?.lob ?? 0)} against ${Math.round(earth?.lob ?? 0)}`,
  )
  // The control on the other side: the ordinary board still throws exactly
  // what it always did, so this is a moon rule and not a lob buff.
  check(
    'the control — an ordinary board still throws its 620',
    !!earth && Math.abs(earth.lob - 620) < 1,
    `${Math.round(earth?.lob ?? 0)}`,
  )
  // And the reticle agrees with the shell. A mortar that lands twice as far as
  // the ring you aimed with is worse than one that does not travel at all.
  await pin('Moon Base')
  const aim = await page.evaluate(() => {
    const g = window.__game
    g.tank.dead = false
    g.tank.x = 300
    g.tank.y = 300
    g.tank.gun = 0
    g.lobFrom = performance.now() - 2000
    const r = g.lobAim
    g.lobFrom = 0
    return r ? Math.round(r.x - g.tank.x) : null
  })
  check(
    'and the aiming ring is drawn at the range the shell will fly',
    aim !== null && !!moon && Math.abs(aim - moon.lob) < 2,
    `ring ${aim} against shell ${Math.round(moon?.lob ?? 0)}`,
  )
} finally {
  await browser.close()
}

console.log('')
if (failures) { console.error(`${failures} failed`); process.exit(1) }
console.log('all good')
