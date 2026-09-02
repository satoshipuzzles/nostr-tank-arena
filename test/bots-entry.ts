// Bundle entry for test/bots.mjs. See the note at the top of test/lob.mjs:
// this project's sources use extensionless relative imports, which node's ESM
// resolver will not follow, so the suite bundles rather than importing.
export { BOT_COUNT, makeBot, stepBot, killBot, BOT_SKILLS, DEFAULT_SKILL, botSkillFor } from '../src/bots'
export { SPAWNS, ARENA_W, ARENA_H, hasLineOfSight, pointInWall } from '../src/arena'
// For the lead check, which measures the gun against the direct bearing rather
// than against another run's gun. See test/bots.mjs.
export { angleDelta } from '../src/sim'
