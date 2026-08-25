// Bundle entry for test/chopper.mjs. See the note at the top of test/lob.mjs
// for why this exists rather than a direct import.
export {
  CHOPPER_ALT, CHOPPER_DAMAGE, CHOPPER_HIT_MS, CHOPPER_MS, CHOPPER_REACH,
  CHOPPER_SPEED, CHOPPER_SPREAD, chopperAim, stepChopper, underFire,
} from '../src/chopper'
export { ARENA_W, ARENA_H, setLayout } from '../src/arena'
