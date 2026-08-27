// Bundle entry for test/barrels.mjs. See the note at the top of test/lob.mjs
// for why this exists rather than a direct import.
export {
  BREAKABLE, BARREL_HP, CRATE_HP, BREACH_HP, fullHpOf, WALLS, applyCoverBits, coverBits, coverGeneration,
  damageCover, explodes, resetCover, setLayout, pointInTallWall, isLow,
} from '../src/arena'
export { spawnShell, stepShell } from '../src/sim'
