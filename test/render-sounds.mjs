// Render every voice, in order, into one WAV so a human can just listen.
import { existsSync, writeFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TANK_URL ?? 'http://localhost:4183/'
const exe = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome']
  .find((p) => existsSync(p))
const b = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] })
const p = await b.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__voices)

const { samples, sampleRate, order } = await p.evaluate(async () => {
  const sr = 48000
  const order = Object.keys(window.__voices)
  // Half a second of air between each so they are distinguishable by ear.
  const gap = 0.5
  const ctx = new OfflineAudioContext(1, sr * 30, sr)
  let t = 0.3
  for (const name of order) {
    const end = window.__voices[name](ctx, ctx.destination, t)
    t = end + gap
  }
  const buf = await ctx.startRendering()
  const d = buf.getChannelData(0)
  const cut = Math.min(d.length, Math.ceil((t + 0.3) * sr))
  return { samples: Array.from(d.slice(0, cut)), sampleRate: sr, order }
})
await b.close()

// 16-bit mono PCM WAV.
const n = samples.length
const buf = Buffer.alloc(44 + n * 2)
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24)
buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
for (let i = 0; i < n; i++) {
  const v = Math.max(-1, Math.min(1, samples[i]))
  buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
}
writeFileSync('/tmp/tank-arena-sounds.wav', buf)
console.log(`wrote /tmp/tank-arena-sounds.wav  ${(n / sampleRate).toFixed(1)}s  order: ${order.join(' → ')}`)
