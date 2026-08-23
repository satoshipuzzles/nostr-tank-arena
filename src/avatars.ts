// Profile pictures, turned into the character riding the tank.
//
// Mario Party puts a character in every vehicle and that is most of why you
// care which one is yours. Here the character is your npub: the kind 0 picture
// from `profiles.ts`, cropped to a circle, ringed in your player colour, and
// parked in the turret hatch as a billboard so it faces the camera from any
// angle the board is seen at.
//
// ## Why this goes through a canvas
//
// WebGL will not sample a cross-origin image unless the server said it could.
// Profile pictures live on whatever host their owner chose — nostr.build,
// imgur, a personal nginx — and a good number of them send no CORS headers at
// all. Two consequences, and both are load-bearing:
//
//   - The `<img>` is loaded with `crossOrigin = 'anonymous'`. Without it the
//     draw succeeds, the canvas is silently *tainted*, and the failure only
//     surfaces later as a SecurityError thrown out of `texImage2D` — that is,
//     inside the render loop, one frame after the picture arrived.
//   - With it, a host that sends no headers fails the load outright. That is
//     not a broken profile and must not look like one, so every avatar is
//     painted as a coloured initial disc *first* and only upgrades itself if
//     the fetch works. Nothing ever waits on a picture to draw a frame.
//
// The texture object is created once and mutated in place. Swapping the map on
// a live material every time a picture lands would leak a texture per tank per
// round; repainting the same canvas and setting `needsUpdate` does not.

import * as THREE from 'three'

/** Texture edge, in pixels. Two tanks' worth of these is nothing; forty is. */
const SIZE = 256

/**
 * One entry per picture URL, shared by every tank that shows it.
 *
 * `null` means "we tried and it did not load" — cached exactly like a success,
 * so a host with no CORS headers is asked once per session rather than once per
 * time the player respawns with a new rig.
 */
const images = new Map<string, Promise<HTMLImageElement | null>>()

function loadImage(url: string): Promise<HTMLImageElement | null> {
  const held = images.get(url)
  if (held) return held
  const attempt = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.referrerPolicy = 'no-referrer'
    img.onload = () => resolve(img.naturalWidth > 0 ? img : null)
    img.onerror = () => resolve(null)
    // A profile host that never answers must not hold a slot forever.
    setTimeout(() => resolve(null), 12_000)
    img.src = url
  })
  images.set(url, attempt)
  return attempt
}

/**
 * The letters on a fallback disc.
 *
 * A player with no picture is usually showing a short npub, and "NP" for all
 * four of them is worse than useless. Skip the `npub1` prefix so the two
 * characters shown are the ones that actually differ between accounts.
 */
export function initials(name: string): string {
  const trimmed = name.trim()
  const body = /^npub1/i.test(trimmed) ? trimmed.slice(5) : trimmed
  const letters = body.replace(/[^a-z0-9]/gi, '')
  if (!letters) return '??'
  const words = body.split(/[\s_.-]+/).filter((w) => /[a-z0-9]/i.test(w))
  if (words.length > 1) {
    return (words[0][0] + words[1][0]).toUpperCase()
  }
  return letters.slice(0, 2).toUpperCase()
}

/**
 * One tank's face. Owned by the rig, repainted only when something changes.
 *
 * `set()` is called every frame from the draw loop, so the first thing it does
 * is compare a key. Everything after that line runs at most once per identity.
 */
export class Avatar {
  readonly texture: THREE.CanvasTexture
  private canvas: HTMLCanvasElement
  private key = ''
  private hue = 0
  /** The loaded picture, once one has arrived. Kept so a hue change can repaint. */
  private image: HTMLImageElement | null = null
  /** Bumped per `set()`; a picture that lands after the identity changed is dropped. */
  private generation = 0

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.canvas.height = SIZE
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.anisotropy = 4
  }

  /** Point this avatar at an identity. Cheap to call every frame. */
  set(name: string, picture: string | null, hue: number): void {
    const key = `${name}|${picture ?? ''}|${Math.round(hue)}`
    if (key === this.key) return
    this.key = key
    this.hue = hue
    const generation = ++this.generation

    // The picture may already be in hand from another tank showing the same
    // npub, or from this tank before its colour changed. Repaint from it
    // synchronously rather than flashing the initials disc for a frame.
    this.image = null
    this.paint(name)
    if (!picture) return

    void loadImage(picture).then((img) => {
      if (!img || generation !== this.generation) return
      this.image = img
      this.paint(name)
    })
  }

  private paint(name: string): void {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    const mid = SIZE / 2
    // Room for the ring and the ink line outside the picture itself.
    const radius = mid - 18

    ctx.clearRect(0, 0, SIZE, SIZE)
    ctx.save()
    ctx.beginPath()
    ctx.arc(mid, mid, radius, 0, Math.PI * 2)
    ctx.closePath()
    ctx.clip()

    const img = this.image
    if (img) {
      // Cover, not contain: a portrait avatar letterboxed inside a circle looks
      // like a mistake, and every one of these is a face near the middle.
      const scale = Math.max((radius * 2) / img.naturalWidth, (radius * 2) / img.naturalHeight)
      const w = img.naturalWidth * scale
      const h = img.naturalHeight * scale
      ctx.drawImage(img, mid - w / 2, mid - h / 2, w, h)
    } else {
      ctx.fillStyle = `hsl(${this.hue}, 58%, 44%)`
      ctx.fillRect(0, 0, SIZE, SIZE)
      ctx.fillStyle = 'rgba(255,255,255,0.92)'
      ctx.font = '700 118px ui-monospace, Menlo, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(initials(name), mid, mid + 6)
    }
    ctx.restore()

    // The player colour, worn as a ring. This is the part that has to survive
    // being 40 pixels tall on a television across the room — the picture inside
    // it is flavour, the ring is the thing you actually track in a scramble.
    ctx.lineWidth = 20
    ctx.strokeStyle = `hsl(${this.hue}, 80%, 56%)`
    ctx.beginPath()
    ctx.arc(mid, mid, radius + 8, 0, Math.PI * 2)
    ctx.stroke()

    // Same near-black outline the tanks wear, so a face reads as part of the
    // toy rather than as a photograph pasted over it.
    ctx.lineWidth = 8
    ctx.strokeStyle = '#141a26'
    ctx.beginPath()
    ctx.arc(mid, mid, radius + 21, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(mid, mid, radius - 1, 0, Math.PI * 2)
    ctx.stroke()

    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }
}
