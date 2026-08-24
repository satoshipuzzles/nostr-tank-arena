/**
 * The relay editor's model: what a relay URL is, and whether one answers.
 *
 * Kept out of `nostr.ts` on purpose. That module owns the pool the *game*
 * talks through — pacing, muting, backoff, the whole state machine. This is a
 * lobby concern: one throwaway socket, one question, one answer, then gone. A
 * probe that borrowed the game's pool would inherit its mute list, and a muted
 * relay would report as silent when the player is trying to work out whether
 * to keep it.
 */

/** What the dot next to a relay row is saying. */
export type RelayStatus =
  | 'unknown' /* not asked yet */
  | 'checking'
  | 'ok' /* connected and answered a subscription */
  | 'silent' /* connected and never answered — not a policy, see below */
  | 'refused' /* the socket itself would not open */
  | 'blocked' /* the browser will not even try: ws:// from an https page */
  | 'bad' /* not a relay URL */

export interface RelayProbe {
  status: RelayStatus
  /** Short human sentence for the row. */
  detail: string
  /** Round trip in ms, when there was one. */
  ms?: number
}

/**
 * Turn whatever the player typed into a relay URL, or null.
 *
 * A bare hostname becomes `wss://`, because that is what someone pasting
 * `relay.example.com` out of a profile page means and rejecting it teaches
 * nothing. Anything with a scheme that is not ws/wss is refused outright —
 * `https://relay.example.com` is a website, not a relay, and silently
 * rewriting it would connect the player to something they did not name.
 *
 * The trailing slash goes because `new URL` adds one and `DEFAULT_RELAYS` has
 * none; without this, adding a default back by hand produces a second row that
 * is the same relay.
 */
export function normalizeRelay(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let candidate = trimmed
  if (!/^wss?:\/\//i.test(candidate)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return null
    candidate = `wss://${candidate}`
  }
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
  if (!url.hostname) return null
  url.hash = ''
  if (url.pathname === '/' && !url.search) return `${url.protocol}//${url.host}`
  return url.toString()
}

/**
 * Split a paste into relay URLs. Newlines, spaces and commas all count.
 */
export function parseRelayList(text: string): string[] {
  const out: string[] = []
  for (const piece of text.split(/[\s,]+/)) {
    const url = normalizeRelay(piece)
    if (url && !out.includes(url)) out.push(url)
  }
  return out
}

/**
 * Would the browser refuse this socket before it left the page?
 *
 * An https page cannot open `ws://` at all — the browser blocks it as mixed
 * content, and the failure arrives as a socket that never opens and never
 * errors usefully. I have chased that exact shape once already and read it as
 * a dead relay. Naming it in the row is the whole point of having the dot.
 *
 * Localhost is the exception browsers make, and it is the one that matters
 * here because it is how this game is tested.
 */
export function blockedByMixedContent(url: string, pageProtocol: string): boolean {
  if (pageProtocol !== 'https:') return false
  if (!/^ws:\/\//i.test(url)) return false
  return !isLocalAddress(url)
}

/** A relay on the machine the browser is running on, or the network it is on. */
export function isLocalAddress(url: string): boolean {
  const host = url.replace(/^wss?:\/\//i, '').split('/')[0].split('@').pop() ?? ''
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  if (name === 'localhost' || name.endsWith('.localhost') || name === '::1') return true
  if (name.endsWith('.local')) return true
  if (/^127\./.test(name) || /^10\./.test(name) || /^192\.168\./.test(name)) return true
  return /^172\.(1[6-9]|2\d|3[01])\./.test(name)
}

/**
 * Why an https page could not reach a relay on this machine.
 *
 * Mixed content is not the only rule in the way any more. Chrome's local
 * network access checks stop a public https origin opening a socket to
 * localhost or a LAN address *whatever* the scheme, which arrives as
 * `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` in the console and as a plain
 * error event in the page. The lobby's own copy invites people to run their
 * own relay, so this is a case players will walk into.
 *
 * It is a hint appended to a refusal, not a status of its own: a local relay
 * that simply is not running refuses in exactly the same way, and claiming
 * "blocked" would be asserting a cause we cannot see from here.
 */
export function localNetworkHint(url: string, pageProtocol: string): string {
  if (pageProtocol !== 'https:' || !isLocalAddress(url)) return ''
  return ' — and an https page is not allowed to reach this machine anyway'
}

/**
 * Ask one relay whether it is there.
 *
 * The question is a subscription for kind 21000 with `limit: 1` — the game's
 * own tick kind, which no relay stores, so a healthy answer is an immediate
 * empty EOSE and the whole exchange costs two frames. Asking for kind 1 would
 * have pulled a note down from every relay in the list every time the panel
 * opened, which is exactly the kind of traffic this game has been asked not to
 * generate.
 *
 * Three outcomes and they are deliberately not collapsed:
 *
 * - **ok** — it answered. Whatever it thinks of us, it is a relay and it is up.
 * - **refused** — the socket would not open, or closed before answering.
 * - **silent** — open, and nothing came back inside the timeout. That is never
 *   a policy: refusing is a frame a relay can send, so silence is a hop that
 *   is not working, not a decision. The row says so rather than calling it a
 *   rejection.
 */
export function checkRelay(url: string, timeoutMs = 5000): Promise<RelayProbe> {
  if (!normalizeRelay(url)) {
    return Promise.resolve({ status: 'bad', detail: 'not a websocket URL' })
  }
  if (blockedByMixedContent(url, location.protocol)) {
    return Promise.resolve({
      status: 'blocked',
      detail: 'ws:// is blocked on an https page — use wss://',
    })
  }
  return new Promise<RelayProbe>((resolve) => {
    const started = Date.now()
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      resolve({ status: 'bad', detail: 'not a websocket URL' })
      return
    }
    let opened = false
    let done = false
    const sub = `probe${Math.floor(Date.now() % 100000)}`

    const finish = (probe: RelayProbe): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', sub]))
        socket.close()
      } catch {
        /* already gone */
      }
      resolve(probe)
    }

    const local = localNetworkHint(url, location.protocol)

    const timer = setTimeout(() => {
      finish(
        opened
          ? { status: 'silent', detail: `connected, no answer in ${Math.round(timeoutMs / 1000)}s` }
          : { status: 'refused', detail: `could not connect${local}` },
      )
    }, timeoutMs)

    socket.onopen = () => {
      opened = true
      socket.send(JSON.stringify(['REQ', sub, { kinds: [21000], limit: 1 }]))
    }
    socket.onmessage = (ev) => {
      const ms = Date.now() - started
      // Any frame is an answer. A NOTICE telling us to go away still proves
      // there is a relay on the other end, which is the question being asked.
      let word = 'answered'
      try {
        const frame = JSON.parse(String(ev.data))
        if (Array.isArray(frame) && frame[0] === 'NOTICE') word = 'answered (notice)'
      } catch {
        /* not our business what it said */
      }
      finish({ status: 'ok', detail: `${word} in ${ms}ms`, ms })
    }
    socket.onerror = () => {
      finish({ status: 'refused', detail: opened ? 'connection dropped' : `could not connect${local}` })
    }
    socket.onclose = () => {
      finish({ status: 'refused', detail: opened ? 'connection dropped' : `could not connect${local}` })
    }
  })
}
