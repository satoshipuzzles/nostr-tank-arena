/**
 * What every key does, in one place, for the settings screen to print.
 *
 * The driving half is **derived** from `DRIVE_KEYS` in `input.ts` — the table
 * the game actually reads — so a rebind changes the reference by construction.
 * The other half cannot be: the global hotkeys are `window` listeners spread
 * through `main.ts`, each testing its own `e.code`, and there is no table to
 * read. So `GAME_KEYS` is a declaration, and `test/settings.mjs` holds it
 * honest by checking every code in it against the source that handles it, in
 * both directions. A reference nothing can falsify is a comment.
 */

import { DRIVE_KEYS, type Binding } from './input'

/** A key as a player would say it out loud. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return `num ${code.slice(6).toLowerCase()}`
  switch (code) {
    case 'ArrowUp': return '↑'
    case 'ArrowDown': return '↓'
    case 'ArrowLeft': return '←'
    case 'ArrowRight': return '→'
    case 'Space': return 'Space'
    case 'Enter': return 'Enter'
    case 'ShiftRight': return 'Right shift'
    case 'BracketLeft': return '['
    case 'BracketRight': return ']'
    case 'Slash': return '/'
    case 'Period': return '.'
    default: return code
  }
}

export interface KeyRow {
  action: string
  keys: string[]
}

/** The order they are worth reading in, which is not the order they are stored. */
const DRIVE_ORDER: { key: keyof (typeof DRIVE_KEYS)['both']; action: string }[] = [
  { key: 'up', action: 'Forward' },
  { key: 'down', action: 'Reverse' },
  { key: 'left', action: 'Turn left' },
  { key: 'right', action: 'Turn right' },
  { key: 'fire', action: 'Fire' },
  { key: 'lob', action: 'Lob (hold to charge)' },
  { key: 'reload', action: 'Reload' },
]

/** The driving keys for one player's binding, read off the real table. */
export function drivingKeys(keys: Binding['keys']): KeyRow[] {
  const set = DRIVE_KEYS[keys]
  return DRIVE_ORDER.map(({ key, action }) => ({ action, keys: set[key].map(keyLabel) }))
}

/**
 * Everything that is not driving, and where it is handled.
 *
 * `where` is not decoration — it is what the suite greps, so a hotkey that
 * moves file has to be corrected here rather than quietly becoming a lie.
 */
export const GAME_KEYS: { code: string; action: string; where: string }[] = [
  { code: 'KeyV', action: 'Board view or cockpit', where: 'src/main.ts' },
  { code: 'KeyM', action: 'Sound on or off', where: 'src/main.ts' },
  { code: 'KeyB', action: 'Practice tanks on or off', where: 'src/main.ts' },
  { code: 'BracketLeft', action: 'One fewer practice tank', where: 'src/main.ts' },
  { code: 'BracketRight', action: 'One more practice tank', where: 'src/main.ts' },
  { code: 'KeyT', action: 'Pick a side', where: 'src/main.ts' },
]

/**
 * The digits, which are one rule rather than nine bindings.
 *
 * Handled by a `/^Digit([1-9])$/` match, so they are declared as a range and
 * the suite checks for that regex rather than for nine literals.
 */
export const DIGIT_KEYS = {
  label: '1 – 9',
  action: 'Spend a kill-streak reward, or pick a corner for a strike',
  pattern: 'Digit([1-9])',
  where: 'src/main.ts',
}

/**
 * What a gamepad does, with the button index it is read at.
 *
 * There is no table to derive this from — `Input.readPad` tests buttons by
 * index inline — so the index is carried here and `test/settings.mjs` checks
 * each one appears in `src/input.ts`. Naming X and A as well as the numbers is
 * for the player; the numbers are what can be falsified.
 */
export const PAD_KEYS: { action: string; keys: string[]; buttons: number[] }[] = [
  { action: 'Drive', keys: ['Left stick'], buttons: [] },
  { action: 'Aim', keys: ['Right stick'], buttons: [] },
  { action: 'Fire', keys: ['Right trigger', 'A', 'RB'], buttons: [7, 0, 5] },
  { action: 'Lob (hold to charge)', keys: ['Left trigger', 'LB'], buttons: [6, 4] },
  { action: 'Reload', keys: ['X or Square'], buttons: [2] },
]
