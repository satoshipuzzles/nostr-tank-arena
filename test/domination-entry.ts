// Bundle entry for test/domination.mjs. See the note at the top of test/lob.mjs
// for why this exists rather than a direct import.
export {
  CAPTURE_S, POINT_COUNT, POINT_RADIUS,
  freshState, heldBy, holderOn, onPoint, points, stepPoint,
} from '../src/domination'
export { setLayout, pointInWall, ARENA_W, ARENA_H } from '../src/arena'
