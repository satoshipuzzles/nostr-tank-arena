// One rule change per round, picked by the block.
//
// The block hash already chooses the map. It is a 256-bit number that every
// client discovers at the same moment and nobody controls, so it can equally
// choose *how the round plays* — and that is free variety: no new event kind,
// no announcement, no host, no vote. Two clients that agree on the tip agree on
// the rules for exactly the same reason they agree on the geometry.
//
// A different two hex digits than the map selection uses, so "Pillars" is not
// permanently welded to "Glass Cannon".
//
// ## What a modifier is allowed to touch
//
// The rule is not "only local things" — that was the original wording here and
// cowboy was right that it is too loose. The real invariant is sharper:
//
//   **Anything derived from the round's rules that another client also derives
//   must be anchored to the same input on both.**
//
// HP, reload, speed and respawn pass that trivially, because nobody else
// derives them: your own tank has always been authoritative over its own hull.
//
// Two things do not pass trivially, and both were wrong at some point.
//
// Shell bounces are re-simulated by everyone who receives the fire event, so
// the bounce budget travels *in that event* rather than being read from the
// current modifier on arrival. Otherwise a shell fired seconds before a block
// landed bounces once on the shooter's screen and three times on everybody
// else's, for the four seconds it takes the boundary to settle.
//
// `waveSeconds` and `emptyPads` feed the pickup schedule, and the wave index
// ends up inside the pickup id — so two clients disagreeing about the modifier
// compute different ids for the same pad and silently discard each other's
// claims. This was listed as "cannot desync" and it could. It is anchored now
// (see `pickups.ts`), which leaves only the block boundary itself: for the few
// seconds one client has seen the new tip and another has not, they disagree
// about the map, the rules and the schedule alike. That window is inherent to
// having no host, it is bounded by the poll interval, and it costs a pad.
//
// The test for anything added here is that second sentence, not "is it local".

export interface Modifier {
  id: string
  name: string
  /** One line, shown on the HUD and the podium. Say what changed, not how. */
  blurb: string
  hue: number
  /** Hull points. 1 makes every shot lethal. */
  maxHp: number
  /** Multiplier on drive speed. */
  speed: number
  /** Multiplier on reload time. Below 1 is faster. */
  reload: number
  /** Multiplier on the respawn wait. */
  respawn: number
  /** Seconds between pickup waves. */
  waveSeconds: number
  /** How many pads stay empty each wave. */
  emptyPads: number
  /** Wall bounces a shell gets before it dies. */
  bounces: number
}

const BASE = {
  maxHp: 3,
  speed: 1,
  reload: 1,
  respawn: 1,
  waveSeconds: 34,
  emptyPads: 1,
  bounces: 1,
}

export const MODIFIERS: Modifier[] = [
  {
    ...BASE,
    id: 'standard',
    name: 'Straight Deathmatch',
    blurb: 'No rule changes this block.',
    hue: 205,
  },
  {
    ...BASE,
    id: 'glass',
    name: 'Glass Cannon',
    blurb: 'One hit kills. Respawns are quick.',
    hue: 0,
    maxHp: 1,
    respawn: 0.6,
  },
  {
    ...BASE,
    id: 'overdrive',
    name: 'Overdrive',
    blurb: 'Everyone drives faster and reloads faster.',
    hue: 285,
    speed: 1.4,
    reload: 0.65,
  },
  {
    ...BASE,
    id: 'supply',
    name: 'Supply Run',
    blurb: 'Pickups every 10 seconds, and every pad is stocked.',
    hue: 130,
    waveSeconds: 10,
    emptyPads: 0,
  },
  {
    ...BASE,
    id: 'ricochet',
    name: 'Ricochet',
    blurb: 'Shells bounce three times. Nowhere is safe.',
    hue: 45,
    bounces: 3,
  },
]

export const DEFAULT_MODIFIER = MODIFIERS[0]

/**
 * Which rule set this block plays under.
 *
 * Reads the third and fourth hex digits from the end. The map selection reads
 * the last two, so map and modifier vary independently — the whole point is
 * that a board you know well can still surprise you.
 */
export function modifierForBlock(hash: string): Modifier {
  if (!/^[0-9a-f]{4,}$/i.test(hash)) return DEFAULT_MODIFIER
  const n = parseInt(hash.slice(-4, -2), 16)
  if (!Number.isInteger(n)) return DEFAULT_MODIFIER
  return MODIFIERS[n % MODIFIERS.length]
}
