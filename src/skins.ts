// Tank skins.
//
// Puzz asked for "different classes of tanks and different upgrades players can
// unlock". This is the cosmetic half, and it is deliberately the half that
// ships first: a skin changes nothing about the simulation, so it needs no
// agreement between clients, no new trust and no balance pass. Classes that
// change how a tank *drives* are a separate issue and a much bigger one.
//
// **A skin never takes the player's hue away.** Every tank's colour comes from
// its own pubkey and is spread across a fixed palette so four tanks are
// obviously four colours; that is the single most load-bearing piece of
// legibility in a four-way scramble, and a skin that painted everyone black
// would trade the whole game's readability for a costume. So a skin changes
// the *finish* — how the plastic catches the light, what the trim does, how
// much of the hull carries the hue — and the hue survives all of them.
//
// The skin rides in the session attestation rather than on the state tick: it
// changes about once a session, and putting it on a 10Hz event to be
// re-transmitted ten times a second forever would be paying a tick-stream
// price for a lobby setting.

export type SkinId =
  | 'plastic' | 'matte' | 'chrome' | 'neon' | 'rust' | 'carbon'
  | 'woodland' | 'desert' | 'digital' | 'tiger' | 'navy' | 'urban'

/**
 * A camouflage pattern, painted procedurally in shades of the tank's own hue.
 *
 * "Every colour camo" (Puzz) and "the hue survives every skin" (the rule at
 * the top of this file) meet in the middle here: a camo is not a colour, it
 * is a PATTERN, and the tones it is drawn in are derived from the player's
 * dealt hue — a woodland tank in red is red-camo, still obviously the red
 * tank. Patterns are seeded per id, never per client, so every screen draws
 * the same blotches.
 */
export type CamoId = 'woodland' | 'desert' | 'digital' | 'tiger' | 'navy' | 'urban'

export interface Skin {
  id: SkinId
  label: string
  /** One line, shown under the picker. */
  blurb: string
  /** Multiplier on the hull's lightness, so a skin can be pale or dark. */
  light: number
  /** Passed straight to the hull material. */
  metalness: number
  roughness: number
  /**
   * How much of the tank's own hue glows.
   *
   * The one number that is really "how visible is this tank at distance", so
   * it stays modest everywhere except `neon`, whose entire idea is being seen.
   */
  emissive: number
  /** Trim (treads, barrel) colour. Null keeps the default gunmetal. */
  trim: number | null
  /** The pattern painted on the hull, or null for a plain finish. */
  camo: CamoId | null
}

export const SKINS: Record<SkinId, Skin> = {
  plastic: {
    id: 'plastic',
    label: 'Plastic',
    blurb: 'The toy-box original.',
    light: 1,
    metalness: 0.05,
    roughness: 0.42,
    emissive: 0.1,
    trim: null,
    camo: null,
  },
  matte: {
    id: 'matte',
    label: 'Matte',
    blurb: 'No sheen at all. Reads flat and dark on a bright board.',
    light: 0.82,
    metalness: 0,
    roughness: 1,
    emissive: 0.04,
    trim: 0x272d38,
    camo: null,
  },
  chrome: {
    id: 'chrome',
    label: 'Chrome',
    blurb: 'Polished. Picks up the sky and throws it back.',
    light: 1.12,
    metalness: 0.92,
    roughness: 0.16,
    emissive: 0.06,
    trim: 0x8d97a6,
    camo: null,
  },
  neon: {
    id: 'neon',
    label: 'Neon',
    blurb: 'Lit from inside. Easy to find, which cuts both ways.',
    light: 1.15,
    metalness: 0.1,
    roughness: 0.3,
    emissive: 0.5,
    trim: 0x1a2130,
    camo: null,
  },
  rust: {
    id: 'rust',
    label: 'Rust',
    blurb: 'Been in the field a while.',
    light: 0.72,
    metalness: 0.35,
    roughness: 0.95,
    emissive: 0.05,
    trim: 0x5a3a25,
    camo: null,
  },
  carbon: {
    id: 'carbon',
    label: 'Carbon',
    blurb: 'Dark hull, colour kept in the trim.',
    light: 0.28,
    metalness: 0.5,
    roughness: 0.55,
    emissive: 0.08,
    // Null on purpose: `carbon` is the one skin that puts the *hue* on the
    // trim, which the renderer does when the hull is this dark. See
    // `applySkin` in render.ts — a near-black tank with gunmetal treads would
    // be a tank with no colour at all, which is the one thing a skin may not
    // do.
    trim: null,
    camo: null,
  },
  woodland: {
    id: 'woodland',
    label: 'Woodland',
    blurb: 'Your colour, deep in the trees.',
    light: 0.9,
    metalness: 0.08,
    roughness: 0.7,
    emissive: 0.07,
    trim: 0x2c3327,
    camo: 'woodland',
  },
  desert: {
    id: 'desert',
    label: 'Desert',
    blurb: 'Sun-washed blotches of your own hue.',
    light: 1.02,
    metalness: 0.05,
    roughness: 0.8,
    emissive: 0.07,
    trim: 0x6b5b43,
    camo: 'desert',
  },
  digital: {
    id: 'digital',
    label: 'Digital',
    blurb: 'Pixel camo. The future, as imagined in 2006.',
    light: 0.95,
    metalness: 0.12,
    roughness: 0.55,
    emissive: 0.08,
    trim: 0x3a4049,
    camo: 'digital',
  },
  tiger: {
    id: 'tiger',
    label: 'Tiger',
    blurb: 'Stripes. For tanks that want to be seen mid-pounce.',
    light: 0.98,
    metalness: 0.1,
    roughness: 0.6,
    emissive: 0.09,
    trim: 0x1f242e,
    camo: 'tiger',
  },
  navy: {
    id: 'navy',
    label: 'Navy',
    blurb: 'Deep-water tones of your colour.',
    light: 0.78,
    metalness: 0.2,
    roughness: 0.5,
    emissive: 0.06,
    trim: 0x232a38,
    camo: 'navy',
  },
  urban: {
    id: 'urban',
    label: 'Urban',
    blurb: 'Concrete greys, your colour breaking through.',
    light: 0.92,
    metalness: 0.15,
    roughness: 0.65,
    emissive: 0.07,
    trim: 0x40454f,
    camo: 'urban',
  },
}

/** The picker groups the catalog: plain finishes first, then the camo rack. */
export const SKIN_GROUPS: { label: string; ids: SkinId[] }[] = [
  { label: 'Finishes', ids: ['plastic', 'matte', 'chrome', 'neon', 'rust', 'carbon'] },
  { label: 'Camo', ids: ['woodland', 'desert', 'digital', 'tiger', 'navy', 'urban'] },
]

export const SKIN_IDS = Object.keys(SKINS) as SkinId[]

export const DEFAULT_SKIN: SkinId = 'plastic'

/** Anything off the wire or out of storage, narrowed to a skin we have. */
export function asSkin(value: unknown): SkinId {
  return typeof value === 'string' && value in SKINS ? (value as SkinId) : DEFAULT_SKIN
}
