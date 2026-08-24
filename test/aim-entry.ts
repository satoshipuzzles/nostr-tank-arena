// Bundle entry for test/aim.mjs — the two pure pieces of the aiming path, with
// no browser under them. `input.ts` only touches the DOM from inside the class,
// so importing it here costs nothing.
export { stick } from '../src/input'
export * from '../src/sim'
