// Bundle entry for test/pads.mjs — re-exports the pure modules under test so
// esbuild can hand them to node without dragging three.js in.
export * from '../src/arena'
export * from '../src/pickups'
