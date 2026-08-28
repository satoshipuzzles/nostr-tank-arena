// The coolant tower kills you, and the drums beside it do not.
//
// `test/boardshape.mjs` proves the arithmetic: a 260-unit tank farm gets a
// blast a bit over twice a lob's, and a tank in contact with it is inside that
// radius where at the old flat radius it would not have been. Arithmetic is
// not the game, though — the number has to reach `Game.blast`, and a
// multiplier computed in `arena.ts` and never passed through would leave every
// check in that file green with nothing changed on the board.
//
// So this is the same claim driven through the real thing: park at the tower's
// edge, shell it until it goes up, and read the hull. Then do it again at the
// same distance from an ordinary pair of drums on the same board, which is the
// control — if that one killed us too, the radius is not what did it.
//
//   npm run build && npx vite preview --port 4340 &
//   node test/tower.mjs

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4340/'
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
  await page.goto(`${URL_}?room=tower${Math.floor(Math.random() * 1e6)}`)
  await page.type('#name', 'tower')
  await page.click('#play-guest')
  await page.waitForFunction(() => !!window.__game && !!window.__arena, { timeout: 20_000 })

  // Pin the board. The map comes off the live chain otherwise, and a suite that
  // measures whichever arena the last block picked is measuring the chain.
  const board = await page.evaluate(() => {
    const a = window.__arena
    const i = a.LAYOUTS.findIndex((l) => l.name === 'The Reactor')
    a.setLayout(i)
    a.resetCover()
    return { i, name: a.layoutName }
  })
  check('the board is pinned to The Reactor', board.name === 'The Reactor', board.name)

  // Blow one up with our hull parked at its edge, and report what it cost.
  //
  // `hitCover` rather than a fired shell: the shot itself is not what is under
  // test and aiming one through a 260-unit obstacle at point-blank range is a
  // second thing to get wrong. The shell handed over is the one the simulation
  // would have built — struck, damage, owner — so everything downstream of the
  // impact is the real path.
  // Both rects shot with the tank at the *same absolute distance* from the
  // centre — the tower's contact distance, half its footprint plus a hull.
  // That is the discriminator and the reason there are two of them: 152 units
  // is inside a blast scaled by 2.36 and comfortably outside an unscaled one,
  // so the tower has to hurt and the drums have to not. Any other pair of
  // distances tests the geometry of the two rects instead of the multiplier.
  //
  // `hitCover` rather than a fired shell: the shot is not what is under test,
  // and aiming one through a 260-unit obstacle at point-blank range is a second
  // thing to get wrong. The shell handed over is the one the simulation would
  // have built — struck, damage, owner — so everything downstream of the impact
  // is the real path.
  const shoot = async (pick, dist) => await page.evaluate(({ which, at }) => {
    const a = window.__arena
    const g = window.__game
    a.resetCover()
    const barrels = a.BREAKABLE.filter((r) => r.kind === 'barrel')
    const rect = which === 'tower'
      ? barrels.find((r) => Math.min(r.w, r.h) >= 200)
      : barrels.find((r) => Math.min(r.w, r.h) < 200)
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2
    const gap = at ?? Math.min(rect.w, rect.h) / 2 + 22
    g.tank.dead = false
    g.tank.hp = 3
    g.tank.x = cx - gap
    g.tank.y = cy
    g.watching = false
    const before = g.tank.hp
    for (let i = 0; i < 4 && !rect.gone; i++) {
      g.hitCover({ struck: rect.id, damage: 1, owner: 'somebody-else', x: cx, y: cy, dead: false })
    }
    return {
      gone: !!rect.gone,
      gap: Math.round(gap),
      size: Math.min(rect.w, rect.h),
      scale: a.blastScaleOf(rect),
      before,
      after: g.tank.hp,
      dead: g.tank.dead,
    }
  }, { which: pick, at: dist })

  // The distance both shots are taken from: touching the tower.
  const contact = await page.evaluate(() => {
    const a = window.__arena
    const t = a.BREAKABLE.filter((r) => r.kind === 'barrel').find((r) => Math.min(r.w, r.h) >= 200)
    return Math.min(t.w, t.h) / 2 + 22
  })

  const tower = await shoot('tower', contact)
  check('the tower goes up', tower.gone, JSON.stringify(tower))
  check(
    'and a tank touching it loses hull to the blast',
    tower.after < tower.before,
    `hull ${tower.before} -> ${tower.after} at ${tower.gap} units, scale ${tower.scale?.toFixed?.(2)}`,
  )

  const drums = await shoot('drums', contact)
  check('the ordinary drums go up too', drums.gone, JSON.stringify(drums))
  // The control, and the whole reason there are two shots. Same tank, same
  // hull, same distance from the centre — only the multiplier differs. If this
  // one also lost hull then the tower's kill was not the scaled radius, and
  // every check above it is passing for the wrong reason.
  check(
    'the control — the same tank at the same distance from ordinary drums does not',
    drums.after === drums.before,
    `hull ${drums.before} -> ${drums.after} at ${drums.gap} units, scale ${drums.scale?.toFixed?.(2)}`,
  )
  // And the drums are not simply inert: at *their* contact distance they hurt,
  // the way every barrel in the game has since the day they shipped.
  const close = await shoot('drums', null)
  check(
    'and the drums are still a barrel — touching those hurts',
    close.after < close.before,
    `hull ${close.before} -> ${close.after} at ${close.gap} units`,
  )
  check(
    'the two really were different blasts',
    tower.scale > 2 && drums.scale === 1,
    `${tower.scale} against ${drums.scale}`,
  )
} finally {
  await browser.close()
}

console.log('')
if (failures) { console.error(`${failures} failed`); process.exit(1) }
console.log('all good')
