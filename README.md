# Nostr Tank Arena

Four-player tank deathmatch on a board, with **no game server**. Your npub is
your identity, Nostr relays are the netcode, and your score is an event you
signed yourself.

Slow shells, 3 hits to kill, cover you can hide behind, instant respawn.

## Rounds are Bitcoin blocks

A round lasts one block. That is not decoration — it is the only round timer
available to a game with no server. Every client discovers the same height at
roughly the same moment, nobody is the host, nobody broadcasts "round over",
and a player who joins halfway through knows exactly which round they are in.

When the tip moves:

1. the round ends and a podium shows the standings,
2. scores reset to zero,
3. **the map changes** — the board is `blockHash % 4`, so every client
   generates the same arena from the same number with no message passing at
   all. Four boards ship: Crossroads, The Lanes, Pillars, The Ring.

Publishing a result writes an addressable record whose `d` tag carries the
block height, so there is one signed record per player per round, and a `t` tag
of `tankblock-<height>` so a whole round's results are a single `#t` query.
Only single-letter tags are indexed by relays, which is why the height is not
in a `["block", ...]` tag where it would look right and be unqueryable.

The chain tip comes from a block explorer over HTTPS (mempool.space, with
blockstream.info as a second opinion; `?blocks=https://your.node/api` overrides
both). What that trusts is worth saying plainly: an explorer that is wrong or
offline means the round simply never ends and the default map stays up, and an
explorer that lies shifts *when* rounds flip for everyone reading it rather
than desynchronising anybody. It cannot touch the simulation, hit detection or
scores.

## Kill streaks and repairs

- Three kills without dying repairs your hull to full.
- Eight seconds without taking a hit gives one hull point back.

Both are self-authoritative, which is the point: your own HP is already the one
number this client decides, so neither needed a new event kind, a new trust
assumption, or agreement with anybody. They ride out in the next state tick like
any other HP change. `Game.regenAfter` is the knob.

## The board

The arena renders in three.js: a chunky toy board in daylight, plastic tanks
with real shadows, and confetti when somebody goes down.

The camera never scrolls. Everybody sees the whole board at once, the way four
people see the same television — that is the couch-multiplayer feel this game is
built around, and it is unchanged from the 2D version.

The simulation is still two-dimensional and stays that way. Arena `(x, y)` maps
to world `(x, height, y)`, so nothing in `sim.ts`, `arena.ts` or the netcode had
to learn about a third axis; `render.ts` is the only file that knows the game is
drawn in 3D at all. Effects are derived by diffing state between frames rather
than by adding callbacks to the game — a shell id that is new means somebody
fired, an id that vanished means it hit something, a tank that flipped to dead
means confetti.

Two things worth knowing:

- **Aim is a ray, not a divide.** The cursor is unprojected through the camera
  onto a horizontal plane at turret height, so pointing at a tank aims at that
  tank rather than at the ground behind it.
- **The renderer gives up quality on a slow device, on purpose.** `main.ts`
  clamps the simulation step to 50ms so a backgrounded tab cannot teleport
  everybody on return — which means a client rendering at 5fps also *simulates*
  at a quarter speed, and its tank crawls while everyone else's moves normally.
  So a sustained frame time over 30ms drops shadows and the pixel ratio, one way,
  once. Playing at the same speed as everyone else beats a prettier board.

WebGL is now required. A browser that cannot open a context says so in words
rather than failing into a black screen.

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
plays fine on a TV browser with a controller, which is the point. `M` mutes.

Two steering schemes, switchable in the lobby. **Direct** (the default) reads the
keys or the stick as a *direction on the board*: press up-left and the tank turns
toward up-left and goes. **Tank** is the classic one — `A`/`D` rotate the hull,
`W`/`S` drive it. Direct is the default because tank controls are the thing
everybody bounced off; you spend your first minute pointing the wrong way instead
of shooting anybody. The hull still physically rotates at `TURN_RATE` either way,
so a tank still feels heavy — only the input changes.

## Protocol

Everything travels as Nostr events. High-frequency data uses **ephemeral kinds**
(20000–29999): relays forward them and store nothing, which is exactly right for
tick data. Every event carries `["t", "tankarena-<room>"]`, so one `#t` filter
subscribes you to an entire match.

| Kind | Name | Storage | Signed by | Content |
|------|------|---------|-----------|---------|
| `21003` | session attestation | ephemeral | **real npub** | `{ s, name, color, exp }` |
| `21000` | tank state tick | ephemeral | session key | `{ t, x, y, h, g, hp, d, k? }` |
| `21001` | shell fired | ephemeral | session key | `{ id, t0, x, y, a, b? }` |
| `21002` | death report | ephemeral | session key | `{ t, k, x, y }` |
| `30078` | score record | addressable (NIP-78) | **real npub** | `{ kills, deaths, room, at }` |
| `30078` | pickup claim | addressable (NIP-78) + NIP-40 | session key | `{ id, kind, at }` |

Field key: `s` session pubkey, `t`/`t0` sender clock in ms, `h` hull heading,
`g` gun heading, `d` dead flag, `k` kills in a row, `a` shell angle, `b` the
shell's bounce budget, `k` on a death report is the killer's session pubkey
(`null` for a self-destruct). Angles are radians, positions are arena pixels — the
board size is per-layout and lives in `ARENA_W`/`ARENA_H`. Score records use `d`
tag `nostr-tank-arena/score`; the per-block record uses
`nostr-tank-arena/score/<height>`, and a pickup claim uses
`nostr-tank-arena/claim/<blockhash-prefix>:<wave>:<pad>:<claimant>`.

Two of those fields are new and both are riders on events that were already
going out, which is the cheapest place to put anything.

`k` on the state tick is your current kill streak. A streak that only shows in
your own HUD is not a streak — it is a number. On the wire, everyone can see the
rainbow ring around the tank that is on a run and decide to do something about
it. It is exactly as trustworthy as the `hp` beside it: self-reported, and always
was.

`b` on the fire event is the shell's bounce budget, and it travels with the shell
rather than being read from the current round's rules when the event arrives.
Otherwise a shell fired seconds before a block landed would bounce once on the
shooter's screen and three times on everybody else's for as long as the boundary
took to settle.

### Pickups, and why the claim is stored rather than ephemeral

A pickup's pad, its type and its spawn time are a pure function of the block hash
and the round clock, so every client computes the same schedule from a number it
already has. Nothing is announced and nothing is voted on. Only the *claim* is
published.

That claim is a **stored** event with a NIP-40 `expiration`, not an ephemeral one.
Relays forward ephemeral events only to whoever is connected at that instant and
cannot be asked for them afterwards, so a client that joined 200ms later would
drive over a shield that is already gone. A stored claim can be `REQ`ed by a late
joiner, and the expiration means the relay drops the litter on schedule.

Nothing here is ordered by `created_at`, because the publisher picks it. A
simultaneous double-grab is resolved by not resolving it: both players get the
pickup. The window is one relay round trip, and a party game that occasionally
hands two people a shield is better than one where grabbing an item stalls for
200ms while the network decides. The `d` tag includes the claimant so two claims
for the same pad coexist instead of overwriting each other — a relay keeping only
the last one would be silently picking a winner, which is exactly the hidden
authority this game does not want.

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

## Relays, and what they actually accept

A tick stream is **10 events per second per player**, and most public relays cap
a key far below that. This was invisible until the client started reading the
`OK` frames it gets back: the old `publish()` did `p.catch(() => {})` on every
relay promise, so `["OK", <id>, false, "rate-limited: ..."]` was indistinguishable
from success, and a dropped tick looked like a laggy opponent.

With that fixed, a live game on the relays this project shipped with was having
**69.8% of its publishes rejected**:

| relay | verdict |
|-------|---------|
| `relay.damus.io` | `rate-limited: you are noting too much`, and 503 on the day |
| `nos.lol` | `pow: 28 bits needed` — NIP-13 proof of work, which a position tick will never pay |
| `relay.nostr.band` | connection timeouts, no `OK` frame either way |
| `relay.primal.net` | fine |

So the defaults were re-measured rather than re-guessed. `.scratch/relay-probe.mjs`
sends 400 ephemeral kind-21000 events at 10Hz — forty seconds of one player's
tick stream — and counts the `OK` frames:

```
relay.primal.net          400/400 accepted
purplerelay.com           400/400
relay.fountain.fm         400/400
relay.mostr.pub           250/250
relay.nostr.net            60/400   rate-limited: too many events from this key (60/60s)
nostr-pub.wellorder.net    13/400   blocked: spam not permitted
nostr21.com                 0/250
relay.nostrplebs.com        0/250   blocked: you do not have a Nostr Plebs NIP-05
nostr.land                  0/250   restricted: pay for access
relay.nostr.wirednet.jp       —     blocked: ephemeral kind range 21000
```

One of these is a lesson on its own. `nostr.mom` took 400/400 from Node and
then demanded 28-bit proof of work from a browser, twice — so the probe was
re-run *from a page*, which is the only environment this game has. Measure
where the thing actually runs.

The first four are the defaults now, and the same game measures **0% rejected**.

Two things follow from this and both are in the client:

- The status panel names any relay that is refusing events, in the relay's own
  words. "Why is everyone teleporting" now has an answer on screen.
- A relay that refuses fifteen in a row is dropped from the publish set for the
  session. It has a policy, not a bad minute, and continuing to send it ten
  events a second delays the relays that are listening. Subscriptions stay open:
  refusing our events says nothing about whether it forwards somebody else's.

**Run your own relay if you care about this** — but do not assume "my relay"
means "no limit". It means the limit is yours to set, and the defaults are
*lower* than the public relays measured above.

[cowboy](https://code.relay.tools/opensauce/newlay), who wrote newlay, walked
through the traps. Recording them here so nobody has to rediscover them:

- newlay's built-in default `publishing_rate_limit` is **60 events/min**, and the
  docker-compose quickstart sets `[tier.anon]` to **30**. One player at 10Hz needs
  **600**. Boot the quickstart, point the game at it, and you would measure worse
  rejection than the public relays and conclude your own relay was junk.
- `messages_per_min` is a **separate** cap on inbound frames (default 240). It
  bites independently even with the rate limit raised.
- newlay scores each connection's behaviour and **multiplies your rate limits by
  it**: a rate hit is −2, a rejected event is −4, and below 15 you are at 0.1× of
  whatever you configured. A client that overruns the cap gets its cap lowered,
  which makes it overrun again. That is the same invisible-degradation shape as
  the swallowed OK frames above, self-inflicted. Pin it off on a game tier.
- `[ip_gate]` is per-**IP** and shared across every socket from it, defaulting to
  600 events/min — exactly one 10Hz player. Two people on one wifi, or local
  split-screen, and the second player degrades while the first does not, which
  reads as "their client is broken".

A tier that actually carries four players at 10Hz:

```toml
[tier.anon]
rank = 0
can_read = true
can_write = true
publishing_rate_limit = 1800     # default 60. 10Hz = 600; the rest is burst headroom
filter_rate_limit = 300
messages_per_min = 3000          # default 240. Separate cap, bites independently
bytes_in_per_min = 8388608       # default 1 MiB; ~600B/event x 600/min is close
max_subscriptions = 40
max_filters = 20
min_pow_difficulty = 0           # no nos.lol 28-bit surprise
created_at_msecs_ago = 10000     # narrows the backdating window on a relay you control
created_at_msecs_ahead = 5000
behavior_multiplier = { min = 1.0, max = 1.5 }   # pins the throttle spiral off

[ip_gate]
max_connections_per_ip = 64
events_per_min_per_ip = 20000    # default 600 = one player. Kills couch play
```

`accepted_event_kinds` defaults to empty, meaning all kinds, so ephemeral 21000
just works and NIP-40 expirations are honoured — both of which this game needs.
Do **not** enable `[buzz]` (that is channel/git hosting, not a game relay) and do
**not** turn on `[wot] gate_writes`, which would silently reject every player
outside your follow graph.

The `created_at` bound only binds on a relay you control; a cheater can publish
anywhere. It narrows the window, it does not replace an honest design.

[feeds.relay.tools](https://feeds.relay.tools) will host one with those caps. Put
yours first in the Relays box and leave the public ones in as genuine peers, not
cold standby — one relay is one point of failure, and you want events landing on
more than one box the first time yours reboots.

## One rule change per block

The block hash already picks the map. It is a 256-bit number that every client
discovers at the same moment and nobody controls, so it can equally pick *how the
round plays* — and that is free variety: no new event kind, no announcement, no
host, no vote. Two clients agree on the rules for exactly the same reason they
agree on the geometry. A different two hex digits than the map selection uses, so
a board you know well can still surprise you.

| Rules | What changes |
|-------|--------------|
| Straight Deathmatch | Nothing. The default, and it gets no billboard. |
| Glass Cannon | One hit kills. Respawns are quick. |
| Overdrive | Everyone drives 40% faster and reloads 35% faster. |
| Supply Run | Pickup waves every 9 seconds, and every pad is stocked. |
| Ricochet | Shells bounce three times instead of once. |

A modifier is only allowed to touch things a client already decides for itself.
HP, reload, speed and respawn are local — your own tank has always been
authoritative over them — and the pickup schedule is derived from the same hash
on every client. So a modifier adds no trust and cannot desync anybody. Shell
bounces are the one exception, which is why the budget rides on the fire event
rather than being looked up on arrival.

## Sound

There is not a single audio file in this repo. Every noise is a handful of
oscillators and a burst of filtered white noise, built when it is played and
thrown away afterwards.

That is a trade worth stating: samples would sound better, and they would also be
half a megabyte to download before the first shot, a build step to manage, and a
licence to check on every one. The game loads on a TV browser in a couple of
seconds and this keeps it that way.

Peer sounds carry a world position, which becomes gain and stereo pan relative to
your own tank — not HRTF and not trying to be, just enough to make you turn
toward gunfire. `M` mutes, and so does the button on the HUD.

The one real trap is the gesture rule: browsers refuse to start an AudioContext
before a click, and a context created too early lands in `suspended` and stays
there, silently. So it is built inside the lobby button's own handler, and the
smoke test asserts the context reached `running` rather than merely that the code
ran.

## Layout

```
src/arena.ts     the boards, collision, spawn points, block-hash selection
src/pickups.ts   block-hash-derived spawn schedule and the claim record
src/modifiers.ts the round's rule change, also out of the block hash
src/audio.ts     synthesised sound; no assets, positioned for peer events
src/sim.ts       tank and shell physics, all the feel constants
src/game.ts      netcode: subscribe, interpolate, hit detection, authority
src/nostr.ts     identity (real key + session key) and relay pool
src/protocol.ts  wire format for every custom kind
src/blocks.ts    the chain tip, which is the round clock
src/render.ts    three.js: the board, the tanks, the confetti, the camera
src/scores.ts    signed score records and the leaderboard query
src/main.ts      lobby, HUD, game loop
test/two-player.mjs  headless two-browser smoke test against live relays
```

## Testing

```bash
npm run build && npm run preview &
npm run test:live
```

Two real browsers, two guest npubs, one room, live public relays. It waits for
the clients to find each other, drives one tank into the other, and asserts the
kill came back as a signed death event.

Three of its checks exist because 3D fails quietly:

- a pixel out at the edge of the window and one in the middle, at the same
  height. The sky is a vertical gradient, so an empty scene makes them identical
  — the board is the only thing that can make them differ.
- the tank is sent to the arena position under a chosen pixel, and that pixel is
  read back. If the unprojection is right the tank is there and the pixels
  changed; if it is wrong the tank is elsewhere and that grass looks the same.
  Comparing the gun angle against `toWorld` instead proves nothing, because
  `toWorld` is the thing under test — a deliberately broken flat mapping passed
  that version of the check.
- the gun then has to swing to the cursor, which covers the rest of the chain.

Headless Chrome needs `--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader` to produce a context at all; the flags are in the
test. Software rasterisation is slow enough that the game visibly simulates in
slow motion, which is what the adaptive quality drop above is for.

## Tuning

Every number that decides how the game feels is at the top of `src/sim.ts`:
speeds, turn rates, shell velocity, reload, respawn delay, HP. Time-to-kill is
three shells at a 1.05s reload, so a clean duel is about 3 seconds of hits inside
a longer fight for position.

## License

MIT.
