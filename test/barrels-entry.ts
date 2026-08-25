// Bundle entry for test/barrels.mjs. See the note at the top of test/lob.mjs
// for why this exists rather than a direct import.
export {
  BARRELS, BARREL_HP, WALLS, applyCoverBits, coverBits, coverGeneration,
  damageCover, resetCover, setLayout, pointInTallWall, isLow,
} from '../src/arena'
export { spawnShell, stepShell } from '../src/sim'
