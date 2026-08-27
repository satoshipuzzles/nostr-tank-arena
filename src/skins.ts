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

type BaseSkinId =
  | 'plastic' | 'matte' | 'chrome' | 'neon' | 'rust' | 'carbon'
  | 'woodland' | 'desert' | 'digital' | 'tiger' | 'navy' | 'urban'

/**
 * The finishes a camo pattern can be struck in, beyond its plain (plastic)
 * base. Carbon is deliberately absent: its whole trick is a near-black hull
 * with the hue moved to the trim, and a pattern painted in shades of the hue
 * on a hull that dark is a pattern nobody can see.
 */
export type CamoFinish = 'matte' | 'chrome' | 'neon' | 'rust'

/**
 * Twelve hand-tuned entries plus the generated matrix: every camo pattern in
 * every finish that can carry one. The bare camo ids ('woodland') predate the
 * matrix and stay valid on the wire — they are the pattern in its plastic
 * base, and renaming them would strand every stored and attested skin.
 */
export type SkinId = BaseSkinId | `${CamoId}-${CamoFinish}`

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

const BASE: Record<BaseSkinId, Skin> = {
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

export const CAMO_IDS: CamoId[] = ['woodland', 'desert', 'digital', 'tiger', 'navy', 'urban']
const CAMO_FINISHES: CamoFinish[] = ['matte', 'chrome', 'neon', 'rust']

/**
 * The generated three-quarters of the catalog: pattern × finish, composed
 * from the hand-tuned entries rather than tuned 24 more times. The pattern
 * contributes its camo and its darkness; the finish contributes the surface
 * (metalness, roughness, glow, trim). Neon is clamped below the pure-neon
 * glow so the pattern still reads through it — a camo you cannot see through
 * the light is just neon with extra steps.
 */
const combos = {} as Record<`${CamoId}-${CamoFinish}`, Skin>
const FINISH_BLURB: Record<CamoFinish, string> = {
  matte: 'dead flat',
  chrome: 'polished to a shine',
  neon: 'lit from inside',
  rust: 'field-worn',
}
for (const c of CAMO_IDS) {
  for (const f of CAMO_FINISHES) {
    const pattern = BASE[c]
    const finish = BASE[f]
    const id = `${c}-${f}` as const
    combos[id] = {
      id,
      label: `${pattern.label} ${finish.label}`,
      blurb: `${pattern.label}, ${FINISH_BLURB[f]}.`,
      light: Math.round(pattern.light * finish.light * 100) / 100,
      metalness: finish.metalness,
      roughness: finish.roughness,
      emissive: f === 'neon' ? 0.32 : finish.emissive,
      trim: finish.trim ?? pattern.trim,
      camo: pattern.camo,
    }
  }
}

export const SKINS: Record<SkinId, Skin> = { ...BASE, ...combos }

// ------------------------------------------------------------ the two axes

/** What the picker rows offer: a pattern (or none) and a finish. */
export type Pattern = 'solid' | CamoId
export type FinishId = 'plastic' | 'matte' | 'chrome' | 'neon' | 'rust' | 'carbon'
export const PATTERNS: Pattern[] = ['solid', ...CAMO_IDS]
export const FINISHES: FinishId[] = ['plastic', 'matte', 'chrome', 'neon', 'rust', 'carbon']

/**
 * The axes back to an id. A solid tank in a finish IS that finish's entry; a
 * camo in its plastic base is the bare camo id, for wire compatibility. The
 * one impossible cell — carbon under a pattern — resolves to the pattern's
 * matte, which is the closest thing to what was asked for; the picker
 * disables the button so the fallback is a guard, not a path.
 */
export function skinFor(pattern: Pattern, finish: FinishId): SkinId {
  if (pattern === 'solid') return finish
  if (finish === 'plastic') return pattern
  if (finish === 'carbon') return `${pattern}-matte`
  return `${pattern}-${finish}`
}

export function patternOf(id: SkinId): Pattern {
  const camo = SKINS[id].camo
  return camo ?? 'solid'
}

export function finishOf(id: SkinId): FinishId {
  const dash = id.indexOf('-')
  if (dash !== -1) return id.slice(dash + 1) as FinishId
  return (CAMO_IDS as string[]).includes(id) ? 'plastic' : (id as FinishId)
}

export const SKIN_IDS = Object.keys(SKINS) as SkinId[]

export const DEFAULT_SKIN: SkinId = 'plastic'

/** Anything off the wire or out of storage, narrowed to a skin we have. */
export function asSkin(value: unknown): SkinId {
  return typeof value === 'string' && value in SKINS ? (value as SkinId) : DEFAULT_SKIN
}
