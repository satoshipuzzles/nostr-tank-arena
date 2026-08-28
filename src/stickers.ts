// Emoji stickers: decals a player picks for their hull.
//
// Puzz (2026-08-25): "players should be able to add emoji stickers to their
// tanks to customize."
//
// A sticker is a codepoint in a hull slot, and it travels the way the skin and
// the calling card do: on the session attestation, once a sitting, because a
// lobby setting has no business on a 10Hz tick. Old clients drop the unknown
// field and lose nothing — a tank with no stickers is just a tank.
//
// **The catalog is the validation.** A sticker is a picture, not a text field:
// the payload is drawn onto every other player's screen, so a free string here
// is a way to write words on somebody's monitor that no moderation exists to
// take down — same family as the custom-skin rule that art must never be a
// remote URL. Membership in this list is the whole receiver-side check, and it
// also keeps the picker honest: everything offered is known to render as a
// single glyph rather than as a tofu box mid-sentence.

/** Every sticker the game knows. Order is the picker's layout, so append. */
export const STICKER_CATALOG = [
  '🔥', '💀', '😀', '😂', '😎', '😈', '🤠', '🥶', '🤖', '👻', '👽', '🤡',
  '🐍', '🐉', '🦈', '🦅', '🐺', '🦂', '🕷️', '🐝', '🍀', '🌵', '⚡', '❄️',
  '🌊', '🌙', '⭐', '☀️', '🌈', '💣', '🗡️', '🛡️', '🎯', '🏴‍☠️', '⚓\ufe0f', '🎲',
  '👑', '💎', '🚀', '☢️', '⚠️', '💙', '🖤', '💜', '🍕', '🍩', '🎸', '🎱',
] as const

const KNOWN = new Set<string>(STICKER_CATALOG)

/**
 * Four, because that is how many clear corners the hull deck has: the dome
 * and the barrel own the centre strip, and the plate stack (y=7..133) means
 * nothing new goes above the turret. Slot i is deck corner i — see
 * `applyStickers` in render.ts for which corner is which.
 */
export const STICKER_SLOTS = 4

/**
 * A peer's claimed stickers, reduced to the ones that are real.
 *
 * Entry-wise rather than all-or-nothing: one junk entry in a hand-rolled
 * payload should cost that entry, not the three honest ones beside it. Order
 * is preserved because order *is* the slot assignment.
 */
export function asStickers(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const s of v) {
    if (out.length >= STICKER_SLOTS) break
    if (typeof s === 'string' && KNOWN.has(s)) out.push(s)
  }
  return out
}
