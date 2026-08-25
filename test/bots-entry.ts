// Bundle entry for test/bots.mjs. See the note at the top of test/lob.mjs:
// this project's sources use extensionless relative imports, which node's ESM
// resolver will not follow, so the suite bundles rather than importing.
export { BOT_COUNT, makeBot, stepBot, killBot } from '../src/bots'
export { SPAWNS, ARENA_W, ARENA_H, hasLineOfSight } from '../src/arena'
