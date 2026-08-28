// The settings screen, and the promise its key reference makes.
//
// Puzz, 2026-08-25: "Settings screen with tank loadouts, controller settings
// and player cards and stats." Everything on it already existed and was
// scattered, so most of what this file checks is that the *move* worked:
// the relay editor still works from its new home, the mute button and the
// in-game one agree, and the panel is a list of sections a phone can read.
//
// The half worth the most is the key reference. The issue described today's
// controls as "undocumented keys", and the trap in fixing that is writing them
// down a second time — documentation typed out by hand goes stale on the first
// rebind and nothing fails. So the driving keys are *derived* from the table
// `input.ts` actually reads, and the global hotkeys, which have no table, are
// declared in `keymap.ts` and checked here **against the source that handles
// them, in both directions**. A key the screen claims and the game does not
// handle is a lie; a key the game handles and the screen does not list is the
// original complaint.
//
//   npm run build && npx vite preview --port 4342 &
//   node test/settings.mjs

import { existsSync, readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4342/'
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

// ------------------------------------------------- the reference against the source
//
// Read as text rather than imported: the point is what `main.ts` *does*, and
// importing the declaration and comparing it to itself would pass against any
// pair of numbers. This is the one check in the file that does not need a
// browser, and it is the one that keeps the screen honest.
const keymap = readFileSync('src/keymap.ts', 'utf8')
const mainSrc = readFileSync('src/main.ts', 'utf8')
const inputSrc = readFileSync('src/input.ts', 'utf8')

const declared = [...keymap.matchAll(/\{ code: '([A-Za-z]+)', action: '[^']*', where: '([^']+)' \}/g)]
  .map((m) => ({ code: m[1], where: m[2] }))
check('the reference declares some global hotkeys', declared.length >= 5, `${declared.length}`)

const missing = declared.filter(({ code, where }) => {
  const src = where === 'src/main.ts' ? mainSrc : readFileSync(where, 'utf8')
  return !src.includes(`'${code}'`)
})
check(
  'every key the screen claims is handled where it says it is',
  missing.length === 0,
  missing.map((m) => `${m.code} not in ${m.where}`).join(', '),
)

// The other direction, which is the one that catches an undocumented key
// appearing. Every `e.code === 'X'` and `e.code !== 'X'` guard in main.ts is a
// hotkey somebody added; each has to be in the reference.
const handled = new Set(
  [...mainSrc.matchAll(/e\.code (?:===|!==) '([A-Za-z]+)'/g)].map((m) => m[1]),
)
const undocumented = [...handled].filter((c) => !declared.some((d) => d.code === c))
check(
  'and every key the game handles is on the screen',
  undocumented.length === 0,
  undocumented.join(', '),
)

// The digits are one rule, declared as a range, so the check is for the rule.
check(
  'the digit row is documented as the range it is handled as',
  mainSrc.includes('Digit([1-9])') && keymap.includes("pattern: 'Digit([1-9])'"),
)

// Pad buttons carry the index they are read at, and the index is what can be
// falsified — "right trigger" is a name, `buttons[7]` is a fact.
const padButtons = [...keymap.matchAll(/buttons: \[([0-9, ]*)\]/g)]
  .flatMap((m) => m[1].split(',').map((n) => n.trim()).filter(Boolean))
check('the pad reference names real buttons', padButtons.length >= 5, padButtons.join(','))
const badPad = padButtons.filter((n) => !inputSrc.includes(`buttons[${n}]`))
check(
  'and every one of them is a button input.ts reads',
  badPad.length === 0,
  badPad.map((n) => `buttons[${n}]`).join(', '),
)

// ------------------------------------------------------------------ the screen
const browser = await puppeteer.launch({
  executablePath, headless: 'new',
  args: ['--no-sandbox', '--window-size=1280,900', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--mute-audio',
    '--disable-background-timer-throttling'],
})
try {
  const page = await browser.newPage()
  // A phone, because that is the shape this was built for. A desktop pass
  // would hide exactly the failure mode worth catching — a card wider than the
  // glass, which is how the leaderboard once shipped.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await page.goto(`${URL_}?room=set${Math.floor(Math.random() * 1e6)}`)

  // ------------------------------------------------------ 1. the lobby door
  const closed = await page.evaluate(() => ({
    hidden: document.getElementById('settings')?.hidden,
    display: getComputedStyle(document.getElementById('settings')).display,
  }))
  check('it starts closed', closed.hidden === true && closed.display === 'none', JSON.stringify(closed))

  await page.click('#lobby-settings')
  const open = await page.evaluate(() => {
    const el = document.getElementById('settings')
    const card = el.querySelector('.settings-card')
    return {
      display: getComputedStyle(el).display,
      sections: [...el.querySelectorAll('.setting h3')].map((h) => h.textContent.trim()),
      width: Math.round(card.getBoundingClientRect().width),
      overflow: Math.round(card.getBoundingClientRect().right) > window.innerWidth,
    }
  })
  check('the lobby opens it', open.display !== 'none', open.display)
  check(
    'it holds the sections the issue asked for',
    ['Sound', 'Controls'].every((s) => open.sections.includes(s)) && open.sections.length >= 4,
    open.sections.join(' / '),
  )
  check('and it fits a 390px phone', !open.overflow && open.width <= 390, `${open.width}px`)

  // ----------------------------------------------- 2. the keys are printed, not typed
  const rows = await page.evaluate(() => ({
    drive: [...document.querySelectorAll('#keymap-drive tr')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
    game: [...document.querySelectorAll('#keymap-game tr')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
    pad: [...document.querySelectorAll('#keymap-pad tr')].length,
  }))
  check('the driving keys are on the screen', rows.drive.length >= 7, `${rows.drive.length} rows`)

  // The selected scheme has to *look* selected. Checked as a computed colour
  // rather than as an attribute, because the first version set a class this
  // stylesheet does not paint: the attribute was right and all three buttons
  // rendered identically. An assertion on the markup could not tell.
  const picked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#settings-scheme button')]
    return btns.map((b) => ({
      keys: b.dataset.keys,
      pressed: b.getAttribute('aria-pressed'),
      bg: getComputedStyle(b).backgroundColor,
    }))
  })
  const lit = picked.filter((b) => b.bg !== picked.find((o) => o.pressed === 'false')?.bg)
  check(
    'the chosen scheme is visibly the chosen one',
    lit.length === 1 && lit[0].keys === 'both',
    JSON.stringify(picked),
  )
  check('solo shows both halves of the keyboard', rows.drive[0]?.includes('W') && rows.drive[0]?.includes('↑'), rows.drive[0])
  check('the round hotkeys are there', rows.game.length >= 7, `${rows.game.length} rows`)
  check('and the gamepad', rows.pad >= 5, `${rows.pad} rows`)

  // Player two's keys are a different set, and the screen has to say so — this
  // is the check that would fail if the table were hand-written for one player
  // and reused for the other.
  await page.evaluate(() => document.querySelector('#settings-scheme button[data-keys="arrows"]').click())
  const p2 = await page.$eval('#keymap-drive', (t) => t.textContent.replace(/\s+/g, ' ').trim())
  check(
    "player two gets their own bindings, not player one's",
    p2.includes('↑') && !p2.includes('W') && p2.includes('/'),
    p2.slice(0, 90),
  )

  // ------------------------------------------------------------- 3. the volume
  const vol = await page.evaluate(() => {
    const input = document.getElementById('volume')
    input.value = '80'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return {
      shown: document.getElementById('volume-value').textContent,
      stored: localStorage.getItem('tank.volume'),
    }
  })
  check('the slider moves the level and says so', vol.shown === '80%', vol.shown)
  check('and stores it', Math.abs(Number(vol.stored) - 0.8) < 0.001, String(vol.stored))

  // It survives a reload, which is the whole reason it is stored. And the
  // panel has to come back showing the stored value rather than the default —
  // a control that forgets is worse than no control.
  await page.reload()
  await page.click('#lobby-settings')
  const back = await page.$eval('#volume-value', (el) => el.textContent)
  check('and it is still there after a reload', back === '80%', back)

  // ------------------------------------------------- 4. the relay editor moved, not copied
  const relays = await page.evaluate(() => ({
    inSettings: !!document.querySelector('#settings #relay-rows'),
    inLobby: !!document.querySelector('#lobby #relay-rows'),
    editors: document.querySelectorAll('#relay-rows').length,
    textareas: document.querySelectorAll('#relays').length,
    rows: document.querySelectorAll('#relay-rows li').length,
  }))
  check('the relay editor is in settings now', relays.inSettings && !relays.inLobby, JSON.stringify(relays))
  check('there is exactly one of it', relays.editors === 1 && relays.textareas === 1, JSON.stringify(relays))
  check('and it still built its rows', relays.rows >= 3, `${relays.rows} relays`)

  // ------------------------------------------------------------ 5. the in-game door
  await page.evaluate(() => document.getElementById('settings-close').click())
  await page.type('#name', 'set')
  await page.click('#play-guest')
  await page.waitForFunction(() => !!window.__game, { timeout: 20_000 })
  const inGame = await page.evaluate(() => {
    document.getElementById('show-settings').click()
    return getComputedStyle(document.getElementById('settings')).display
  })
  check('the in-game menu opens it too', inGame !== 'none', inGame)

  // The mute button in here is the same control as the one in the HUD, not a
  // second one that can disagree with it.
  const mute = await page.evaluate(() => {
    const before = document.getElementById('settings-mute').textContent.trim()
    document.getElementById('settings-mute').click()
    return {
      before,
      settings: document.getElementById('settings-mute').textContent.trim(),
      hud: document.getElementById('sound-toggle').textContent.trim(),
    }
  })
  check(
    'muting from settings moves the in-game button with it',
    mute.settings === mute.hud && mute.settings !== mute.before,
    JSON.stringify(mute),
  )
} finally {
  await browser.close()
}

console.log('')
if (failures) { console.error(`${failures} failed`); process.exit(1) }
console.log('all good')
