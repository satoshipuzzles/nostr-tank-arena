# Nostr Tank Arena

Four-player top-down tank deathmatch with **no game server**. Your npub is your
identity, Nostr relays are the netcode, and your score is an event you signed
yourself.

Slow shells, 3 hits to kill, cover you can hide behind, instant respawn.

## Why tanks and not an arena FPS

Because relays are not a rollback netcode fabric and pretending otherwise ships a
game that feels broken on the first test.

Round-trip through a public relay is realistically 120–350ms. In a twitch FPS
that is a stutter and you blame the game. Here shells travel at 430 px/s while
tanks move at 175 px/s, so at 250ms of latency the correct play is to *lead your
target by about a tank length* — the same thing you would do with zero latency.
The transport delay lands inside the skill you were already exercising instead of
fighting it.

The arena FPS is the next build. This one proves the netcode stack first.

## Play

```bash
npm install
npm run dev
```

Open the URL, pick a room, hit **Play as guest** or **Play with my npub**. Share
the link — the room is in the query string. Everyone on the same room tag sees
each other.

**Controls** — `WASD` or arrows to drive, mouse to aim, click or `Space` to fire.
Gamepad: left stick drives, right stick aims, right trigger or `A` fires. It
plays fine on a TV browser with a controller, which is the point.

## Protocol

Everything travels as Nostr events. High-frequency data uses **ephemeral kinds**
(20000–29999): relays forward them and store nothing, which is exactly right for
tick data. Every event carries `["t", "tankarena-<room>"]`, so one `#t` filter
subscribes you to an entire match.

| Kind | Name | Storage | Signed by | Content |
|------|------|---------|-----------|---------|
| `21003` | session attestation | ephemeral | **real npub** | `{ s, name, color, exp }` |
| `21000` | tank state tick | ephemeral | session key | `{ t, x, y, h, g, hp, d }` |
| `21001` | shell fired | ephemeral | session key | `{ id, t0, x, y, a }` |
| `21002` | death report | ephemeral | session key | `{ t, k, x, y }` |
| `30078` | score record | addressable (NIP-78) | **real npub** | `{ kills, deaths, room, at }` |

Field key: `s` session pubkey, `t`/`t0` sender clock in ms, `h` hull heading,
`g` gun heading, `d` dead flag, `a` shell angle, `k` killer's session pubkey
(`null` for a self-destruct). Angles are radians, positions are arena pixels in a
1600×1200 space. Score records use `d` tag `nostr-tank-arena/score`.

### Two keys per player

A player has a **real key** (NIP-07 extension, or a throwaway generated in the
tab for guests) and a **session key** generated fresh on load.

The real key signs exactly twice per match: once to attest the session key, once
to publish a score. The session key signs the ~10Hz tick traffic. Routing every
position update through a browser extension would mean an approval dialog per
frame, so the session key does that work and the attestation — signed by the real
npub, naming the session pubkey — ties it back. A tank whose attestation has not
arrived yet renders with a `?` after its name.

The session key never leaves memory and dies with the tab.

### What each client trusts

- **Your own tank** is authoritative for its position and HP.
- **Shells** are authoritative from the shooter, but only as "fired from (x, y)
  at angle a at time t0". Every client re-simulates the flight path itself
  against the same static geometry, so nobody streams projectile positions.
- **A kill only counts when the victim signs a death event.** You cannot claim a
  kill. You can only be told that you died.

Remote tanks render 130ms in the past so there are always two samples to
interpolate between, with a short extrapolation window before they freeze. Peer
clock offsets are estimated as the minimum observed `ourNow - theirStamp`.

Hits on *other* people's tanks are computed locally too, but only to remove the
shell so it does not visually sail through someone. Their HP always comes from
their own state tick.

## How to cheat this

Written down rather than assumed, because "signed" is not the same as "true".

1. **Refuse to die.** Nothing forces you to publish a death event. A patched
   client can take hits and never report them. This is the big one, and it is
   inherent to victim-authoritative hit detection with no referee. What it buys
   is that the *opposite* cheat — claiming kills you did not get — is impossible.
2. **Teleport.** Position ticks are self-reported. A modified client can put its
   tank anywhere. Peers do not currently reject implausible movement.
3. **Forge a leaderboard entry.** The score record is just a signed claim of a
   number. Anyone can publish `{ kills: 9999 }` from their own npub. The
   leaderboard is a wall of self-reported scores, and the UI says so.
4. **Rapid fire.** Reload is enforced client-side only.

Fixes exist and each costs something real. Movement plausibility checks (max
speed between ticks) are cheap and would land 1 and 2 partway. Making kills
require a *countersigned* exchange between shooter and victim closes 1 properly
but adds a round trip to every hit. Trustworthy leaderboards need either a
witness that watched the match or per-match records that peers countersign —
that is the version worth building next, and it belongs to a mode with an entry
fee, not a casual room.

Nothing here moves sats. When wagers land they will be zap-based, non-custodial,
and confirmed per action.

## Relays

Defaults are `relay.damus.io`, `nos.lol`, `relay.primal.net`, `relay.nostr.band`.
Override them in the lobby under **Relays**.

Honest warning: public relays rate-limit, and a busy one will drop tick events
and make tanks stutter. A relay you control on a machine near your players will
always feel better. The game publishes 10 state events per second per player,
which is polite by game standards and rude by relay standards.

## Layout

```
src/arena.ts     static geometry, collision, spawn points
src/sim.ts       tank and shell physics, all the feel constants
src/game.ts      netcode: subscribe, interpolate, hit detection, authority
src/nostr.ts     identity (real key + session key) and relay pool
src/protocol.ts  wire format for every custom kind
src/render.ts    canvas 2D
src/scores.ts    signed score records and the leaderboard query
src/main.ts      lobby, HUD, game loop
test/two-player.mjs  headless two-browser smoke test against live relays
```

## Tuning

Every number that decides how the game feels is at the top of `src/sim.ts`:
speeds, turn rates, shell velocity, reload, respawn delay, HP. Time-to-kill is
three shells at a 1.05s reload, so a clean duel is about 3 seconds of hits inside
a longer fight for position.

## License

MIT.
