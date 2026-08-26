# Roadmap

The backlog itself lives on the relay as NIP-34 issues and is readable at
**https://tankops.vercel.app** — pending, in progress and done, with the npub that
signed each state change. This file is the *shape* of it: what order things go in and
why, which is the one thing a list of issues cannot tell you.

Read the board for status. Read this for intent. When they disagree, **the board is
right** — it is derived from signed events and this is a document somebody has to
remember to update.

Live: **https://nostr-tank-arena.vercel.app**

---

## Shipped

The game is a four-to-eight player tank deathmatch with no game server. Identity is an
npub, the netcode is relays, and every round is a Bitcoin block.

- **The arena** — eight boards chosen by `blockHash % 8`, rocks, hedges, crates,
  barrels and sandbag barricades, with a board view and a cockpit (`V`).
- **Netcode** — position, fire and death on ephemeral kinds 21000–21003 at 10Hz;
  per-block scores on 30078. Four relays, a relay editor with per-relay status dots,
  and a publish pacer.
- **The fight** — a magazine you can be caught empty in, lob shots over cover (`Q`),
  damage states that scorch and smoke and burn, pickups on a chain-derived schedule.
- **Destructible cover** — barrels explode after three hits, crates come apart after
  eight. Cover shows three tiers of damage as it takes them, and what breaks leaves
  rubble that a tank crosses at 55% speed.
- **Kill streaks** — repair at 3, air strike at 5, chopper at 10, siege shells at 15,
  juggernaut at 20, carpet bombing at 25, with a HUD strip that says what the next kill
  buys.
- **Bots** — 0 to 7 practice tanks, picked on the lobby or stepped mid-match. Entirely
  local; they publish nothing and they stand down when a real player arrives.
- **Modes** — deathmatch, team deathmatch, capture the flag with bases and a
  capture race, and domination where you hold ground instead of counting kills.
  All picked on the lobby as cards.
- **The hub** — a landing page with mode cards, a side picker and a garage that renders
  the real tank rig rather than a picture of one.
- **The leaderboard** — a chain of blocks rather than a table, with seasons derived from
  difficulty epochs.
- **Phones** — the board is the screen, panels collapse to chips, on-screen sticks, an
  installable offline PWA, and a HUD where the feed clears the magazine and the rules
  banner is readable.
- **Tank Ops** — this backlog, as a board: https://tankops.vercel.app

## Next

In the order they get worked, and the reason each one is where it is.

1. **Kill streaks you trigger rather than receive** — earn a reward into a tray of
   icons and spend it when it is worth spending. The reward is currently a thing that
   happens *to* you, and choosing the moment is the entire decision.
2. **Kill streaks are invisible to everybody but the earner** — a chopper nobody else
   can see is a private cutscene, not a threat. This is the other half of the one
   above: a reward you choose to spend is only worth choosing if the room reacts.
3. **Team deathmatch does not really work** — a mode that is on the hub and does not
   deliver is worse than one that is not there.
4. **Per-mode leaderboards** — a flag capture, a captured point and a solo kill are
   three different units, and there are now four modes measured on one axis.
5. **Custom skins and a picker that holds dozens** — upload your own art, save a
   collection, and a picker that does not fall over at thirty entries.
6. **The feel pass on the rewards that exist** — the chopper out to twenty seconds,
   carpet bombing retimed so it does not open on a corpse, and a kill feed with a skull
   and both faces.

## After that

Grouped, not ordered. Each is a filed issue.

**Progression and identity** — loadouts you build and save, kill-streak selection
inside them, tank classes, calling cards and player cards with lifetime stats, emoji
stickers.

**Feel** — a kill cam from the killer's view, more power-ups and more rewards to spend
them on, bot difficulty levels.

**Boards** — four more: nuclear plant, solar farm, warehouse, moon base.

**Couch and hardware** — four-player split-screen on one TV, then the ESP32-S3 build.
Doom-class 3D is the honest ceiling on that hardware and the design has to be cut to it
rather than discovered against it.

**Bitcoin** — zap entry fees and wagers, non-custodial and testnet-first. No custodial
escrow: if a design needs a trusted third party to hold funds, it gets named as such
and the trust-minimised version gets proposed instead.

**Framework** — extracting the mini-game shell is blocked until a second game exists.
Abstracting from one example is guessing.

## Debt

Carried on purpose, and worth seeing in one place because a red suite that everybody
has learned to ignore is worse than no suite.

- `test/arsenal.mjs` — red on `main` on "and they do not hurt the tank that called
  them", which is the air-strike friendly-fire rule rather than the stale overdrive
  check it used to fail on. Newer than this file; whoever is on the streak rewards owns
  it.
- `test/relays.mjs` — four checks red on `main`, and the pacing ledger reads zero. A
  counter reading zero is the signature of a path that never ran rather than one that
  ran wrong, and while it is red nothing about publish pacing is actually covered.
- `test/lobby.mjs` — still asserts a room holds four. Rooms have held eight since
  `a1c9883`, and one of its checks is now testing nothing.
- `test/bots.mjs` — two statistical checks that fail about half the time. The behaviour
  is real and the margin is thin. Do not fix these by widening the threshold; that
  turns a flaky check into one that passes against a bot which barely hunts.
- `test/damage.mjs` — the middle smoke tier never rises, on `main` and on its parent.
- `test/lobby.mjs` — a spectator does not show up in its room's presence.
- **Cockpit aiming** — the pad reaches 360° and the mouse is bounded to 105°. A design
  decision on the record rather than a bug, and it needs a call rather than a patch.

## How this list is kept

Anything asked for in `#tank-issues` gets filed as an issue on this repo the same
session, because chat scrolls and a backlog should not. Issues get closed with the
commit that did them, so the trail is checkable. This file gets rewritten when the
order changes — not when a single item lands, which is what the board is for.
