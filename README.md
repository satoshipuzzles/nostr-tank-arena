# Nostr Tank Arena

Eight-player tank deathmatch on a board, with **no game server**. Your npub is
your identity, Nostr relays are the netcode, and your score is an event you
signed yourself.

Slow shells, 3 hits to kill, cover you can hide behind, sandbags you can
shoot over but not drive through, instant respawn.

## Rounds are Bitcoin blocks

A round lasts one block. That is not decoration — it is the only round timer
available to a game with no server. Every client discovers the same height at
roughly the same moment, nobody is the host, nobody broadcasts "round over",
and a player who joins halfway through knows exactly which round they are in.

When the tip moves:

1. the round ends and a podium shows the standings,
2. scores reset to zero,
3. **the map changes** — the board is `blockHash % 8`, so every client
   generates the same arena from the same number with no message passing at
   all. Eight boards ship, and the size range is part of the variety:
   Crossroads (1600x1200), The Lanes (2000x1400), Pillars (1950x1450),
   The Ring (1900x1400), The Yard (1500x1100), The Quarry (2100x1550),
   The Hedges (1800x1350) and The Depot (1700x1250). Every board is
   180-degree rotationally symmetric, so no spawn is better than another.

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

## Kill streaks

Kills in a row, without dying:

| Streak | Reward |
| --- | --- |
| 3 | Hull repaired to full — always |
| 5, 7, 10, 15 | **Your loadout** — four slots you arrange in the lobby from five rewards: air strike, recon (every enemy marked through cover, for you *and* your teammates), chopper, siege shells, EMP (every other player's HUD goes dark) |
| 20 | Juggernaut — full hull, shielded and fast — always |
| 25 | Carpet bombing — a longer air strike — always |

The default arrangement is air strike at 5, recon at 7, chopper at 10 and
EMP at 15. One reward always stays home; no duplicates — picking a reward
another rung holds swaps the two. Saved on this device (an npub-portable
loadout is the next step). Everybody's rewards stay legible on every other
screen no matter whose ladder produced them, because each reward already
publishes or rides the tick.

Separately, eight seconds without taking a hit gives one hull point back;
`Game.regenAfter` is the knob.

Everything on that ladder except the air strike and the chopper is
**self-authoritative**, and that is the point: your own HP and your own buffs are already the numbers this
client decides, so no rung needed a new event kind, a new trust assumption, or
agreement with anybody. They ride out in the next state tick like any other HP
change, and a cheater who hands themselves hull points was always able to.

The air strike is the one that reaches across the arena, which is exactly why it
is the one with a wire format — kind `21004`, one event for the whole run.
Every client walks the same line from `t0` and each bomb detonates at a position
anyone can compute, so a fourteen-bomb strike costs one publish rather than
fourteen. Damage travels in the payload for the same reason it travels on a
shell: the *victim* applies it, and the victim cannot see what the caller had
going on when they earned it. The caller is exempt, and the lane is chosen on
the far side of the board from them.

### Domination

Puzz, asking about team deathmatch: *"shouldnt we see when capturing a flag and
taking over a territory or is that not how that mode works"*. It is not — that
is this, and of the three team modes it is the one that fits this game's netcode
best.

Three points per board, taken from the pickup pads so they are already mirrored
through the centre and already clear of the scenery. Stand on one alone for
three seconds and it turns. Three rather than two or four because an odd number
cannot be split evenly: somebody is always behind and somebody always has to
move.

**Ownership is derived, not published.** Every client already receives every
tank's position ten times a second, so who is standing on a point is a function
of that stream and nothing else. Nobody sends "I took point B" — each client
works it out from the same inputs and reaches the same answer, which is the rule
the map and the pickup schedule already run on. Two clients disagree about the
*instant* a capture completes by about the interpolation delay, and cannot
disagree about the outcome, because neither is making a decision the other has
to accept.

**The score is a capture, not a stopwatch.** Held-time would have to accumulate
from the round boundary, so anybody joining at minute six could never catch up
and would have no honest number to publish. A capture is an event: it happens
once, the client it happened to counts it, and it rides the same `cap` field the
flag game uses. Both modes therefore score the same way, which is one fewer
thing on the wire and one fewer thing to explain.

Three rules that are decisions rather than arithmetic:

- **Contested is nobody**, not "the side with more tanks". A headcount would let
  a duo walk a point out from under a lone defender without shooting them, which
  makes the mode a race rather than a fight over ground.
- **Contested stalls, it does not reverse.** A point you nearly took stays
  nearly taken while you fight over it.
- **Stepping off decays rather than resets.** Dodging for half a second should
  not throw away three seconds of work, and a decay means a point left alone
  drifts back rather than snapping.

### Teams

Puzz asked for "team deathmatch, duos with 5 teams". There is no host here to
assign sides, so the interesting question is not friendly fire, it is **who
decides which side you are on**. Two of the three answers are worse:

- Derive it from the roster and two clients with different relay visibility
  compute different sides for the same player, which is worse than lopsided
  teams: it is two people who each believe the other is a teammate on only one
  of their screens.
- Derive it from the pubkey and it always agrees, and takes away the choice,
  which is the half of team play people actually want.

So a side is **self-declared**, on the state tick as `tm`, exactly as
trustworthy as the `hp` beside it. Press `T` to cycle none, Red, Blue, Green,
Gold, Violet. A room is in team mode when the people in it say it is; one player
on a side is still a deathmatch, which is what should happen when you pick a
team and nobody joins you.

**Which makes it the one self-reported field with no exploit in it.** Think
about what a liar gets. The rule is applied by whoever is being *shot*, so
claiming somebody's side makes their shells pass through you and yours pass
through them, because they are running the same check against your tick. A false
claim buys a mutual truce, not immunity, and a truce with somebody who did not
agree to it is a fight you cannot win rather than one you cannot lose.

Every damage path honours it: shells, lob craters, barrel explosions, air
strikes and chopper fire. A teammate's shell is *consumed* rather than passed
through, so it does not sail on and kill somebody behind you.

Zero is nobody's side, and two players who have not picked are not teammates. A
`0 === 0` shortcut in the friendly check would silently turn friendly fire off
for the whole room.

On the board a teammate gets a green ring on the felt and an enemy gets nothing.
A mark on everybody is a mark on nobody: the question a player is answering in
the half second before pulling a trigger is not "which of five sides is that",
it is "can I shoot it", and the tank without a ring is the one you shoot. The
hue stays the player's own, because it is how you find yourself and how you tell
eight tanks apart, and painting a side colour over it would cost the most
load-bearing piece of legibility in the game.

### How big a room gets

Eight seats, and the number is bounded by the relay rather than by the game.
Each client publishes its own tick at 10Hz however many people are in the room,
so raising the ceiling does not change what anybody *sends* — it changes what
everybody receives, and that goes up linearly: three peers is thirty events a
second, seven is seventy. Seventy is comfortable for a socket and uncomfortable
for a relay operator, and it is the honest ceiling until the tick rate scales
with occupancy.

Three things had to move together, and none of them fails loudly:

- **Spawns.** Four seats and four spawn points were the same number by
  coincidence. `respawn` picks the spot furthest from everybody alive, so a
  room of eight sharing four spawns puts two tanks on top of each other about
  as often as not — which reads as a netcode bug rather than as a missing spawn
  point. Every board carries eight now: the four corners, then the middle of
  each edge, still 180-degree rotationally symmetric.
- **Colours.** `spreadColors` walks the palette from the slot nearest a
  player's chosen hue and takes the first free one, so six slots and eight
  players means two people driving the same colour — and that is only wrong at
  the moment they meet. Ten hues now, every pair at least 25 degrees apart,
  with the original six unchanged and in the same order so nobody's tank
  changes colour across a deploy.
- **The scoreboard**, which went from four rows to eight in a 800px window.

The board does **not** grow with the room, deliberately. Board size comes from
the block hash — eight layouts from 1500x1100 to 2100x1550 — so every client
agrees on it without being told. Deriving it from occupancy would mean two
clients with different relay visibility playing different board sizes, which is
the one thing a shared arena cannot survive.

`SEATS` is a lobby number, not a rule. Nothing in the simulation enforces it:
`roleFor` hands a ninth arrival a place in the queue rather than a seat, and a
client that ignores that is a client that ignores it. The queue has always been
a courtesy.

### Breakable cover

Two kinds give way, and what is *not* on the list matters as much as what is.
Rocks and hedges are the skeleton of a layout — they are what stop a round
dissolving into an open field by minute eight — and the fence is the board.
Timber and steel drums are what a player already expects to break.

| Cover | Hits | On destruction |
| --- | --- | --- |
| Barrel | 3 | Explodes — everything inside a lob's blast radius takes a hit, including whoever shot it |
| Crate | 8 | Comes apart. Splinters, no damage, and the lane behind it is open |

The two numbers are the design. Three hits is a magazine minus one, so taking a
barrel costs a reload you have to survive. Eight is two full magazines — most of
twenty seconds standing still and shooting a box — which is the price a *wall*
should carry: breaching one is a plan you commit to at the start of a round, not
something you do in passing. The split is also the tactical difference between
them: you shoot a barrel because somebody is standing next to it, and you shoot
a crate because you want the lane behind it.

Everything comes back with the next block. That reset is its own call rather
than a side effect of loading the layout, because the map is `blockHash % 8` and
two rounds in a row land on the same board about one time in eight — a round
inheriting the previous round's holes would be a different board from the one
its own hash describes, and a late joiner would get a fresh one and disagree
with everybody.

This is the first thing in the game that changes the shared board without being
derived from the block hash, so it has to converge on its own. Every client
re-simulates every shell from the same fire event through the same layout, so
they all reach the same rect and take the same hits out of it. What that cannot
cover is a shell one client deleted early — a hit on an interpolated tank lands
a few pixels apart on different screens — so the destroyed set rides on the
state tick as `b`, a bitmask that is **unioned rather than replaced**. Order
does not matter, a lost tick costs nothing, it cannot be un-set, and a late
joiner is caught up by the next one. Hit counts may drift; the outcome cannot.

A client can clear the board by sending all ones. That is the same trust model
as everything else here, and a mask that can only *remove* cover is a smaller
lever than lying about your own position or your own kills.

### The chopper

Ten in a row and you get out of the tank. Everything below that rung changes a
number on your tank; this takes the tank away and gives you a different vehicle
with a different job, which is the whole appeal and also why it needed a design
rather than another case in a switch.

For ten seconds you fly a gunship over the board. It moves at twice a tank's
speed, the gun reaches 520 units ahead of it, and the rounds land in a 54-unit
circle marked on the felt. One hull point per 520ms per target, so three
intervals kill a full tank and somebody who starts running the moment the ring
lands on them lives. Your tank is **out of play** for the whole window — it is
not drawn, not collided with and cannot be shot — and you respawn on the way
down. The reward is being dangerous and untouchable; the cost is that your tank
is holding no ground while you enjoy it.

**The chopper cannot be shot down.** Tanks in this game have no elevation and no
anti-air, and inventing one for a ten-second window would be a whole weapon
nobody asked for. If that ever changes it will be because someone played against
it and said so.

Nothing new goes on the wire for any of it. A machinegun is ten rounds a second,
and ten fire events a second on top of a position stream that is already 10Hz is
past what most public relays will accept at all — so the gunship rides the state
tick that was going out anyway: `c` counts the milliseconds left, `cx`/`cy` are
the point on the ground it is shooting at, and while it is up `x`/`y` are the
chopper instead of the parked tank. The tracers in between are drawn by each
client for itself. Damage is applied by the **victim**, exactly like a shell:
nobody is told they were hit, each client reads the gunships it can see and asks
whether it is standing underneath one.

Two clamps, and the second is the one that matters. `c` is clamped on receipt,
because a hostile client claiming an hour of gunship is claiming a tank nobody
can shoot for an hour. And the reach is clamped by the same function on the
shooter *and* on every receiver — a reach enforced only by the client doing the
shooting is a reach a modified client does not have.

The bombs are spaced to leave **no gaps**. The first version dropped nine across
a 1728-unit run — one every 216 units against a 64-unit blast radius — so two
thirds of the lane was safe ground and a tank standing still in the middle of a
strike usually took nothing. It looked spectacular and did nothing, which is the
worst thing a kill streak can be. Fourteen closes the line, and that is what
makes the warning worth heeding: the lane lights up on the felt and a siren
sounds about two seconds before the first bomb, so a strike is survivable if you
move and fatal if you do not.

## Tank skins

Six finishes — Plastic, Matte, Chrome, Neon, Rust and Carbon — chosen in the
lobby and carried on the session attestation (`sk`) rather than on the state
tick, because it changes about once a session and re-transmitting a lobby
setting ten times a second forever would be paying a tick-stream price for
nothing.

**A skin never takes a player's colour away.** Every tank's hue comes from its
own pubkey and is spread across a fixed palette so eight tanks are obviously eight
colours; that is the single most load-bearing piece of legibility in a four-way
scramble. So a skin changes the *finish* — lightness, metalness, roughness, how
much the hull glows — and the hue survives all six. `Carbon` is the exception
that proves the rule: its hull is nearly black, so the usual gunmetal trim would
leave a tank with no colour anywhere, and below a lightness of 0.4 the trim
takes the hue instead. The colour moves rather than disappearing.

Skins are cosmetic only. Tank *classes* — different hulls that drive and shoot
differently — are a separate and much larger piece of work, filed as its own
issue.

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

### Cover is made of something

Every piece of cover has a `kind` in `arena.ts` — `rock`, `crate`, `barrel`,
`sandbag`, `hedge` — and the renderer builds the matching object: a faceted
outcrop with scree round the base, a stack of timber crates, a cluster of oil
drums with rolling hoops, a clipped hedgerow with a ragged top.

It replaced a scheme where the renderer *measured* each rectangle and painted
it: near the middle meant a pink cross, square meant a yellow pillar, anything
else was a blue L. That was a legibility feature and it worked — four people
shouting at one television need to be able to name a place. Naming it by
material works better, because "behind the crates" survives a player who is
colour-blind, a phone with the brightness down, and a green tank parked in
front of a green wall. It also puts a board's identity in the layout, where a
level designer can reach it, instead of in a chain of `if` statements about
rectangle dimensions.

The palette went with it. The old board was pastel — mini-golf green turf, a
swimming-pool sky, a cream plastic slab — on the argument that saturated tanks
need desaturated scenery. The argument is right and pastels are a poor way to
act on it, because a pastel is a saturated hue with white mixed in and still
competes for the same corner of the wheel. Earth pigments do not: real turf
greens with worn patches, dry earth under the board, granite, timber, hessian,
and a sky that goes warm at the horizon into fog of the same colour, so the far
end of a 2000-unit board dissolves instead of stopping.

### Sandbags: shells go over, tanks do not

One kind is a rules change rather than a paint job. `pointInWall` is what stops
a *tank* and every rect answers to it; `pointInTallWall` is what stops a
*shell*, and barricades are excluded from it. The centre cross on Crossroads
and the long arm on The Ring are sandbags, which turns the middle of both
boards from a wall you circle into a line four tanks can duel across.

Two consequences worth stating plainly:

- **Standing behind sandbags does nothing for you.** They are a movement
  obstacle, not cover. Naming them after the one thing on a battlefield you
  actually can shoot over is the best signpost the game has.
- **Spawn picking treats them as open ground.** `hasLineOfSight` uses the tall
  predicate, because the question it answers is "can that player shoot me the
  instant I appear", and a sandbag line does not stop a shell.

It is safe on the wire for the same reason the map is. Which rects are low
comes from the layout, the layout comes from the block hash, and two clients
that agree on the tip agree on the geometry — a shell being re-simulated on
four machines is still a pure function of `(x, y, angle, t)`. Nothing about it
is derived from a local clock or a local guess. Two predicates rather than a
height field on the rect, because there are exactly two questions anything in
this game asks; whoever wants a genuinely half-height wall can pay for the
third then.

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

## Two views, one camera

`V`, or the **View** button, swaps between the overhead board and a cockpit
inside your own turret. It is remembered across sessions and across a rematch:
somebody who plays in the cockpit wants to be in the cockpit next time without
hunting for the button.

Three things had to change besides where the camera sits.

- **The field of view opens from 40° to 76°, and the near plane comes in from 60
  to 3.** The board fov is chosen to fit a 1600×1200 arena on screen and is a
  letterbox from inside a tank. The near plane matters more: your own barrel ends
  about 45 units from your eye, and at the board's near plane it is simply not
  drawn. That failure renders perfectly — you get a smooth, correct, empty view
  with no tank attached to it.
- **The turret dome comes off.** The gun sits at y=28 and the dome's roof at 36,
  so from any eye high enough to see over the dome your own barrel is behind it.
  The first cut of this was a screen-filling wedge of turret roof with two inches
  of barrel tip poking out of the far side. You are inside this thing; it should
  not be between you and the board. The name plate, the hull pips and the shield
  bubble come off for the same reason — the last one is a translucent sphere the
  camera sits *inside*, which is a blue wash over the whole screen rather than a
  bubble — and the HUD already says all three in words.
- **The eye is pulled in when there is a wall behind you.** It rides a little way
  off the back of the hull, which is what makes the barrel converge on the
  crosshair instead of pointing straight at the camera as a stub. Reverse into
  cover and that puts the camera inside the wall, looking out through its back
  face at everything the wall exists to hide. `placeEye` walks it forward until
  it is in the open.

### Aim is a bearing off the hull, never off the camera

This is the one that is not obvious, and it is a bug that renders beautifully.

In cockpit view the camera yaws with the gun. So reading the cursor's horizontal
offset against the *camera's* yaw is a feedback loop with no fixed point: a
cursor a little off centre turns the turret, which turns the camera, which leaves
the cursor exactly as far off centre as it was. The turret spins at its full slew
rate while the mouse sits perfectly still.

The cursor is therefore read as an angle from the **hull**, which does not move
because you moved the mouse. Screen centre is dead ahead of the vehicle, the
edges are ±105°, and the camera follows the gun wherever inside that arc it ends
up. That is also the honest model: a real turret's traverse is a bearing relative
to the vehicle, not relative to where the gunner happens to be looking.

The board camera's flat-plane raycast is no use here either. An eye at height 50
looking a few degrees below level meets the aim plane at height 22 hundreds of
metres away, and meets it *behind the camera* the moment you look up.

Cockpit is single-player only, and the button says so rather than going quiet.
There is one camera and a couch match has two people looking at it; the board is
genuinely a shared picture and a cockpit is one player's eyes. Split-screen is
the real fix and it is a bigger change than this one.

### The sticks stop being screen-space

`Input` reads a gamepad's sticks and a phone's thumb sticks raw, because screen
space and board space line up — the board camera is a single pitch with no roll,
so screen-right is world +x and screen-down is world +z, and the note above
`Input` says so. That fact is about the camera, and the cockpit camera breaks it:
it yaws with the gun, so screen-right becomes "whichever way the turret is
currently facing".

Left alone, a pad in the cockpit aims at a compass the player cannot see. Push
the right stick up and the gun swings to world-north regardless of which way the
tank is pointing. So `Input.hullRelative` rotates both stick vectors into the
hull's frame while the camera is inside the tank: screen-up is the direction the
vehicle is pointing, screen-right is its right side.

Two things it deliberately does not touch. The mouse, which never went through
here — `Renderer.toWorld` already answers a cockpit cursor as a bearing on the
aim arc. And the `tank` control scheme's throttle and steer, which are relative
to the vehicle by definition; rotating those would turn "forward" into a slow
spin. Only the readings that are a *direction on the board* — the direct
scheme's drive vector, and every aim — are rotated.

The guard is in `npm run test:controls`, and each case starts the gun 90 degrees
from the right answer *and* 90 degrees from the board-space answer, so the
turret can reach either one inside the window. An earlier draft parked the gun
where the correct answer already was, which would have passed against a build
that ignored the stick entirely. The two answers are 180 degrees apart at a hull
of 90, which is not a gap a tolerance can blur.


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

## Finding a game

A room in this game is a string two people agreed on. That is wonderfully simple
— no server, no registry, no permission — and it means nobody can find one. So
there is a lobby, built the same way everything else here is: each client says
where it is, and everyone else adds it up.

Every client in a room publishes a **presence beacon** every thirty seconds. It
carries the room, a callsign, a colour, the block and board being played, and a
role. The lobby groups them into open tables:

* **seat** — playing. Four seats to a room, because there are four spawns.
* **queue** — the table was full when you arrived, so you are in the room
  watching, and you drop into the next seat that frees up.
* **watch** — a spectator by choice, with no tank at all.

A spectator is not a special client. It is an ordinary one with three things
switched off: it does not drive, it does not publish state, and it does not
attest a session — so nobody else's roster, scoreboard or spawn logic learns it
exists. Everything a spectator *does* do goes through the same code a player's
does, which is the only version of this that stays correct as the game changes.

### Why the beacon is stored and not ephemeral

The room already broadcasts a session attestation on an ephemeral kind, and that
is exactly the wrong shape for a lobby: relays forward ephemeral events only to
clients connected at that instant and cannot be asked for them afterwards. A
player sitting on the lobby screen would see a room only when somebody happened
to re-announce, and a game that had been running for an hour would be invisible.

So presence is an addressable record with a NIP-40 `expiration`. One slot per
player, queryable by a client that just opened the page, and dropped by the relay
on schedule rather than leaving the lobby full of ghosts.

The TTL is 120 seconds against a 30-second republish — four intervals of
headroom, on purpose. NIP-40 is evaluated against the **relay's** clock, so the
expiry is protection against skew rather than a tidy-up interval, and a beacon
that expires early takes a live room off everybody's screen. The cost of the
other direction is that somebody who closes their tab lingers for a couple of
minutes, which is a wasted click rather than a lost game.

The lobby query carries no `since`, also on purpose. A `since` is our clock,
matched by the relay against `created_at` values other people wrote — a client
running a minute fast would receive an empty lobby and have no way to tell that
from a quiet night. It is bounded with `limit` instead, NIP-40 does the expiring,
and obvious ghosts are dropped client-side with a wide margin.

### None of it is enforced

There is no server, so there is nothing to enforce with. Nobody can stop a fifth
player driving into a four-seat room; a client can claim to be somewhere it is
not; two queued players can both see the same seat open and both take it. That
last one makes a five-tank round, not a crash.

This is a notice board, not a matchmaker. Every count on it is what people said
about themselves — exactly like the leaderboard, and it says so on screen.

## Protocol

Everything travels as Nostr events. High-frequency data uses **ephemeral kinds**
(20000–29999): relays forward them and store nothing, which is exactly right for
tick data. Every event carries `["t", "tankarena-<room>"]`, so one `#t` filter
subscribes you to an entire match.

| Kind | Name | Storage | Signed by | Content |
|------|------|---------|-----------|---------|
| `21003` | session attestation | ephemeral | **real npub** | `{ s, name, color, exp }` |
| `21000` | tank state tick | ephemeral | session key | `{ t, x, y, h, g, hp, d, k?, ks?, ds?, r?, a?, sh?, b?, c?, cx?, cy?, tm? }` |
| `21001` | shell fired | ephemeral | session key | `{ id, t0, x, y, a, b?, d? }` |
| `21002` | death report | ephemeral | session key | `{ t, k, x, y }` |
| `21004` | air strike | ephemeral | session key | `{ t0, y, dir, n, d }` |
| `30078` | score record | addressable (NIP-78) | **real npub** | `{ kills, deaths, room, at }` |
| `30078` | pickup claim | addressable (NIP-78) + NIP-40 | session key | `{ id, kind, at }` |
| `30078` | room presence | addressable (NIP-78) + NIP-40 | **real npub** | `{ room, name, hue, role, block?, layout?, at }` |

Field key: `s` session pubkey, `t`/`t0` sender clock in ms, `h` hull heading,
`g` gun heading, `d` dead flag, `k` kills in a row, `a` shell angle, `b` the
shell's bounce budget, `k` on a death report is the killer's session pubkey
(`null` for a self-destruct). Angles are radians, positions are arena pixels — the
board size is per-layout and lives in `ARENA_W`/`ARENA_H`. Score records use `d`
tag `nostr-tank-arena/score`; the per-block record uses
`nostr-tank-arena/score/<height>`, a pickup claim uses
`nostr-tank-arena/claim/<blockhash-prefix>:<wave>:<pad>:<claimant>`, and a room
presence beacon uses the constant `nostr-tank-arena/here` — one slot per player,
so moving rooms replaces rather than stacks. Presence is additionally indexed
under `["t", "tankarena-live"]`, which is what makes the whole lobby one `#t`
query, and carries a NIP-40 `expiration` 120 seconds out.

`sh` is a shield that is currently up. `b` is a bitmask of which barrels have
been destroyed this round, **unioned** rather than replaced on receipt: a union
is order-independent, idempotent, impossible to un-set, and catches a late
joiner up on the next tick, which a one-off "barrel destroyed" event could never
do. `c`, `cx` and `cy` are the chopper — see [The chopper](#the-chopper) — and
while `c` is present, `x`/`y` are the gunship rather than the tank. `tm` is
the side this tank has declared, 1-5, absent in a free-for-all - see
[Teams](#teams) for why self-declaring it is safe.

`role` is `seat`, `queue` or `watch`. See [Finding a game](#finding-a-game).

Two of those fields are new and both are riders on events that were already
going out, which is the cheapest place to put anything.

`k` on the state tick is your current kill streak. A streak that only shows in
your own HUD is not a streak — it is a number. On the wire, everyone can see the
rainbow ring around the tank that is on a run and decide to do something about
it. It is exactly as trustworthy as the `hp` beside it: self-reported, and always
was.

`ks` and `ds` on the state tick are the sender's own kills and deaths this
round, and `r` is the block height they belong to. The scoreboard is built out
of these rather than out of the death events, because the death events are
ephemeral and therefore cannot add up to a shared number: a player who joins
mid-round has received none of the deaths that already happened and would show
the whole room at 0/0 forever, and a death event that reaches three relays out
of four is counted only by whoever was reading those three. Every client had its
own tally and no two agreed, which is a scoreboard in name only.

A tick, by contrast, arrives ten times a second from the one client that cannot
be missing its own kills. A peer's locally-counted tally is kept as the fallback
for a client too old to send one, and it can only ever be short.

`r` is there because nobody is the host: every client rolls the round when it
personally sees the new tip, and those moments are seconds apart. Without the
stamp, a peer who has not rolled yet keeps pushing last round's tally into a
scoreboard that has just reset. A tally from a round we are not playing is
dropped, which costs that peer about a second of showing 0/0.

Self-reported, therefore forgeable — see [How to cheat this](#how-to-cheat-this),
where this is item 5 and the trade is written out.

`a` on the state tick is how many shells are left in the sender's magazine, 0
while reloading. It is on the wire for a gameplay reason rather than a
bookkeeping one: an empty magazine is only a real cost if the tank across the
arena can *see* it. A reload nobody can read is a private pause; a reload
everybody can read is the two and a half seconds in which the right play is to
close the distance. A tank with an empty magazine wears a charcoal name plate
with an amber rim, which is a change no player hue can imitate — hues come from
a fixed palette of six saturated colours and that plate is neither saturated nor
coloured.

A magazine is four shells and a full reload is 2.4 seconds against 1.05 seconds
between shots, so the reload costs roughly three quarters of the time you spent
shooting. Empty always reloads by itself — a phone has no key to press — and
`R` (or button 2 on a pad, which is X on an Xbox and Square on a DualSense)
tops up early, which is the interesting decision: spend the time in cover now,
or gamble that two shells is enough.

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

`publish()` returns an outcome for exactly this reason, and it answers two
questions that turned out not to be the same one:

| question | counts |
|---|---|
| should I give up on this relay? | `refused` only |
| does this event exist anywhere? | `refused` **and** `malformed`, or nothing sent |

`malformed` is a *stronger* verdict than a policy refusal, not a weaker one.
`invalid:` is emitted before storage — never stored, never forwarded — and a bad
event is bad at **every** relay, including the muted ones that were never asked.
A refusal only tells you about the relays in `targets`. So a claim every relay
answers `invalid: event expired` — the one total publish failure anybody in this
thread has actually observed, and the exact case the rollback exists for — has to
count, and keying the rollback on refusals alone let it through untouched.

The pad is never restored on silence or a timeout: the event may well have
landed, and putting it back then would be inventing a divergence rather than
repairing one. Splitting refusal from silence is what makes the rollback safe to
write at all.

The rollback travels the same way the claim did. `publishClaim` mirrors before
publishing, so the other local player already marked that pad taken — undoing it
on the publishing client alone leaves player one agreeing with the room and
player two not, and it does not heal, because player two keeps the id and
re-marks the pad on every rebuild. A player who took the pad *themselves* is
never rolled back; undoing a real grab because somebody else's claim failed is a
second divergence rather than the repair of the first.

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
5. **Inflate the in-round scoreboard.** Each tank's state tick carries its own
   kills and deaths (`ks`/`ds`), and everyone else's scoreboard believes it. A
   patched client can send any pair it likes. The numbers are clamped to
   0-9999 so a hostile tick cannot take the panel out, and a tally stamped with
   a block height we are not playing is dropped — but within those bounds it is
   a self-reported number, exactly like the `hp` beside it.

   This was a deliberate trade and the alternative was worse. The scoreboard
   used to be built from the ephemeral death events each client personally
   received, which needs no trust at all and produced a different scoreboard on
   every screen: a player who joined mid-round had received none of the deaths
   that already happened and showed the whole room at 0/0 permanently, and a
   death event that reached three relays out of four was counted only by
   whoever read those three. An unforgeable number that no two players agree on
   is not a scoreboard. The cheat this opens is the one the leaderboard (3) has
   always had, and the fix is the same fix: countersigned kills.

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

Defaults, fastest first, are `coolfeed.feeds.relay.tools`, `relay.mostr.pub`,
`relay.primal.net` and `purplerelay.com`. Override them in the lobby under
**Relays**. The order matters: `Net` walks the list in order, so first is the
socket carrying the tick stream.
(This line said `relay.damus.io`, `nos.lol`, `relay.primal.net` and
`relay.nostr.band` long after the code had stopped agreeing — three of those
four are measured below as unusable for a tick stream.)

### A new default has to reach a browser that has already played

The lobby saves your relay list to `localStorage` on every start and reads the
saved list in preference to the defaults, because a relay you deleted should
stay deleted. The consequence went unnoticed for a while and it is severe: the
first match a browser ever plays pins its relay list *forever*. `coolfeed`
shipped as the first default and the person who asked for it could not see it
across three deploys, because his browser had the old three burned in and no
code path could reach him. "It's in the bundle" was true and useless.

So the browser also stores `tank.relays.offered` — the defaults it has already
been shown. On load, `mergeRelays` puts any default missing from that record at
the *front* of the saved list, because the defaults are ordered by measured
delivery latency and a new one is only ever added for a reason. A default that
has been offered and removed stays removed. A browser with no `offered` record
at all has been offered nothing, so the whole default list merges in — that is
the one-time migration for everyone who played before this shipped.

`test/relay-list.mjs` drives a real browser with a stale list in storage. It
fails against the previous code, which is the only reason to believe it.

### The axis nobody was measuring

Everything below measures relays by *what they accept*. That is the question
that gets you thrown off a relay and it is not the question a player feels.
Sixty kind-21000 events at 10Hz, timing each publish from send to its `OK`:

| relay | accepted | p50 | p95 |
|-------|----------|-----|-----|
| `coolfeed.feeds.relay.tools` | 60/60 | **64ms** | **69ms** |
| `relay.mostr.pub` | 60/60 | 150ms | 224ms |
| `relay.primal.net` | 60/60 | 189ms | 202ms |
| `purplerelay.com` | 60/60 | 276ms | 1331ms |

Every one accepted every event, which is exactly why the acceptance probes
never found this: on the only axis being measured they are identical, and on
the axis a player is looking at there is a factor of twenty between best and
worst. A shell travels 430px/s, so purplerelay's tail is over half a board —
the difference between leading a target and shooting where he used to be. It
stays in the list because redundancy beats a tail on the fourth of four
sockets, and it stays last for the same reason it is not worth more than that.

With a control, before any of it was believed: five events per relay with a
corrupted signature, and all four refused all five by name (`invalid: bad
signature`). A latency table from a probe that cannot see a failure is a table
of how fast something said nothing.

The first entry is deliberately a **different implementation**: the first three are
stock strfry, and `coolfeed.feeds.relay.tools` runs newlay 0.3.16. With a
monoculture in front of the game, one vendor's behaviour quietly becomes the
protocol as far as this client is concerned, and no test suite can tell you
which of your assumptions those are. The first time anybody checked a second
implementation, a premise the newest fix rested on broke — newlay flushes a
subscription's live buffer *before* `EOSE`.

Verified unauthenticated in both directions before it went in the list, with
two sockets, because an `OK` is only worth what a separate subscriber can see:
one socket subscribed to a fresh room tag, a second published a kind 21000 into
it, and the first received it. Its NIP-11 reports `publishing_rate_limit: 1200`
per minute, which is twenty a second against a tick stream of ten. Kind 30078
score records are refused there — the gate is a follow graph and a guest's
session key is followed by nobody — which costs nothing while three other
relays store them, and the HUD deliberately stays quiet about it.

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

Six of them, on six pads, and most of the round the board is empty.

| Pickup | What it does |
|--------|--------------|
| Repair | Full hull, instantly. |
| Rapid fire | Reload in a blink, 12s. |
| Shield | The next shot bounces off, 14s. |
| Overdrive | Move like you stole it, 10s. |
| Scattershot | Three shells a shot, 14s. |
| Siege shells | Double damage, 10s. |

### The schedule, and why "random" is hard here

An item you can count on is not worth crossing the map for. Three earlier
versions of this got steadily less generous — 22 seconds, then 34, then this —
and the current one is built around a different question: not *how often*, but
*how predictable*.

What it does now:

* **One pad a wave, sometimes two.** It used to stock every pad but one, which
  meant nobody contested anything: you took the nearest and so did everyone
  else. One item means somebody does not get it.
* **The gap between waves runs 26 to 78 seconds**, averaging 52. The frame is
  fixed at 52 seconds so the wave index stays cheap to compute, but the spawn
  *moment* moves inside it — so you cannot count to the next one.
* **A pad never lights twice running**, and across each cycle every pad is used,
  so no corner of the board is quietly dead.
* **Six pads per board**, up from four.

The hard part is that all of that has to be *derived*, identically, on every
client, with nothing on the wire — the wave index goes inside the pickup id, so
two clients that disagree about it compute different ids for the same pad and
silently discard each other's claims.

That rules out the obvious implementation. "Shuffle the pads, then drop whatever
the previous wave used" needs to know the previous wave, which needs the wave
before it, all the way back to wave zero — and on the fallback clock (see below)
the wave index is around fifty million. Nothing may walk backwards.

So the no-repeat rule is structural rather than a filter. Waves come in cycles;
each cycle gets a permutation of the pads derived from the block hash; wave *n*
takes a two-wide window of it. Windows inside a cycle are disjoint slices of one
permutation, so they cannot collide. That leaves exactly one seam — the last
wave of a cycle against the first of the next — and the incoming permutation
closes it by moving any pad the outgoing wave used out of its own first window.
The seam fix only ever touches slots *before* the final window, which is what
keeps the whole thing O(1): the final window is always the raw shuffle, so the
next cycle can reconstruct it without knowing anything about the cycle before.

Supply Run halves the frame and stocks two pads every time, deliberately.

`test/pads.mjs` checks all of this as arithmetic over forty block hashes and
forty minutes of round clock each, with no browser and no relay: no consecutive
repeats, no starved pad, no metronome, and the fallback clock answered in
microseconds. Each of those assertions has been watched to fail against a
deliberately broken schedule.

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

### The picture is the character

Every tank carries a driver, and the driver's head is your kind 0 picture: the
shoulders are geometry, the head is the portrait, ringed in your player colour
and outlined in the same near-black the tanks wear. It rides the turret, so the
character turns to look wherever the gun is pointing.

Head and portrait are the same object on purpose. Drawing a sphere *and* a
billboard puts two heads at the same height, which is what the first cut did — a
grey ball parked in front of the face it was meant to be. A billboard rather than
a texture on geometry, because the board is seen from one fixed high angle and a
portrait mapped onto a sphere is edge-on from most of it.

The picture goes through a 2D canvas before it reaches WebGL, and both halves of
that are load-bearing:

- The `<img>` is loaded with `crossOrigin = 'anonymous'`. Without it the draw
  succeeds, the canvas is silently *tainted*, and the failure surfaces later as a
  `SecurityError` thrown out of `texImage2D` — inside the render loop, one frame
  after the picture arrived.
- With it, a host that sends no CORS headers fails the load outright. Profile
  pictures live on whatever host their owner chose and a good number of them send
  no headers at all. That is not a broken profile and must not look like one, so
  every avatar is painted as a coloured initials disc **first** and only upgrades
  itself if the fetch works. Nothing ever waits on a picture to draw a frame.

The initials skip the `npub1` prefix, because "NP" for all four players is worse
than useless. A failed load is cached exactly like a successful one, so a host
with no headers is asked once per session rather than once per respawn. And the
texture object is created once and repainted in place — swapping the map on a
live material every time a picture lands leaks a texture per tank per round.

A guest key has no npub and so is given no picture at all, only the disc. That is
deliberate: a guest is genuinely anonymous and dressing one up as somebody is the
wrong signal to send in a game whose whole scoreboard is signed.

## When it is your clock, the game says so

Every other warning in this game is about somebody else's machine — a relay
refusing, a peer dropping — and the honest response to those is to keep playing.
One is not. If **every** relay calls our events `invalid:` several publishes in a
row, that is not a relay having an opinion, it is a fact about this computer:
newlay's window is 365 days behind and fifteen minutes ahead, so realistically
the clock here is fast.

The classifier is right not to mute for it — a bad event is our fault, not the
relay's — which means without a separate lever the client hammers every relay for
the whole session. Correct behaviour, worst outcome. So `Net` raises a
`clockAlarm`, publishing holds except for one probe every 20 seconds, and the HUD
puts it in the middle of the screen where it does not time out. It is the only
failure in the whole game a player can go and fix.

The relay's own words are quoted rather than paraphrased. `invalid: created_at
too far in the future (window 900000 ms)` is a sentence somebody can act on;
"network error" is not, and inventing a friendlier version would throw away the
only part with a number in it.

### The clock that is merely behind

There are two clock failures and only one of them is loud.

A **fast** clock is rejected by `created_at_msecs_ahead`, fifteen minutes, and
nothing lands at all — the all-malformed streak above sees it immediately.

A **slow** clock is nearly invisible, and it is invisible *because it is free*.
The past tolerance is `created_at_msecs_ago`, **365 days**, so every tick, shell
and death is accepted normally. `invalid: event expired` is the NIP-40 gate, and
it only fires for an event that carries an `expiration` tag — in this whole game
exactly one does. So the ticks land ten a second, each acceptance resets a streak
that needs five in a row, and the all-malformed alarm can never reach it.

What the player gets is a game that looks perfectly normal in which **every
pickup they take comes straight back**, all session. Not once — every single one,
because the claim dies at the relay and the rollback correctly restores the pad.
No rate limit, no behaviour penalty, no symptom anywhere on screen.

So it has its own signal, and the shape of the evidence is what makes it
trustworthy:

> two or more relays rejected the last claims as already expired, **while state
> ticks from this same session are being accepted**

Which regime you are in depends on the relay, and both are covered by different
code:

| tolerance for an *old* event | tick | claim | dies first | seen by |
|---|---|---|---|---|
| newlay | 365 days | 600s | the claim | the signal below |
| strfry (all three in the shipped list) | **60s** ephemeral | 600s | the ticks | `Net`'s quorum alarm |

On strfry a clock sixty-one seconds slow kills every tick, which is loud, and the
quorum alarm names it. The signal below is for the other ordering, where the
relay is happy to take a year-old tick and the only casualty is the one event
carrying a deadline of ours.

The ticks landing are not noise to filter out, they are the *control*. They prove
the relays are reachable, that they are reading our events, and that nothing else
about this client is wrong. A relay that takes a tick and refuses a claim
carrying `created_at + CLAIM_TTL` has told us one thing and only one thing.

Two relays, never one — a relay disagreeing about the time is the relay, and the
filter bias that let a single relay accuse the clock applies here too, since a
relay that only ever answers `invalid:` is exactly the one muting can never
remove. And the number on the screen is **ours**: `event expired` carries no
`window` because the deadline was ours to choose, so `CLAIM_TTL` is both what had
to be outlived and what to put in front of the player.

It is an honest *relative* verdict. It says our clock and theirs disagree by more
than ten minutes in that direction, which is what somebody needs in order to go
and fix it, but it cannot rule out two relays that are both fast. The quorum is
what makes that unlikely.

### The local clock is off the read path

A subscriber's clock has no business in a filter the **relay** evaluates.

The live subscription used to carry `since: now - 30`. A clock ahead by more than
thirty seconds makes `since` later than the `created_at` every other player
stamps — and a relay applies a filter to live events, not only to backfill. So:

**Five minutes fast, and every other tank is invisible to you, while your own
tank is on all of their screens and every shell you fire lands.** Nothing refuses
anything; these relays tolerate fifteen minutes forward on the write path. No
rejection, no streak, no quorum, no alarm. It was arithmetic on a number we
chose, not a relay's policy.

The obvious self-check gives a false all-clear, and that is the part worth
remembering. "Are we getting our own ticks back?" — yes, always, because our
`created_at` and our `since` come from the same broken clock. **The filter selects
exactly the events stamped wrong and rejects every event stamped right.** Loopback
green, room empty. It takes a second client to see it, and the suite now runs one
with `Date.now` moved five minutes forward.

Both subscriptions are bounded by `limit` now. The room tag already narrows them,
and these relays keep ephemeral events for five minutes.

### Nothing is replayed into a live match

Dropping `since` fixed the clock and removed the only thing keeping a **finished
match** out of a fresh join. A `limit` does not replace it: the count never binds,
because it does not drop until the relay's store drops it — and the real bound
turned out to be `ephemeralEventsLifetimeSeconds`, a default in three config
files nobody here owns. cowboy measured a firefight arriving intact three and a
half minutes after it ended, on all three relays.

What a joining player got: shells from a match that was over spawning at the
muzzle and taking hull points off them, somebody else's deaths in their kill feed
and on their scoreboard, and ghost tanks standing in the arena for nine seconds.

The fast-forward in `onShell` looks like it bounds this and cannot. For a peer
never seen before, `updateOffset` seeds `peer.offset` from that very event, so
the computed lateness is exactly zero and a shell fired minutes ago arrives with
its full four seconds of flight and its full damage. **A staleness check whose
reference is derived from the stale data** — the same shape as a loopback that
passes because both sides come off the same broken clock.

**EOSE is the boundary.** Every relay sends it when its store is exhausted; it is
exact, it is per relay, and it needs no clock, no `since` and nothing agreed with
anybody. Everything before it is dropped.

That last sentence is a **trade, not a fact**, and it is worth being exact about
which. "Pre-EOSE means stored" holds on strfry — measured with a second of
margin: forty shells published during a deliberately slow store pass, none
delivered early and none lost. It does *not* hold on newlay, which registers a
subscription before running the query — deliberately, to close the gap where a
live event falls between the scan and the live path — and flushes that buffer
*before* sending EOSE. There, a shell fired at you while your subscription is
opening arrives pre-EOSE and this rule throws it away.

Kept anyway, because the two errors are not the same size. Dropping a live event
costs a few milliseconds of a window that only exists while joining, and every
kind here survives it: a tick is replaced 100ms later, an attestation is
re-announced when a new peer appears, and a missed shell is a hit that never
lands on a victim who is authoritative over its own hull regardless. Accepting a
stored one costs a ghost match. `Game.storedDropped` counts them so the trade is
observable rather than an assumption.

Rate does not say which population they came from, which is a correction to an
earlier version of this note. A relay that flushes its live buffer onto the
stored side does it once per subscription registration and then goes live —
bounded by however long its historical query took, and so the same shape as a
stored replay: a burst at join, then nothing. A *sustained* climb is therefore
not ordering at all, it is churn, something resubscribing over and over and
re-opening its own pre-EOSE window each pass.

Age is the discriminator, and `Game.storedFresh` is the half of the count that
carries it. A stored ghost is seconds to minutes old; a live event flushed early
is milliseconds old, and no plausible clock skew closes a gap that wide. Only
that half is worth a player's attention — it is the half that cost a real event
— so it is the half the HUD says out loud, and the drop count on its own stays
off the screen. Read it as a relative signal: the subtraction is against our own
clock, so a skewed client shifts every reading by its own offset.

This is also the clearest bill for the monoculture. Three stock strfry is three
votes and one opinion, and the first thing a second implementation did was
contradict a premise this fix rests on. A client with one relay implementation in
front of it has silently encoded that implementation's behaviour as the
protocol's, and no suite can tell you which assumptions those are until something
else answers. A shell fired before you joined is not
a shell, it is a record that one was fired, and there is no such thing as a late
one.

Not even the roster survives: a stored tick names somebody who *was* here and
does not place them. So the attestation is re-announced whenever a new peer
appears, and the trigger has to be *a new peer* rather than *somebody unverified*
— the first version used the latter and was one-sided in exactly the way that
matters. The player already in the room sees the newcomer's attestation
immediately, so they have no strangers and no reason to speak, while the newcomer
looks at an anonymous tank until the slow timer comes round. **The one who needs
to be re-announced to is the one who cannot tell they are missing anything.**

### One check for a read path that has stopped

Relays echo our own events back to our own subscription. `onEvent` discards them
a few lines later, but they *arrive* — ten a second, from every relay still
listening — so a healthy read path is never quiet, whether or not anybody else is
in the room. **Silence means the ear is gone, not that the arena is empty.**

Which is one check covering three unrelated causes with one symptom: a dropped
socket, a `CLOSED` we could not act on, and a filter that matches nothing. All
three used to be completely invisible — still publishing, still on everybody
else's screen, seeing nothing.

`sawTraffic` had been wired up the whole time and nothing read it. An instrument
with no consumer is not an instrument.

### The screen names the symptom, not the cause

There are two silent bands and they break opposite things:

| clock | publishing | receiving | what the player sees |
|---|---|---|---|
| >900s ahead | all refused | nothing | everything dead |
| 30–900s ahead | accepted *and delivered* | **nothing** | empty arena, and you are visible in it |
| 60s behind – 30s ahead | fine | fine | healthy |
| 60–600s behind | ticks refused | fine | **nobody moves, pads work perfectly** |
| >600s behind | ticks refused, claims expire | fine | everything dead |

"Your clock is behind" on a screen where every pad behaves beautifully is true and
reads as a lie, because it answers a question the player did not ask. So the
headline is the row of that table — *other players can't see you*, or *every
pickup you take comes straight back* — and the direction goes underneath, where a
cause belongs.

### Direction is counted, not read

The screen used to work out which way the clock was wrong by looking for
"future" or "expired" in the reason. It was tested in both directions and it
never once ran in production, because **three of the four relays this game ships
with say `created_at too late`** — which contains neither word. The suite was
green about a relay the game does not talk to.

`Net` decides direction by counting distinct relays that named the timestamp, so
a wording nobody anticipated cannot silence it, and the screen reads that rather
than the string. The string is still quoted underneath, because it is the only
part with a number in it — when there is one at all. Most relays give none, so
the sentence has to work without it and never invents one.

Above the quote, the screen says which *way* the clock is wrong, because that is
the first thing somebody needs and the relay always says it: `too far in the
future` is a fast clock, `event expired` is a slow one — a NIP-40 expiration
already spent on arrival. A reason with no direction in it gets no invented one;
it still says what to do.

The window is quoted when the relay gives it, and it is worth knowing why that
number can be trusted. `created_at_msecs_ahead` is one of the fields a relay's
behaviour scaling never touches — rate limits move underneath you as your
standing changes, and the tolerance does not. **The one number this screen is
built on is the one number that cannot be stale.**

The suite checks the screen, not the flag — computed style, non-zero height, and
the text — plus the other direction, that a session whose events are landing has
no alarm on the page at all.

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

### The cockpit, and an assertion that had to stop being a count

`npm run test:cockpit` covers the view toggle and the faces. Four of its checks
are ordinary — the camera really is on the tank rather than over the board, the
near plane is in front of the eye, the crosshair's *computed* style rather than
its `hidden` attribute, everything that comes off in the cockpit goes back on.
Two are worth writing down.

**The turret has to stop, and it has to stop at the right angle.** Hold the mouse
well off centre and leave it there. The first version of this counted degrees
travelled over a fixed 1.4 seconds and expected a small number — and it passed
against a build with the camera-relative feedback loop deliberately put back,
because the turret slews at a fixed rate and 1.4 seconds of swiftshader frames is
not long enough for the *working* build to arrive either. Both cases travelled 48
degrees. A window that cannot contain the behaviour cannot report on it.

So it polls until the angle stops moving, and then asserts the angle it stopped
at against the arc the cursor commanded. That is the quantity that differs
between the two. "The turret responded to the mouse" is true of the bug as well
as the fix, and an assertion consistent with both cannot carry the claim. With
the loop put back the guard now reports a bearing of −131° that never settles;
with it removed, 78.8° against 78.8° asked for.

**The faces are driven through the real lookup, not handed to the component.**
The first version called `Avatar.set()` directly and read the canvas — and passed
against a canvas the draw loop had already repainted from the game's own identity
on the very next frame. Handing a component its input tests the component; it
cannot test whether anything ever hands it that input. It now installs a picture
source on the renderer and lets the frame loop carry it down, which is the wiring
that can actually be missing.

What it reads off the canvas is a spread of luminance, not an average colour: a
flat fill is near zero and white initials on a coloured disc are not. An average
cannot tell a rendered glyph from a blank disc, and a blank disc is exactly what
a broken fallback looks like.

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

**The cap is denominated in tokens, not events.** An event costs
`1 + tags.count / 50 + content.length / 8192` — the tag *count*, not tag bytes —
so a position tick with one tag and ~88 characters costs 1.03. Pacing at 0.9
*events* per token of allowance therefore spends 0.927 of the cap, and the
margin that was supposed to be ten percent is seven. It gets worse as tags grow.
The pace is charged against cost now, so the margin is the one in the constant.

So: parse `limit (\d+) events/min`, pace to 90% of it, and do not strike. A
client under the cap takes no rate hits, so its minutes are clean, so the score
climbs and the number in the string goes back up while you watch. The margin
matters — spending a bucket exactly as fast as it refills sits on the boundary,
where jitter alone produces the refusals you are pacing to avoid.

Pacing is a pace, not a ratchet: a relay that has gone quiet gets tried a little
faster, because obeying the number means you stop being refused, so without
probing you would never learn it had forgiven you. There is also a valve — forty
refusals while paced means the number is not the problem, and the relay goes
back on the strike-and-mute path.

**How often to probe, and by how much, is the whole difficulty.** The first
version tried 1.5× every thirty seconds and undid the thing pacing was for.
Recovery is credited per *clean minute* — `advanceMinute` discards a minute
containing any violation at all, not partially — and for an anonymous session
key that is the only recovery channel there is. So a probe that overshoots even
briefly spoils the entire minute, and one every thirty seconds means every
minute is dirty: the score is pushed down −2 at a time and pinned at the floor,
which is the spiral pacing exists to end, at lower amplitude and self-inflicted.
It was also compounding rather than probing, because escalating reset the same
timestamp the quiet test read.

Five minutes and ×1.1 now, with separate clocks for "quiet since refused" and
"quiet since escalated". The arithmetic has to come out positive: one cycle
costs a handful of refusals and one dirty minute, and nine clean minutes at +2
pays for that several times over. At ×1.1 the first step from 0.9× lands at
0.99× — still under the cap, so it is free — and only the second overshoots.

Measured, and the measurement needed care of its own. `TokenBucket(perMin,
perMin)` gives a burst allowance of a whole minute, and pacing at 90% keeps it
nearly full, so the *first* overshoot spends banked tokens rather than tripping
policy and draws no refusal for about ninety seconds. A window that stops there
reports a perfectly happy relay about a client that is on its way to the floor.
So the check drains the bank first and asserts on the segment after it:

```
                    sent/s   refusals/min
1.5x every 30s         1.1            3.0
1.1x every 5min        0.9            0.0
```

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

### When it is not the relays

`malformed` from one relay is that relay being odd. `malformed` from *every*
relay is a fact about this machine, and the two want opposite responses. Muting
is wrong — the relays are fine, and there would be none left — but so is
carrying on, and carrying on is what the client did. The classifier is correctly
not striking for it, so it hammered every relay for the whole session.

The realistic cause is the clock, and newlay's window is asymmetric:
`createdAtMsecsAgo` is 365 days, `createdAtMsecsAhead` is fifteen minutes. A
clock *behind* is cheap — only the NIP-40 claim dies, and that rejection comes
off the store rather than the policy engine, so it costs no behaviour score. A
clock more than fifteen minutes *ahead* makes every event
`invalid: created_at too far in the future`, and that path books a **−4**,
twice a rate hit. At the measured 6.3 events/sec that is about −25 a second: the
connection is floored inside three seconds, before the player has finished
reading the lobby.

So five consecutive publishes that every asked relay calls invalid raise
`net.clockAlarm`, publishing holds, and the relay's own words go on the screen.
It is the only failure in this game a player can go and fix.

### The fourth relay was not a relay

`wss://relay.fountain.fm` shipped in `DEFAULT_RELAYS` and has been removed.
Measured with two sockets — one subscribed to the room *before* anything was
published, one publishing — because an `OK` is only worth what a separate
subscriber can see:

```
relay.primal.net    kind 21000   OK true    delivered true
purplerelay.com     kind 21000   OK true    delivered true
relay.mostr.pub     kind 21000   OK true    delivered true
relay.fountain.fm   kind 21000   OK true    delivered FALSE
```

Asked to read rather than write, it answers
`["CLOSED", id, "kinds not supported"]` for 21000, 21001, 21003 and 30078 —
every kind this game uses — while serving 0, 3, 30023 and 30311. It is a podcast
relay. It took a quarter of the traffic and printed a receipt.

That cost more than bandwidth. **An `OK true` from a relay that never parsed the
event is not weak evidence of a healthy clock, it is no evidence at all** — and
it was enough to acquit three relays that had read the timestamp and named the
same fault.

### What the shipped relays actually do, measured

Three of the four run **strfry**, not newlay, and one runs something that
identifies itself as nothing at all:

```
relay.primal.net     strfry 1.0.3-1-g60d35a6
purplerelay.com      strfry 1.0.4-60-g453bbee
relay.mostr.pub      strfry 1.0.4
relay.fountain.fm    (no software field)
```

Publishing an ephemeral kind 21000 with a backdated `created_at`:

```
                       -0s   -30s   -61s   -90s   -300s  -3600s  +1800s
relay.primal.net        ok     ok  REJECT REJECT  REJECT  REJECT  REJECT
purplerelay.com         ok     ok  REJECT REJECT  REJECT  REJECT  REJECT
relay.mostr.pub         ok     ok  REJECT REJECT  REJECT  REJECT  REJECT
relay.fountain.fm       ok     ok      ok     ok      ok      ok      ok
```

**Sixty seconds.** Every hot kind in this game is ephemeral, and strfry rejects
an ephemeral event more than a minute old — `invalid: ephemeral event expired` —
against a three-year window for stored ones. A laptop a minute out of sync is
not a broken machine, and on three of four relays it stops publishing entirely.

Two things fall out of that table. `invalid: created_at too late` is how strfry
says *ahead*, and it contains neither "future" nor "expired" — a client reading
direction by looking for those words learns nothing from three of its four
relays. And `relay.fountain.fm` has **no timestamp gate at all**: it took an
hour backdated and half an hour forward without complaint.

**Only relays that examined the timestamp get a vote.** newlay checks whether
you are going too fast before it checks whether you are wrong: the events bucket
and the per-IP gate both run above the `created_at` check, and they are the only
gates that answer `rate-limited:`. So that one prefix is positive proof the relay
never reached the question. Every other refusal — `blocked:`, `restricted:`,
`auth-required:`, `pow:` — comes from below the line, which means `created_at`
was examined and passed, and those are *stronger* evidence the clock is fine
than an acceptance is.

One prefix out of eight means the opposite of the other seven, and treating them
alike was not a corner case: the pacer manufactures a rate limit deliberately and
forever, because escalating ×1.1 and snapping back on the next refusal is the
feedback signal. Three relays refusing every event because the clock is fifteen
minutes ahead, one paced relay saying "slow down", and the alarm could never
raise — not unanimous, *and* the streak zeroed on every publish. The player's
clock is wrong, three relays are refusing everything at −4 apiece, and the screen
says nothing for the entire session.

So the denominator is relays that voted on the clock — acceptances, malformed
verdicts, and refusals from below the gate — and an acquittal needs one of the
same. A relay that told us to slow down has not vouched for us.

**Only a witness can recant.** An acquittal has to come from a relay that could
have convicted, and that rule was enforced on the raising side and not the
clearing one. It mattered because of the probe: while the alarm is up exactly
one relay is asked per cycle, and a relay that never refuses never mutes, so it
never leaves the rotation. Its turn came round, its acceptance zeroed the
streak, publishing resumed at ten a second into relays refusing every event, and
the quorum raised the alarm again half a second later.

```
alarm sampled 86x over 22s with a 1.2s probe cycle:  9 blinks   before
alarm sampled 88x over 22s with a 1.2s probe cycle:  0 blinks   after
```

An acceptance now clears the alarm only if it came from a relay that named the
fault itself. Refusals from below the timestamp gate still clear it, because
those are relays that read the clock and passed it.

**Quorum, not unanimity, and the difference is the whole production case.** Two
relays independently naming the same direction raise the alarm even if another
accepts, because an acceptance is weak evidence — it means the relay did not
object, and a relay with no gate never will. Under a unanimity rule
`relay.fountain.fm` sank the alarm on every publish and cleared the streak
besides: three quarters of the list refusing every event, the game invisible to
anyone not connected through the fourth, and the screen silent.

**Only an `invalid:` that names the timestamp votes on it.** Both
implementations reject on shape *before* they look at `created_at` — newlay's
`too many tags`, `content too long` and `missing required tag`, strfry's `too
many tags`. Two relays configured tighter than the tick is two relays agreeing,
and under a rule that counts the kind rather than the cause that is a quorum:
publishing held, and the screen telling a player to fix a clock that is correct.

**And the quoted reason is one at least two of them gave.** It used to be
last-writer-wins across every relay and every cause, so relay A rejecting on tag
count and relay B on the timestamp read as agreement and the screen quoted
whichever landed last.

**Half the list has to be visible.**
"Every relay we asked" is not "every relay", and the difference is biased in
exactly the wrong direction: a relay that only ever answers `invalid:` can never
be muted — malformed does not strike, because our own bad event is not the
relay's fault — while relays that *refuse* us do get muted. So the filter
systematically removes the relays that would contradict the alarm and keeps the
one raising it. The odd relay is the survivor by construction.

One relay configured with a lower `max_event_tags` than the tick needs, three
muted on something ordinary, and the screen tells the player their clock is
wrong when it is fine — while publishing stops. If you cannot see the others you
cannot tell, and "cannot tell" is not "blame the machine".

**The probe goes to one relay per cycle, not all of them.** The first version
broadcast every twenty seconds, which is the pace probe's bug at twice the
price: the `created_at` gate books −4 rather than a rate hit's −2, so three
probes a minute is −12/min against a recovery that never accrues. Floored in
three and a half minutes and pinned there — and the cruelty is the timing, since
the player then fixes their clock and meets twenty-five minutes of 0.1×
multiplier on the way out. A cycle of M minutes nets `2(M−1) − 4`, so M must be
at least four.

Round-robin gets that without slowing detection, because any single acceptance
clears the streak: one relay a minute finds a corrected clock exactly as fast as
all four would, at a quarter of the cost each. A probe asks one relay and so can
never satisfy the two-relay rule, which is deliberate — a probe should be able
to clear the alarm and never to deepen it.

```
                    per relay over 16 cycles   total
broadcast                 16 / 16 / 16 / 16       64
round-robin                  4 / 4 / 4 / 4        16
```

```
                          events/s across two invalid-rejecting relays
before                                                          15.17
after                                                            0.00 + probes
```

Silence does not clear the alarm, only an acceptance or an ordinary refusal
does: an unreachable relay is no evidence that the clock came right.

### Reconnection is ours, because the library rewrites the filter

`enableReconnect: true` does resubscribe — measured in Chrome, both a close
frame and a TCP-level drop come back. What it also does is rewrite the filter on
the way: `sub.filters[f].since = sub.lastEmitted + 1`. And `lastEmitted` is the
maximum `created_at` **received**, set outside the `matchFilters` branch — so it
is not "the newest event we accepted", it is the furthest-ahead clock in the
room.

One peer stamped five minutes fast, which no relay refuses because it is inside
every forward window, and the resubscribe asks for `since: now + 301`. That is
the `since` bug deleted from `game.ts`, coming back through the library on
somebody else's clock.

Worse, the filter object was shared across the per-relay subscriptions, and
`matchFilters` runs client-side on every inbound event. Measured with two relays
and only one of them dropped:

```
filter before any drop        {kinds, #t}
filter after A reconnected    {kinds, #t, since: now+301}
B's REQ on the wire           {kinds, #t}        <- B never resubscribed
B's events delivered after    false              <- discarded locally
```

One relay's reconnect blinds all of them, against a filter B never sent.

So the pool is constructed with `enableReconnect: false` and this file owns the
reconnect: a fresh `subscribeMany` with a filter it built, cloned per relay.
Backoff starts at 400ms rather than the library's ten seconds, and resets when
the relay accepts the REQ.

Routing matters, because two different things arrive on one `onclose` with
nothing but wording to tell them apart. The first version matched
`/^relay connection/i`, and that covers a socket which died *after* connecting
and nothing else — a relay that was never there fails a different way and the
string has no `relay ` on it at all:

```
nothing listening         "connection failed"
DNS does not resolve      "connection failed"
black hole, times out     "connection timed out"
died after connecting     "relay connection closed"
```

So the ordinary case — a tab opened before the wifi associated, a relay in
maintenance, a captive portal — was filed as a verdict: never retried for the
whole session, and quoted on screen as the relay's own words when no relay had
spoken. Measured against the shipped build, a relay that came up thirty seconds
after the join got **zero** further requests.

```
matches a transport wording   the socket died or was never there   reconnect
"closed by us|caller"         we closed it                         neither
anything else                 a relay declined our filter          report, retry slowly
```

**Routing on NIP-01's prefix instead is the obvious fix and it is wrong in the
live direction.** The spec says a `CLOSED` reason *should* carry a
machine-readable prefix; relays do not have to. `relay.fountain.fm` answers
`CLOSED ... "kinds not supported"` — a real verdict with no prefix — and a
prefix-only rule retries it at five requests a second, forever.

So the transport wordings are matched explicitly and everything else is taken to
be a relay speaking, which is the safer default of the two. And the cost of
being wrong is capped rather than permanent: a verdict is retried once every
five minutes rather than never, so a reconfigured relay or a wording this file
guessed wrong about does not cost the session. Resubscribing at socket speed is
the loop that branch exists to avoid; once in five minutes is not.

`deafRelays` holds verdicts and is safe to quote. `unreachableRelays` holds the
library's account of a silence and is not — putting it on a screen as "the relay
said" would be inventing a speaker.

**A subscription is identified by which `subscribe()` call it belongs to and
which relay — not by the relay alone.** Keying on the URL made the second call
close the first one's subscription on every relay, which is the read path going
dark by way of the code written to keep it alive.

### The read path has to survive a dropped socket

nostr-tools defaults `enableReconnect` to false. A hard close then runs
`closeAllSubscriptions(reason)` with nothing behind it, and nothing in this
client resubscribes — `subscribe()` is called twice, from `Game.start()`, and
never again.

**Publishing recovers on its own and reading does not.** The next publish builds
a fresh socket through `ensureRelay()`; the subscription that died with the old
one stays dead. So one wifi change, one laptop sleep, one edge cycling the
connection, and that relay is write-only for the rest of the session: ten
publishes a second into a game that cannot be seen, with no error, no refusal,
no streak and nothing on the screen.

```
                                    before   after
peer tick before the socket drop        ok      ok
peer tick after the socket drop     NOTHING      ok
publishing after the socket drop        ok      ok
```

It is the same shape as the `since` blackout and it arrives by a completely
different road, which is what makes the shape the finding rather than either
bug: **every failure this file has caught is one where we stay visible and stop
seeing.** The publish path has eight prefixes, a ledger, a quorum and an alarm.
The read path had no instrument at all.

With reconnect on, a drop schedules a backoff reconnect and every open
subscription is re-fired — and nostr-tools rewrites each filter's `since` to
`lastEmitted + 1` on the way, so the replay is bounded by what has already been
seen rather than by the relay's retention.

One consequence of the per-relay subscriptions below: nostr-tools allocates
`_knownIds` per `subscribeMany` call, so three calls means three sets and every
event arrives about three times. `Game.onEvent` keys on id and catches them, but
its set rotates on a fixed *count*, so three times the traffic is a third of the
dedupe window in time — harmless while nothing replays, and reconnection
replays. One shared `alreadyHaveEvent` across the three puts the window back.

### A relay that hangs up is not a quiet relay

`subscribe()` opens one subscription per relay rather than one across all of
them. `subscribeMany` takes a single `onclose` and only fires it once *every*
relay has closed, which is the case that needs no reporting; the case that does
is one relay dropping out of a set that is otherwise fine.

That is not hypothetical and it does not need a broken clock: a relay can answer
`CLOSED ... kinds not supported` for every kind this game uses while returning
`OK true` to publishes of the same kinds. Discarding that frame makes the relay
permanently silent and indistinguishable from a quiet one, while the publish
path goes on counting it live. `net.deafRelays` reports them in their own words — and only their own words. A
`CLOSED` frame is a verdict: the relay read the filter and declined it. A
dropped socket is silence, and nostr-tools supplies the wording for those
itself. This file's own rule is that silence is not a verdict, so the two are
kept apart rather than both rendered as "the relay said".

One subscription each costs nothing on the wire — the pool still dedupes
connections by URL — and duplicate deliveries were already handled, because
relays echo and `Game.onEvent` keys on event id.

## Tuning

Every number that decides how the game feels is at the top of `src/sim.ts`:
speeds, turn rates, shell velocity, reload, respawn delay, HP. Time-to-kill is
three shells at a 1.05s reload, so a clean duel is about 3 seconds of hits inside
a longer fight for position.

## License

MIT.
