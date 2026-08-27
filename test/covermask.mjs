// Every piece of cover reports its damage, on every board.
//
// rainmaker, diagnosing a hit-registration report: the vault prepended six
// breakables to every board, three layouts went to fourteen, and the `cd`
// damage mask holds ten slots. So four pieces of cover transmitted **no damage
// tiers at all** — you shell a crate six times, it stays pristine on every
// other screen, and then it vanishes when the destroyed mask carries its death.
// Deterministic, and it reads exactly like a netcode fault.
//
// Two things are checked here, and they are separate claims:
//
//   1. **Every breakable's tier survives the round trip**, on every board in
//      the rotation — including the ones past slot ten, through the second
//      bank.
//   2. **The vault is appended, not prepended.** That is what keeps every index
//      that existed before it exactly where it was, so a client still running
//      an older bundle maps bit *i* to the same rect we do. Without it, an old
//      client destroying its crate 0 would open a vault on every current
//      screen — a worse bug than the one that started this, and invisible until
//      somebody left a tab open across a deploy.
//
// Arithmetic over the real geometry, no browser: the packing is a pure
// function and the boards are a pure function of the block hash.
//
// Run: node test/covermask.mjs

import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'

const out = '.scratch/covermask-bundle.mjs'
mkdirSync('.scratch', { recursive: true })
await build({
  entryPoints: ['test/pads-entry.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
  external: ['three', 'nostr-tools'],
})
const arena = await import('../' + out)
rmSync(out)

let failures = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const {
  LAYOUTS, BREAKABLE, WALLS, setLayout, resetCover, damageCover, damageTier,
  coverDamageBits, applyCoverDamageBits, TIER_BANK, fullHpOf,
} = arena

let widest = 0
for (let i = 0; i < LAYOUTS.length; i++) {
  setLayout(i)
  resetCover()
  const name = LAYOUTS[i].name
  widest = Math.max(widest, BREAKABLE.length)

  // --------------------------------------------- 1. the vault is at the end
  const breachIdx = BREAKABLE.map((b, n) => (b.kind === 'breach' ? n : -1)).filter((n) => n >= 0)
  const otherIdx = BREAKABLE.map((b, n) => (b.kind === 'breach' ? -1 : n)).filter((n) => n >= 0)
  check(
    breachIdx.length === 6 && (!otherIdx.length || Math.min(...breachIdx) > Math.max(...otherIdx)),
    `${name}: the vault's walls come after every other breakable`,
    `breach at ${breachIdx.join(',')} against cover at ${otherIdx.join(',')}`,
  )

  // ------------------------------ 2. every tier makes it across, on every board
  //
  // Damage each one a different amount, pack, wipe, unpack, compare. Any slot
  // the mask cannot carry shows up as a tier that arrives as zero.
  const wanted = []
  for (let n = 0; n < BREAKABLE.length; n++) {
    const hits = 1 + (n % 2) // one or two, so the tiers are not all the same
    damageCover(BREAKABLE[n].id, Math.min(hits, Math.max(1, fullHpOf(BREAKABLE[n]) - 1)))
    wanted.push(damageTier(BREAKABLE[n]))
  }
  const banks = [coverDamageBits(0), coverDamageBits(1)]
  // A fresh client: the board is intact and it has only the masks.
  resetCover()
  check(
    BREAKABLE.every((b) => damageTier(b) === 0),
    `${name}: control — a fresh board reports no damage`,
  )
  applyCoverDamageBits(banks[0], 0)
  applyCoverDamageBits(banks[1], 1)
  const got = BREAKABLE.map((b) => damageTier(b))
  const mismatch = got.findIndex((t, n) => t !== wanted[n])
  check(
    mismatch === -1,
    `${name}: every breakable's damage tier crosses the wire`,
    mismatch === -1
      ? ''
      : `index ${mismatch} wanted ${wanted[mismatch]} got ${got[mismatch]} of ${BREAKABLE.length}`,
  )
  // And the second bank is only paid for when it is needed.
  check(
    BREAKABLE.length > TIER_BANK ? banks[1] !== 0 : banks[1] === 0,
    `${name}: the second bank rides along only when the board needs it`,
    `${BREAKABLE.length} breakables, bank1=${banks[1]}`,
  )
  resetCover()
}

// The control that gives the whole file its point: without a second bank, a
// board this wide loses the tiers above slot ten. Asserted rather than assumed,
// because if the boards ever shrink back under ten this file is measuring
// nothing and should say so.
check(widest > TIER_BANK, 'a board wider than one bank exists to test', `widest ${widest}, bank ${TIER_BANK}`)

console.log('')
if (failures) {
  console.error(`${failures} failed`)
  process.exit(1)
}
console.log('all good')
