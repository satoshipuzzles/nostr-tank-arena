// Calling cards.
//
// Puzz asked for "calling cards" and "player cards and stats". A calling card
// is the badge that appears beside your name when you kill somebody — the one
// thing on their death screen that is *yours* rather than the game's.
//
// ## What a card is, and what it is not
//
// A card is a **claim**, not a credential, and the issue that filed this asked
// for that decision to be made explicitly rather than left ambiguous. Here it
// is, and the README says the same thing:
//
//   - Cards are cosmetic. Nothing in the simulation reads one.
//   - An earned card's condition is defined **entirely in terms of the
//     player's own signed score events** — the same per-block, addressable
//     records the leaderboard is built from. So anybody who wants to check a
//     card *can*: query that npub's score history and add it up. There is
//     nothing here that only a server could verify.
//   - This client checks its own before it lets you wear one, and it displays
//     what a peer claims without re-querying them mid-match. That is the same
//     trust model as the HP in their state tick, and for the same reason: the
//     cost of the lie is a costume.
//
// A guest has no npub and therefore no history, so a guest wears the free set.
// That is not a punishment: it is the honest reading of "unlocked by what you
// have published" for somebody who has published nothing.
//
// ## Why the conditions are the ones they are
//
// Every threshold below is a number this game already publishes: kills and
// deaths per round, the best streak in that round, and which block it belonged
// to. Nothing here needed a new event, a new counter or a new kind — which is
// the test the issue set, and the reason the achievement list is short rather
// than aspirational.

/** What a player's own published history adds up to. See `fetchCareer`. */
export interface Career {
  /** Rounds with a published result. */
  rounds: number
  kills: number
  deaths: number
  /** The best single-round streak they ever published. */
  bestStreak: number
  /**
   * Blocks where their result was the top one, across the window the block
   * wall covers. A career number with a horizon, and the UI says so rather
   * than implying it reaches back to genesis.
   */
  blocksWon: number
}

export const noCareer = (): Career => ({ rounds: 0, kills: 0, deaths: 0, bestStreak: 0, blocksWon: 0 })

export type CardId =
  | 'rookie'
  | 'scrapper'
  | 'sightline'
  | 'veteran'
  | 'centurion'
  | 'unbroken'
  | 'apex'
  | 'blockrunner'
  | 'champion'
  | 'regular'

export interface Card {
  id: CardId
  name: string
  /** What it takes, in words, for the picker and the tooltip. */
  rule: string
  /** True when anyone may wear it. */
  free: boolean
  /** The hue the badge is drawn in. */
  hue: number
  /** Does this history earn it? Pure, so the picker and a checker agree. */
  earned: (c: Career) => boolean
  /** The badge, as SVG path data on a 24x24 grid. House style: see REWARD_PATHS. */
  art: string
}

export const CARDS: readonly Card[] = [
  {
    id: 'rookie',
    name: 'Rookie',
    rule: 'Everybody starts here',
    free: true,
    hue: 200,
    earned: () => true,
    art: '<path d="M12 2 3 6v6c0 5 3.8 9.2 9 10 5.2-.8 9-5 9-10V6Z"/>',
  },
  {
    id: 'scrapper',
    name: 'Scrapper',
    rule: 'Free — wear it and mean it',
    free: true,
    hue: 25,
    earned: () => true,
    art: '<path d="M4 3h4l12 12-4 4L4 7Z"/><path d="M17 3h3v3l-4 4-3-3Z"/>',
  },
  {
    id: 'sightline',
    name: 'Sightline',
    rule: 'Free',
    free: true,
    hue: 155,
    earned: () => true,
    art:
      '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
      '<path d="M12 1v5M12 18v5M1 12h5M18 12h5" stroke="currentColor" stroke-width="2.4"/>',
  },
  {
    id: 'veteran',
    name: 'Veteran',
    rule: '50 career kills',
    free: false,
    hue: 45,
    earned: (c) => c.kills >= 50,
    art: '<path d="M6 2h12v9a6 6 0 0 1-12 0Z"/><path d="M9 17h6l2 5H7Z"/>',
  },
  {
    id: 'centurion',
    name: 'Centurion',
    rule: '200 career kills',
    free: false,
    hue: 15,
    earned: (c) => c.kills >= 200,
    art:
      '<path d="M12 1 4 4v7c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V4Z"/>' +
      '<path d="M12 5.5 7 7.4v3.8c0 3.2 2.1 6 5 7.2 2.9-1.2 5-4 5-7.2V7.4Z" fill="#0b0e13"/>' +
      '<path d="M11 9h2v7h-2Z"/>',
  },
  {
    id: 'unbroken',
    name: 'Unbroken',
    rule: 'A ten-kill streak in one round',
    free: false,
    hue: 300,
    earned: (c) => c.bestStreak >= 10,
    art: '<path d="M13.5 1 5 13h4.5L8 23l9.5-13H13Z"/>',
  },
  {
    id: 'apex',
    name: 'Apex',
    rule: 'A twenty-five-kill streak in one round',
    free: false,
    hue: 0,
    earned: (c) => c.bestStreak >= 25,
    art:
      '<path d="M12 1c5.2 0 9 2.6 9 4.6S17.2 9 12 9 3 7.2 3 5.6 6.8 1 12 1Z"/>' +
      '<path d="M9.6 10h4.8l1.2 8H8.4Z"/><path d="M4 20h16v3H4Z"/>',
  },
  {
    id: 'blockrunner',
    name: 'Blockrunner',
    rule: 'Win a block',
    free: false,
    hue: 40,
    earned: (c) => c.blocksWon >= 1,
    art: '<path d="M3 5h18v14H3Z"/><path d="M6 8h12v3H6Zm0 5h7v3H6Z" fill="#0b0e13"/>',
  },
  {
    id: 'champion',
    name: 'Champion',
    rule: 'Win five blocks',
    free: false,
    hue: 50,
    earned: (c) => c.blocksWon >= 5,
    art:
      '<path d="M5 3h14v4a7 7 0 0 1-14 0Z"/><path d="M2 4h3v4H2Zm17 0h3v4h-3Z"/>' +
      '<path d="M10 14h4v4h-4Z"/><path d="M7 19h10v3H7Z"/>',
  },
  {
    id: 'regular',
    name: 'Regular',
    rule: '25 rounds finished and published',
    free: false,
    hue: 190,
    earned: (c) => c.rounds >= 25,
    art:
      '<path d="M4 3h16v18l-8-4-8 4Z"/>' +
      '<path d="M8 7h8v2H8Zm0 4h8v2H8Z" fill="#0b0e13"/>',
  },
]

export const DEFAULT_CARD: CardId = 'rookie'

export const asCard = (v: unknown): CardId =>
  CARDS.some((c) => c.id === v) ? (v as CardId) : DEFAULT_CARD

export const cardOf = (id: CardId): Card => CARDS.find((c) => c.id === id) ?? CARDS[0]

/**
 * The cards this history has earned.
 *
 * A pure function of a `Career`, which is itself a pure function of the score
 * events an npub has signed — so this client, that client and a curious third
 * party all get the same answer from the same public data. That is the whole
 * of the verification story, and it is why the conditions are expressed in
 * published numbers rather than in anything this client remembers locally.
 */
export function unlocked(career: Career): Set<CardId> {
  return new Set(CARDS.filter((c) => c.free || c.earned(career)).map((c) => c.id))
}

/** The badge as inline SVG. Same contract as `iconSvg` and `rewardIcon`. */
export function cardArt(id: CardId, cls = 'card-art'): string {
  const card = cardOf(id)
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${card.art}</svg>`
}
