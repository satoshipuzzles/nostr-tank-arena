// Canvas 2D, whole arena on screen at once. No camera scroll: everybody sees
// the same board, which is the couch-multiplayer feel even when the four
// players are on four different continents.

import { ARENA_H, ARENA_W, WALLS } from './arena'
import type { Game } from './game'
import { MAX_HP, RELOAD, TANK_RADIUS } from './sim'

export class Renderer {
  private ctx: CanvasRenderingContext2D
  private scale = 1
  private offX = 0
  private offY = 0

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d unavailable')
    this.ctx = ctx
    this.resize()
    window.addEventListener('resize', this.resize)
  }

  private resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.scale = Math.min(w / ARENA_W, h / ARENA_H) * dpr
    this.offX = (this.canvas.width - ARENA_W * this.scale) / 2
    this.offY = (this.canvas.height - ARENA_H * this.scale) / 2
  }

  /** Screen (client) coordinates to arena coordinates, for mouse aim. */
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    const dpr = this.canvas.width / r.width
    return {
      x: ((clientX - r.left) * dpr - this.offX) / this.scale,
      y: ((clientY - r.top) * dpr - this.offY) / this.scale,
    }
  }

  draw(game: Game): void {
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#07090f'
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offX, this.offY)

    this.drawFloor()
    this.drawWalls()

    for (const peer of game.peers.values()) {
      this.drawTank(
        peer.view.x,
        peer.view.y,
        peer.view.hull,
        peer.view.gun,
        peer.displayColor,
        peer.view.hp,
        peer.view.dead,
        peer.name,
        peer.pubkey !== null,
        false,
      )
    }

    const t = game.tank
    this.drawTank(t.x, t.y, t.hull, t.gun, game.displayColor, t.hp, t.dead, game.name, true, true)

    for (const s of game.shells.values()) {
      const mine = s.owner === game.identity.sessionPubkey
      ctx.beginPath()
      ctx.arc(s.x, s.y, 5, 0, Math.PI * 2)
      ctx.fillStyle = mine ? '#ffe8a3' : '#ff9a6b'
      ctx.shadowColor = mine ? '#ffc44d' : '#ff6b3d'
      ctx.shadowBlur = 16
      ctx.fill()
      ctx.shadowBlur = 0
    }

    if (!t.dead) this.drawReload(t.x, t.y, t.reloadAt)
  }

  private drawFloor(): void {
    const ctx = this.ctx
    ctx.fillStyle = '#0d1119'
    ctx.fillRect(0, 0, ARENA_W, ARENA_H)
    ctx.strokeStyle = 'rgba(90,150,200,0.07)'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let x = 0; x <= ARENA_W; x += 80) {
      ctx.moveTo(x, 0)
      ctx.lineTo(x, ARENA_H)
    }
    for (let y = 0; y <= ARENA_H; y += 80) {
      ctx.moveTo(0, y)
      ctx.lineTo(ARENA_W, y)
    }
    ctx.stroke()
  }

  private drawWalls(): void {
    const ctx = this.ctx
    for (const w of WALLS) {
      ctx.fillStyle = '#1b2433'
      ctx.fillRect(w.x, w.y, w.w, w.h)
      ctx.strokeStyle = '#31435c'
      ctx.lineWidth = 3
      ctx.strokeRect(w.x + 1.5, w.y + 1.5, w.w - 3, w.h - 3)
    }
  }

  private drawTank(
    x: number,
    y: number,
    hull: number,
    gun: number,
    hue: number,
    hp: number,
    dead: boolean,
    name: string,
    verified: boolean,
    isYou: boolean,
  ): void {
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = dead ? 0.25 : 1

    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(hull)
    // Treads.
    ctx.fillStyle = `hsl(${hue} 30% 22%)`
    ctx.fillRect(-22, -20, 44, 8)
    ctx.fillRect(-22, 12, 44, 8)
    // Hull.
    ctx.fillStyle = dead ? '#3a3f47' : `hsl(${hue} 62% 48%)`
    ctx.fillRect(-20, -13, 40, 26)
    ctx.strokeStyle = `hsl(${hue} 70% 74%)`
    ctx.lineWidth = 2
    ctx.strokeRect(-20, -13, 40, 26)
    ctx.restore()

    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(gun)
    ctx.fillStyle = dead ? '#2c3038' : `hsl(${hue} 55% 32%)`
    ctx.fillRect(0, -4.5, 36, 9)
    ctx.beginPath()
    ctx.arc(0, 0, 11, 0, Math.PI * 2)
    ctx.fillStyle = dead ? '#3a3f47' : `hsl(${hue} 60% 58%)`
    ctx.fill()
    ctx.restore()

    if (isYou && !dead) {
      ctx.beginPath()
      ctx.arc(x, y, TANK_RADIUS + 8, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth = 2
      ctx.stroke()
    }

    // HP pips above the tank.
    if (!dead) {
      const total = MAX_HP
      const w = 10
      const gap = 3
      const startX = x - (total * w + (total - 1) * gap) / 2
      for (let i = 0; i < total; i++) {
        ctx.fillStyle = i < hp ? `hsl(${hue} 80% 62%)` : 'rgba(255,255,255,0.16)'
        ctx.fillRect(startX + i * (w + gap), y - TANK_RADIUS - 20, w, 5)
      }
    }

    ctx.globalAlpha = dead ? 0.4 : 1
    ctx.font = '600 15px ui-monospace, Menlo, monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = verified ? '#dfe8f5' : '#8d97a8'
    ctx.fillText(verified ? name : name + ' ?', x, y + TANK_RADIUS + 22)
    ctx.restore()
  }

  private drawReload(x: number, y: number, reloadAt: number): void {
    const remaining = reloadAt - performance.now()
    if (remaining <= 0) return
    const frac = 1 - remaining / (RELOAD * 1000)
    const ctx = this.ctx
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    ctx.fillRect(x - 22, y + TANK_RADIUS + 28, 44, 5)
    ctx.fillStyle = '#ffc44d'
    ctx.fillRect(x - 22, y + TANK_RADIUS + 28, 44 * frac, 5)
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize)
  }
}
