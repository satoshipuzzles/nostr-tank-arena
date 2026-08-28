// Bundle entry for test/pads.mjs — re-exports the pure modules under test so
// esbuild can hand them to node without dragging three.js in.
export * from '../src/arena'
export * from '../src/pickups'
// Pure like the others: flags derives everything from arena, and the bundle
// needs `baseFor` so the board sweep can ask where the CTF flags stand.
export * from '../src/flags'
// `sim.ts` re-exports WALLS from arena, so it goes last and wins the name; the
// two bindings are the same array either way.
export * from '../src/sim'
