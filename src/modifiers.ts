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
// Only things a client already decides for itself. HP, reload, speed and
// respawn are local — your own tank has always been authoritative over them —
// and the pickup schedule is derived from the same hash on every client. So a
// modifier adds no trust and cannot desync anybody.
//
// Shell bounces are the one exception, because a shell is re-simulated by
// everyone who receives the fire event. It is *not* read from the current
// modifier when a shell is re-created from the wire: the bounce budget travels
// in the fire event itself. Otherwise a shell fired seconds before a block
// landed would bounce once on the shooter's screen and three times on
// everybody else's, for the four seconds it takes the boundary to settle.

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
  waveSeconds: 22,
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
    blurb: 'Pickups every 9 seconds, and every pad is stocked.',
    hue: 130,
    waveSeconds: 9,
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
