// Custom tank skins: player-supplied art, rendered over the hull.
//
// Puzz: "users should also be able to edit their own tank loadouts by
// uploading their own images and have them render over the tank. they should
// be able to save to their collection of tanks / skins."
//
// The design decisions the issue asked to have written down, written down:
//
// **Where the image lives: inside the skin event itself, as a data URL.**
// The alternatives were an external host (Blossom, an image CDN, a URL the
// player pastes) — and every one of them is a second service that has to
// resolve for every other player, forever, from networks we do not control.
// Instead the art is downscaled client-side to a 128×128 JPEG before it is
// ever saved — a texture on a toy tank the size of a thumb does not benefit
// from more — which lands the whole event well under 32 KB. That rides the
// relays we already use, arrives through the subscription machinery that
// already exists, and cannot rot: if the event is fetchable, the art is.
//
// **One event per skin, not one collection event.** Kind 30078 addressable,
// `d: nostr-tank-arena/skin/<slug>`, tagged `t: tankarena-skin` so the whole
// collection is one author+kind+tag query. A single collection event would
// grow with every save until it hit a relay's size ceiling; per-skin events
// stay small forever and replace cleanly per slug.
//
// **The hue survives, by the carbon rule.** Custom art covers the hull, so
// the player's dealt hue moves to the trim — exactly what the carbon finish
// already does, for exactly the same reason: a tank whose colour is nowhere
// is a tank nobody can tell apart at speed. The ring, plate and driver stay
// hue-coloured like everybody else's.
//
// **On the wire it is a marker, not the image.** The session attestation's
// `sk` field carries `u:<slug>`; peers fetch the wearer's skin event once and
// cache it. Old clients run the id through `asSkin`, get plastic in the right
// hue, and lose nothing — the same fail-soft every unknown skin id has always
// had. New clients show the same plastic until the art arrives, then the tank
// dresses itself, the way nameplates already fill in when a kind 0 lands.

/** A saved custom skin: a name, and the art it wears. */
export interface CustomSkin {
  /** The `d`-tag slug — the name, slugified, unique per author. */
  slug: string
  name: string
  /** A `data:image/jpeg;base64,...` URL, ≤ ART_BYTES_MAX when decoded. */
  art: string
}

/** The event `d` prefix and the collection tag. */
export const SKIN_D_PREFIX = 'nostr-tank-arena/skin/'
export const SKIN_TAG = 'tankarena-skin'

/** The square the art is resampled to before saving. */
export const ART_SIZE = 128
/**
 * The ceiling on the encoded art. 24 KB of base64 is ~18 KB of JPEG, and a
 * 128×128 JPEG only gets there if it is pure noise — but a hard cap is what
 * turns "relays usually take it" into "relays take it".
 */
export const ART_BYTES_MAX = 24_576

/** The attestation marker for a worn custom skin. */
export const CUSTOM_PREFIX = 'u:'

/** `u:<slug>` from an attestation's `sk`, or null when it is a built-in. */
export function customRefOf(sk: unknown): string | null {
  if (typeof sk !== 'string' || !sk.startsWith(CUSTOM_PREFIX)) return null
  const slug = sk.slice(CUSTOM_PREFIX.length)
  return isSlug(slug) ? slug : null
}

/**
 * A slug is the name flattened to what a `d` tag and a wire marker can carry
 * verbatim. Lowercase alphanumerics and dashes, bounded — a slug is queried
 * and compared, never rendered, so nothing is lost.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

export function isSlug(v: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(v)
}

/**
 * The art, validated the way a *receiver* has to validate it: this string
 * came off the wire from somebody else's event, and it goes into an <img>
 * src. Only a JPEG or PNG data URL of bounded size passes — never a remote
 * URL, which would let a skin event turn every viewer into a tracking pixel.
 */
export function isSafeArt(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(v) &&
    v.length <= ART_BYTES_MAX * 1.4
  )
}

/** Parse a skin event's content. Null for anything malformed — see above. */
export function parseSkinContent(content: string, slug: string): CustomSkin | null {
  try {
    const v = JSON.parse(content) as { name?: unknown; art?: unknown }
    if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 48) return null
    if (!isSafeArt(v.art)) return null
    return { slug, name: v.name, art: v.art }
  } catch {
    return null
  }
}

/**
 * Resample an image file to the saved art.
 *
 * Cover-fit into the square — a stretched logo reads as a bug, a cropped one
 * reads as a choice. JPEG at descending quality until it fits the cap; an
 * image that will not fit at quality 0.5 is noise and is refused rather than
 * saved as mud.
 */
export async function encodeArt(file: Blob): Promise<string | null> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('unreadable image'))
      i.src = url
    })
    const c = document.createElement('canvas')
    c.width = ART_SIZE
    c.height = ART_SIZE
    const ctx = c.getContext('2d')
    if (!ctx) return null
    const scale = Math.max(ART_SIZE / img.width, ART_SIZE / img.height)
    const w = img.width * scale
    const h = img.height * scale
    ctx.drawImage(img, (ART_SIZE - w) / 2, (ART_SIZE - h) / 2, w, h)
    for (const q of [0.8, 0.65, 0.5]) {
      const out = c.toDataURL('image/jpeg', q)
      if (out.length <= ART_BYTES_MAX * 1.4) return out
    }
    return null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}
