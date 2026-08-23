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

**Two on one screen.** Pick *Two* under Players in the lobby and a second tank
joins the same room from the same tab. Player one keeps WASD, the mouse and pad
zero; player two gets the arrow keys with Enter or right-shift to fire, or pad
one. Both are real npubs with their own signed events and their own leaderboard
entries — the only things they share are the socket and the screen.

There is no split viewport, deliberately. The camera already frames the whole
arena, so two people on a couch can both see everything; carving that into two
smaller copies of the same picture would be worse on every screen size. What
"split-screen" is actually for here is two humans, one machine — and that part
is real.

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
| `21001` | shell fired | ephemeral | session key | `{ id, t0, x, y, a, b?, d? }` |
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

`d` is the shell's damage, and it *has* to be on the wire. The victim is
authoritative over its own HP and has no way to know what the shooter picked up
ten seconds ago, so a Siege shell announces that it takes two hull points rather
than one. It is capped at a full hull where the shell is rebuilt from the event:
a malformed or hostile fire event can kill you outright and no more than that.

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

That expiration is **evaluated against the relay's clock, not ours**, which makes
it headroom against clock skew rather than a tidy-up interval. At two minutes, a
client two minutes slow had every claim refused on arrival forever — and one a
hundred seconds slow was worse, because its claims died before its 32-second pads
did, which looks exactly like the ordering bug rather than a clock. It is ten
minutes now, about one block, and it is a fixed offset from `created_at` rather
than a second reading of the clock straddling the signature.

### When nobody accepts the claim

`sweepPickups` marks a pad taken *before* publishing — it has to, or grabbing an
item would stall for a round trip. So a claim nobody accepted leaves this client
alone in believing the pad is gone while every remote player still sees it live.

`publish()` returns an outcome for exactly this reason. The pad is restored on a
**unanimous refusal** — every relay that was asked looked at the event and said
no — and never on silence or a timeout, because the event may well have landed
and putting the pad back would be inventing a divergence rather than repairing
one. Splitting refusal from silence is what makes the rollback safe to write at
all.

Two things it deliberately does not do. It does not take the pickup's effect
back: nobody outside this client ever saw the grab, so nothing out there
disagrees about it, and a game that confiscates a shield for a network reason
feels broken in a way leaving it does not. And it does not make the pad
available *to us* again — the tank is still parked on it, and `sweepPickups`
runs every frame, so restoring it without marking it spent re-grabs it,
re-publishes, is refused again, and loops at frame rate. The first version did
exactly that: nine refusals in a second and a half, caught by the check that was
written alongside it.

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

## Pickups

Six of them, on a 34-second wave, and one pad each wave stays empty.

| Pickup | What it does |
|--------|--------------|
| Repair | Full hull, instantly. |
| Rapid fire | Reload in a blink, 12s. |
| Shield | The next shot bounces off, 14s. |
| Overdrive | Move like you stole it, 10s. |
| Scattershot | Three shells a shot, 14s. |
| Siege shells | Double damage, 10s. |

The wave used to be 22 seconds and that was too generous: an item you can count
on is not worth crossing the map for. At 34 seconds a stocked pad is a decision
— go for it and be exposed on open ground, or hold the lane you already own —
and that decision is the entire reason pickups are in the game. Supply Run turns
it back down to 10 and stocks every pad, deliberately.

### Which clock the wave runs on, and why it is not obvious

A pickup's pad, type and wave are a pure function of the block hash and the
round clock — and "the round clock" has to mean a clock the **chain** supplies,
not one each client starts for itself.

It originally measured from `performance.now()` at the moment that client's poll
first saw the tip, and cowboy found what that costs. The wave index is inside the
pickup id, so two clients whose 20-second polls are out of phase compute
*different ids for the same pad*. `onClaim` finds no match and drops the claim in
silence: the pad stays live on one screen and gone on the other, for the whole
round, and everybody gets every pickup. It was guaranteed for a late joiner —
someone arriving six minutes into a block sat at `elapsed ≈ 0` against everyone
else's `≈ 360`.

The anchor is now `BlockClock.chainSeconds()`: seconds since the block was
*mined*, read from the same explorer field by every client. That method refuses
to guess, which is the difference between it and `secondsSinceTip()` — the HUD's
version falls back to local first-sighting and marks it with a `~`, which is fine
to display and fatal to compute a shared id from. When the timestamp is missing
the schedule falls back to **absolute unix seconds** instead, which is still a
timeline everybody shares; it only shifts where wave zero begins.

The block timestamp is miner-chosen and may legally sit two hours off real time.
That does not matter here. The requirement is that everyone agrees, not that the
number is accurate, and they are all reading the same one.

There is a third state, and conflating it with the second was a bug of its own.
The mined-at time is fetched in the background, so **every round begins with it
in flight** — and if "not fetched yet" reads the same as "no explorer will tell
me", the board spawns on the unix fallback at wave ~52,000,000 and then
reshuffles to wave 0 the instant the real timestamp lands, at each client's own
HTTP latency. That is the two-timelines bug again, from the inside. So `pending`
is a distinct state and the schedule waits it out; an empty board for one round
trip at the start of a round is invisible. `unavailable` is deliberately terminal
per block and never retried, because a successful retry mid-round is exactly the
reshuffle being avoided.

### Getting the claims in the first place

A claim is published **once**. It is the only thing in this game where a wrong
backfill window is permanent for the round — sessions rebroadcast every 12
seconds and state and shells are continuous, so those self-heal within seconds
and hide the problem for four kinds out of five.

It used to share their subscription, and that got it wrong twice, silently:

- `since = now - 30`, against pads that live `waveSeconds - 2` = 32 seconds. A
  claim 31 seconds old, for a pad still on the board and still taken, was simply
  never asked for.
- `since` came from *this* client's clock while the relay matches it against
  `created_at` written by *other* clients. A joiner sixty seconds fast asks for
  events from the future and backfills nothing at all.

Claims now have their own subscription with no `since`, bounded by `limit`. The
NIP-40 expiration already caps how long a relay keeps one, so the window is
enforced where it can be enforced honestly — by the publisher, in the event —
instead of by a subscriber guessing with a clock nobody else shares.

The other half of the same hole: a claim naming a pad this client has not derived
yet is **remembered and applied when the pad appears**, rather than dropped. That
ordering is not an edge case — it is what a late joiner's `REQ` backfill always
looks like, and dropping it made storing the claim pointless. The buffer
deliberately survives `beginRound`, too: that fires on the first tip a session
sees, a few hundred milliseconds after the subscription opened, so clearing it
there would wipe the backfill with the very call that makes those pads
derivable.

Two counters, because either alone lies. `unmatchedClaims` counts claims that
arrived before their pad existed — normal during backfill, drift afterwards. On
its own it reads a healthy zero in the worst case there is, a backfill that
fetched nothing, so `claimsReceived` sits beside it: a client that joined
mid-round with that at zero is the suspicious reading.

The suite carries a third browser purely for this. A and B are both in the room
when the claim goes out, so nothing about them exercises the `REQ` at all —
`charlie` joins afterwards, asks the relay, and has to conclude the pad is gone.

Each type has its own silhouette as well as its own colour. Six items that were
all the same octahedron in six colours made reading a pad from across the board a
colour-match puzzle, and an impossible one for anyone who cannot separate the
orange from the red.

Scattershot is the only one that multiplies traffic — three fire events instead
of one — which is why it lasts fourteen seconds rather than being a weapon. A
shot is roughly one event a second per player against a tick stream of ten, so
tripling the rarer of the two briefly is a rounding error. Worth checking before
adding anything else that fans out.

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

The rule for adding one is not "only touch local things" — that wording was too
loose. It is: **anything derived from the round's rules that another client also
derives must be anchored to the same input on both.**

HP, reload, speed and respawn pass trivially, because nobody else derives them.
Two things did not. Shell bounces are re-simulated by whoever receives the fire
event, so the budget rides *on that event*. And `waveSeconds` / `emptyPads` feed
the pickup schedule, whose wave index ends up inside the pickup id — that one was
filed under "cannot desync" and could, until the schedule was anchored to the
chain. What is left is the block boundary itself: for the few seconds one client
has seen the new tip and another has not, they disagree about the map, the rules
and the schedule alike. That is inherent to having no host, it is bounded by the
poll interval, and it costs a pad.

## Two players, one machine

The interesting half is not the second tank, it is that **local players skip the
relay entirely**.

Everything player two publishes is handed to player one in the same turn, as
well as going out to the relays — and it is the *same signed event*, through the
same `onEvent`. Nothing downstream is special-cased: the two tanks agree for the
same reasons two strangers do, a remote player sees exactly what they would
have, and the relay's echo a moment later is ignored because events are
de-duplicated by id.

What it removes is the round trip. Two people on one couch should not be
watching each other at 150ms — that is the one latency in this game with no
excuse, because the sender and the receiver are the same process. The suite
checks it by cutting the relays off at the knees and asserting a shot still
arrives in the same turn.

### One `Net` per player, too

They share the screen and the machine. They must not share an uplink, and the
reason is not bandwidth.

Every failure counter in `Net` is keyed by relay URL and was written when one
socket meant one publisher. `strikes` resets on any success. So a relay that
refuses **player two's key** and accepts player one's never accumulates fifteen
consecutive strikes, never mutes, and never appears in `mutedRelays`. Player
two's `restricted:` reason lands in `trouble` and player one's next success wipes
it. `rejected` climbs and cannot say whose.

The local mirror is what turns that from obvious into invisible. Without it, a
fully-rejected player two is a tank *player one cannot see either* — noticed in a
second on the couch. With it, both people see a perfectly correct room, because
player two's events reached player one without a relay at all. Only the rest of
the world sees one tank where there should be two, and nobody in the room has any
way to find out.

Two sockets also mean two per-connection budgets, which matters on a relay that
allocates its token bucket per *connection* rather than per pubkey — newlay does,
so on one socket the two players would share a throttle and one player's
rejections would decay the other's rate.

It costs a second subscription and double inbound. Worth it. The per-IP gate is
unaffected either way; that one is shared across sockets by definition.

### One `Input` per player, not one per page

Three things were correct for one human with a keyboard and a pad, and broke the
moment there were two. Fizz measured all three against the single-player code
before this was written, and every one of them would have shipped:

- **A held key suppressed a pad that was being actively pushed.** The "any held
  key beats the pad" backstop read a key set filled from a `window` listener, so
  splitting into two `Input` objects did not help — both saw every key and both
  concluded somebody was driving. Player one's W froze player two completely.
- **A second pad was inert.** `readPad()` returned whichever pad answered first,
  and once pad zero had latched, a *centred* pad zero was enough to shadow a
  pushed pad one forever.
- **A pad first seen while being pushed calibrated the push as its centre**, and
  read zero until it was released. Invisible for someone who plugs in and then
  plays; not invisible for player two joining mid-match with a thumb already on
  the stick. The rest position is now seeded from the first reading only where
  that reading is small enough to plausibly *be* a rest position.

So an `Input` carries a `Binding`: which half of the keyboard it reads, which pad
index it owns, whether it gets the mouse. Nothing is shared.

A player with neither a mouse nor a right stick aims **along the hull** — the gun
points where you drive. That is the other half of the arcade tradition rather
than a compromise, and the alternative is a second player whose turret never
turns.

Sound has one ear, and it is player one's. Everything player two does is already
audible there as a peer event, positioned, through the same path a stranger's
shot takes; a second sink would play every shot twice.

## Who is that? Kind 0, and NIP-05

A signed score is only worth reading if you can tell whose it is, and a hex
pubkey is not a person. Kind 0 metadata for every real npub in the room becomes a
face and a name on the scoreboard, the podium and the leaderboard.

Three things it is careful about:

- **It never blocks the game.** A profile that has not arrived renders as the
  short npub and upgrades itself when the event lands. Nothing waits on a relay
  to draw a frame, and a guest key — which has no profile anywhere — falls back
  to a coloured initial rather than a broken image.
- **It asks once.** Requests are batched into one `REQ` and every pubkey is
  remembered for the session, including the ones that came back empty.
- **A NIP-05 is not believed until it is checked.** The `nip05` field in a kind 0
  event is a claim the account made about itself; anyone can put `jack@cash.app`
  in theirs. The name only earns its green tick once
  `https://<domain>/.well-known/nostr.json?name=<local>` has been fetched and
  found to map that name back to *this* pubkey.

That last check is a cross-origin request to somebody else's server, and plenty
of them send no CORS headers — which is indistinguishable from the domain being
down and is emphatically not proof of a fake. Those stay grey and unverified
rather than being marked wrong. Only a domain that actively names a *different*
key gets the strike-through.

## The block clock

The HUD counts *up* from when the tip was mined, because there is nothing honest
to count down to: the next block is a coin flip every second, not a timer running
out. Past ten minutes — the average, not a deadline — it turns amber, which is
the game saying "any tick now" rather than "something is wrong".

The mined-at time is a third request to the explorer and is deliberately not
awaited with the tip: height and hash are what a player needs to start, and
failing here costs the clock and nothing else. When it does fail the count runs
from when this client first saw the block and says so with a `~`, which is a
lower bound rather than a guess dressed up as a fact.

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
src/profiles.ts  kind 0 metadata, avatars, and NIP-05 verification
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
test/sound.mjs       taps the master bus and measures what each sound emits
test/controls.mjs    hands the page a fake gamepad and checks WASD survives it
test/relays.mjs      four fake relays that misbehave on cue, on localhost
test/couch.mjs       two pads, two players, one tab
test/relays.mjs      six fake relays misbehaving in six different ways (localhost only)
test/shot.mjs        photographs a pinned block, because pixels are not the DOM
```

## Testing

```bash
npm run build && npm run preview &
npm run test:live
npm run test:sound
npm run test:controls
npm run test:couch
npm run test:relays
npm run test:relays
```

Two real browsers, two guest npubs, one room, live public relays. It waits for
the clients to find each other, drives one tank into the other, and asserts the
kill came back as a signed death event.

### Look at it, too

`npm run shot -- .scratch/board.png 0300` joins a room, pins a pretend block —
the first two hex digits pick the rules, the last two pick the map — and takes a
picture.

That exists because a structural test is not a picture, and this repo has the
scar. The ring under your tank sat at `y = 1.2` and every pickup pad at `y = 1.5`
while the board's felt is at `y = 2.5`. Both were drawn every frame, *inside* the
board, and never once reached a pixel. `visible` was `true` the whole time, so no
DOM assertion could have caught it. A screenshot did, immediately. There is now
one `GROUND_Y` constant that both the felt and every flat decal are placed
against, and the suite asserts the decals are above it.

Three of its other checks exist because 3D fails quietly:

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

### Measuring the sound, rather than trusting it

`npm run test:sound` is a second suite, and it exists because the sound checks
in `two-player.mjs` cannot fail.

Those checks assert that an `AudioContext` reached `running` and that the game
*asked* for a sound. Both stay green when the game is completely silent: the two
ways Web Audio actually breaks are a node nobody connected to the destination
and a context nobody resumed, and neither of them throws or refuses a call. A
voice missing one `.connect(out)` passes every existing check.

So this one taps the master gain with an `AudioWorklet` and measures the samples
that come out of `Sfx.play()` for real — peak, RMS, when it starts, how long it
stays audible — through the panner, the distance falloff, the envelopes and the
mute. `src/` is not modified to make this possible.

Three controls, because a measurement that has never returned zero proves
nothing:

- a shot placed past `EARSHOT` must be silent, and the same shot up close must
  not be — that is the distance model checked against itself
- nothing may reach the bus while muted
- sound must come back after unmuting, which is a real risk: `toggle()` has to
  restore the master gain, not only flip the flag

It was confirmed to fail before being trusted. Deleting `.connect(out)` from
`tone()` silences six voices and turns twelve checks red; `two-player.mjs`
passes that same build without a murmur.

**Do not poll an `AnalyserNode` from `requestAnimationFrame` here.** Under
swiftshader the page runs at roughly six frames a second, so a 140ms gunshot
falls entirely between two polls and measures as silence. The first version of
this suite reported nine failures that were all the harness missing the sound
rather than the sound missing. A worklet runs on the audio thread and sees every
sample.

#### The autoplay policy cannot be tested here

`two-player.mjs` launches Chrome with `--autoplay-policy=no-user-gesture-
required`, but the flag is not what makes that assertion weak. Chrome under
Puppeteer reports `navigator.userActivation.hasBeenActive === true` before
anything is clicked — headless, headful, and with `user-gesture-required`
explicitly set. A context always starts `running` regardless of *when* the page
built it.

To be precise about what that line does and does not prove: it does go red if
`unlock()` is never called at all, which was confirmed by deleting the call. What
it cannot tell you is whether the context was created before or after a gesture,
which is the rule it appears to be testing. The gesture rule is real and the code
gets it right; that line just is not what checks it. `test/sound.mjs` checks the invariant behind it instead: it
counts every `AudioContext` the page constructs and requires zero before the
first click. Moving the constructor into `new Sfx()` turns it red, which is
exactly the bug the rule exists to prevent.

### The gamepad that eats your keyboard

`npm run test:controls` exists because of a bug that a controller sitting
untouched on a desk could cause, and that nobody with no controller plugged in
would ever see.

`Input.read()` called `readPad()` first and returned its answer outright, and a
pad counted as "in use" the moment any axis left the 0.22 deadzone. Worn sticks
do not return to zero. `onKeyDown` set `usingGamepad = false`, but the very next
frame latched it straight back, so the keyboard never got a turn.

Measured by injecting a fake pad and holding W:

```
no gamepad at all                        W moved  111px
pad connected, perfectly centred         W moved  140px
pad connected, left stick drift 0.25     W moved   35px   fighting the stick
pad centred but trigger resting at 0.15  W moved    0px   keyboard dead
pad with RIGHT stick drift 0.30          W moved    0px   keyboard dead
```

The right-stick case is the one worth staring at: that axis only aims. You could
lose the ability to *drive* to a stick that does not steer. And the trigger case
is two bugs at once, because the trigger is also fire — a dead keyboard and a
tank shooting on its own.

Three changes, in increasing order of how much they are load-bearing:

- **Every pad's rest position is learned, not assumed.** Each axis converges on
  the smallest magnitude it has ever reported. A stick that genuinely passes
  through centre calibrates to zero; one that never does calibrates to its true
  rest. It only ever moves toward zero, so it cannot get stuck high. The trigger
  gets the same treatment, for the same reason twice over.
- **Claiming the input takes a deliberate push** (`CLAIM`, 0.35) rather than
  merely clearing the deadzone. Reading a stick and deciding to ignore the
  keyboard are different questions and they no longer share a threshold.
- **A held key beats the pad outright.** This is the backstop that does not
  depend on the calibration being right: if someone is holding W, no reading of
  a stick they are not touching outranks that.

The suite checks both directions, because the obvious way to overshoot this fix
is to make the controller useless. It asserts W/A/S/D each travel the right way
*on screen* — the hull is pre-aligned first, or every reading is dominated by
whichever way the tank happened to be facing — that six kinds of broken pad
cannot stop them, and that a real pad still drives, aims, and fires on both the
A button and the trigger.

Each scenario gets its **own pad index**, because each one stands for different
hardware. Calibration is per-pad and remembers the lowest reading it has seen,
so sharing an index would mean a trigger "resting" at 0.6 on a pad previously
seen at 0.0 — which is a player pulling it, the opposite of the case under test.

Confirmed red before being trusted: against the previous `input.ts`, five checks
fail, including the tank firing by itself.

One measurement note, the same one the sound suite learned: hold for long
enough. At swiftshader's frame rate the sim runs at roughly a third of
wall-clock, and a short hold leaves the signal the same size as the jitter — a
working keyboard measured 37px against a 61px baseline, which is a coin flip
rather than a check.

### Three ways a publish fails, and only one of them is the relay's fault

`npm run test:relays` stands up fake relays on localhost that each fail on
purpose, because the behaviour under test is what the client does when a relay
is unhappy — and you cannot ask a real relay to start rate-limiting on cue, or
to accept an event and then never acknowledge it.

`publish()` used to treat every rejected promise identically and mute a relay
for the rest of the session after fifteen in a row, on the reasoning that a run
of refusals "is a policy, not a bad minute". That is right for one of the three
things a rejected promise can mean:

| kind | what happened | mute? |
|---|---|---|
| `refused` | `pow:` `blocked:` `restricted:` `auth-required:` `mute:` | **yes** |
| `refused` | `rate-limited:` **without** a number | **yes** |
| `refused` | `rate-limited:` **with** a number | no — paced instead |
| `no-verdict` | nothing came back: publish timeout, dropped socket | no |
| `malformed` | `invalid: ...` — the event was bad | no |
| `unknown` | `error:`, or anything with no recognised prefix | no |

`duplicate:` is not in the table because it is not a failure: the relay already
has the event, so it is counted as an acceptance. It arrives as a rejected
promise, which is the only reason it needs mentioning at all.

**Match the prefix first, and only then guess from the shape.** NIP-01's
machine-readable prefix set is closed, and searching for substrings anywhere in
the message got three of newlay's real frames backwards — all in the direction
that cannot mute:

```
restricted: you are timed out until 1799999999          contains "timed out"
rate-limited: too many open connections from your IP    contains "connection"
rate-limited: connection attempts too fast; slow down   contains "connection"
```

A moderation timeout is the most literal "it has a policy, not a bad minute"
frame that exists, and it was the one being read as silence — so the client
would hammer, for a whole session, a relay that had explicitly and by name told
it to stop. The prefix has to win over any word that happens to appear inside
the message.

**Unrecognised defaults to not muting.** Muting is the destructive direction and
NIP-01 defines `error:` as "any other reason" — the weakest possible basis for
writing a relay off. This also subsumes the `relay.fountain.fm` case below
without a string-table entry for it.

**`no-verdict` is not a refusal, because refusing is a frame and silence is not
one.** purplerelay.com was measured timing out on hundreds of publishes in a
row while a separate subscriber confirmed it was still forwarding 246 of 251 of
them. Muting it threw away a working relay for the rest of the session because
the acknowledgement was slow.

**`malformed` is our bug, not the relay's.** A clock far enough behind makes
every NIP-40 `expiration` arrive already spent, so every relay answers
`invalid: event expired` — and the old code would have muted the entire set
over a local clock problem, one relay at a time, in about two seconds each.

Muting is also no longer permanent. A muted relay sits out sixty seconds and is
then retried; the wait doubles each time, capped at fifteen minutes. A relay
with a real policy costs fifteen wasted events per attempt and then goes quiet
for longer and longer, while one that was reloading when we met it comes back.

The span lives in its own map, and that is not an implementation detail. The
first version kept it inside the `muted` entry — which `publish()` prunes on
entry the moment the wait expires, taking the span with it. `prev` was therefore
always `undefined`, every wait was sixty seconds, and the fifteen-minute cap was
unreachable. **The test asserted `mutes >= 2`, which is the counter, and the
counter increments identically whether the wait grew or not**: the check ran,
reported success, and measured nothing. It asserts on the wait now — first 60s,
second 120s.

Alongside that, a `ledger` that never expires. `trouble` is deliberately
forgetful — a complaint ages out after twenty seconds so the HUD reflects now —
but ticks outrun everything else about 150:1, so the successful publish that
clears a complaint is always a few hundred milliseconds away while a pickup wave
is thirty-four seconds long. Anything sampling at the end of a round saw a
healthy board and no explanation. The ledger keeps per-relay counts by kind for
the whole session.

Confirmed red before being trusted, twice. Against the `nostr.ts` before any of
this, five checks fail: the `invalid`-rejecting relay and the silent one are
both muted, the client stops publishing to them, and a mute is never retried.
Against the substring-first version, thirteen more do — including
`the second mute waits longer than the first  first 60s, second 60s`.

Two things the suite is careful about:

- **The fake relays count what they receive**, server-side. "Not muted" has to
  mean events are still arriving, not merely that a URL is absent from a list
  the client keeps about itself.
- **The ledger checks are skipped when the build has no ledger**, so the suite
  still reports something meaningful when pointed at the older bundle. The
  behaviour it is really testing — which relays get muted — is observable
  either way, and a suite that only crashes on old code proves the API changed
  rather than that the behaviour did.

One blind spot, stated rather than hidden: classification is string matching,
because a rejected promise carries nothing else. A relay that answers a bad
signature with something generic — `relay.fountain.fm` says `error: unknown
error` — reads as `refused` when it is really `malformed`, and costs itself
strikes it did not earn.

### Pace to the number, do not mute the messenger

A rate limit is the one refusal with an instruction in it:

```
rate-limited: publishing too fast (limit 180 events/min); slow down or AUTH for higher limits
```

Muting that relay is the wrong answer, and against newlay it is actively
harmful. Worked through, because the mechanism is not obvious:

newlay's token bucket **refills continuously**, so a client publishing past the
cap does not get a clean run of refusals — it gets a steady trickle of
acceptances mixed in. Roughly one in eleven at a 60/min cap against a 12Hz tick.
And `strikes` resets to zero on every acceptance. So the run of fifteen
consecutive refusals never arrives, **the relay is never muted, and the client
hammers it for the whole session at an 8% accept rate.**

Every one of those rejections is −2 on a behaviour score that recovers at +2 per
*clean* minute — a minute containing any violation is not clean. At ~8 rejects a
second the score is on the floor within seconds, the multiplier drops to 0.1×,
and the cap becomes a tenth of what was configured. **Continuing to publish is
what holds it there.** For an anonymous key there is no way out: the other
recovery credit is authed-only and ephemeral session keys never AUTH.

Measured against a fake relay with a real token bucket capped at 60/min:

```
                          sent/s    accepted
muting (before)              8.9         11%
pacing (after)               0.9        100%
```

So: parse `limit (\d+) events/min`, pace to 90% of it, and do not strike. A
client under the cap takes no rate hits, so its minutes are clean, so the score
climbs and the number in the string goes back up while you watch. The margin
matters — spending a bucket exactly as fast as it refills sits on the boundary,
where jitter alone produces the refusals you are pacing to avoid.

Pacing is a pace, not a ratchet. A relay that has gone quiet for thirty seconds
gets tried 1.5× faster, snapping back to whatever it reports next; obey the
number and you stop being refused, so without probing you would never learn it
had forgiven you. And there is a valve: forty refusals while paced means the
number is not the problem, and the relay goes back on the strike-and-mute path.

**Only the position tick is paced.** It is ten a second and the next one is
always 100ms away. The shell, the death, and the claim published exactly once go
regardless — skipping those to respect a rate limit would trade a throttle for a
divergence.

#### The absence of a number is the other half of the signal

newlay's per-IP gate refuses with `rate-limited: too many events from your IP;
slow down` — same prefix, **no figure**. Per-connection carries a limit; per-IP
never does. That single difference separates the cap that a second socket fixes
from the cap it does nothing about, and nothing can be paced to a number that
was not given, so those go back to muting.

#### One check that is not a discriminator

`the rate-limiting relay is NOT muted` passes against the code *without* pacing
too, for the opposite reason: the trickle of acceptances keeps resetting the
strike counter, so the relay is never muted precisely *because* the client is
hammering it. Not-muted is the same observation for a healthy pace and for an
unchecked flood. Only the send rate and the accept ratio tell them apart, which
is why all three are asserted together.

## Tuning

Every number that decides how the game feels is at the top of `src/sim.ts`:
speeds, turn rates, shell velocity, reload, respawn delay, HP. Time-to-kill is
three shells at a 1.05s reload, so a clean duel is about 3 seconds of hits inside
a longer fight for position.

## License

MIT.
