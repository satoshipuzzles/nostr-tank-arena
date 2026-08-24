// Bundle entry for test/icons.mjs — the six pickup icons, alone on a page.
//
// The gem is the one object in the game with a *job*: be identified from across
// the arena. That makes its silhouette a correctness property, not decoration,
// and a silhouette is only checkable in pixels.
import * as THREE from 'three'
import { pickupGeometry } from '../src/render'
import { ICON_POLYS, PICKUPS, type PickupKind } from '../src/pickups'

const KINDS = Object.keys(ICON_POLYS) as PickupKind[]

// `preserveDrawingBuffer` because the harness reads the frame back with
// `readPixels` after the render has been presented. Without it the buffer is
// cleared and every icon measures as zero lit pixels — which fails loudly
// rather than passing wrongly, but it fails for the wrong reason.
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true })
renderer.setSize(180 * KINDS.length, 180)
document.body.style.margin = '0'
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x000000)
scene.add(new THREE.AmbientLight(0xffffff, 3))

// Orthographic and face-on, so a pixel count is a silhouette and not a
// perspective foreshortening of one.
const CELL = 120
const camera = new THREE.OrthographicCamera(
  0, CELL * KINDS.length, CELL / 2, -CELL / 2, -500, 500,
)
camera.position.z = 200

KINDS.forEach((kind, i) => {
  const mesh = new THREE.Mesh(
    pickupGeometry(kind),
    // Flat white: the test is about shape, and a hue would make the threshold
    // a question about brightness.
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  )
  mesh.position.x = CELL * (i + 0.5)
  scene.add(mesh)
})

renderer.render(scene, camera)

// What the harness reads back: for each cell, the fraction of its bounding box
// that is lit. A correct icon is a silhouette with gaps; a shape that has
// collapsed to its own bounding rectangle reads ~1.0.
;(window as unknown as { __iconFill: () => Record<string, number> }).__iconFill = () => {
  const gl = renderer.getContext()
  const w = renderer.domElement.width
  const h = renderer.domElement.height
  const px = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
  const out: Record<string, number> = {}
  const scale = w / (CELL * KINDS.length)
  KINDS.forEach((kind, i) => {
    const x0 = Math.round(CELL * i * scale)
    const x1 = Math.round(CELL * (i + 1) * scale)
    let lit = 0
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9
    for (let y = 0; y < h; y++) {
      for (let x = x0; x < x1; x++) {
        if (px[(y * w + x) * 4] > 40) {
          lit++
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    const box = lit ? (maxX - minX + 1) * (maxY - minY + 1) : 0
    out[kind] = box ? lit / box : 0
    // `readPixels` reads bottom-up and the cells are laid out left to right, so
    // the vertical flip does not affect a per-cell fill fraction.
  })
  return out
}

;(window as unknown as { __iconHues: Record<string, number> }).__iconHues =
  Object.fromEntries(KINDS.map((k) => [k, PICKUPS[k].hue]))
