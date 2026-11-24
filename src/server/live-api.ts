import {
  LiveError,
  chunk,
  errorEvent,
  failureDetail,
  otherEvent,
  parseJson,
  record,
  redactSecrets,
  type Backend,
  type CallSession,
  type Channel,
  type EventAdapter,
  type Json,
  type LiveEvent,
} from "./live"

/**
 * GPT-Live through OpenAI's documented API with an API key (`api` mode, the default).
 *
 * - Call creation: `POST /v1/live/sessions` with JSON `{ session, transport: { type: "webrtc", sdp } }`; 201 returns
 *   `{ session: { id }, transport: { sdp } }`.
 * - Control channel: the sideband WebSocket `wss://api.openai.com/v1/live/sessions/{id}/attach`, with the same key.
 * - Context: `session.commentary.append` (GPT-Live says it, in its own words) and `session.thinking.append` (silent),
 *   each with a plain-string `content` of up to 500 tokens and a required `delegation_id` (null for the session).
 * - Events: transcript deltas only, with no turn or transcript-done events, and `session.delegation.created` carries
 *   metadata, not the request. The adapter below groups deltas into turns and supplies the request from the user's
 *   words.
 *
 * Sources: developers.openai.com/api/docs/guides/voice-webrtc?api=live, /guides/voice-server-controls?api=live,
 * /guides/live-delegation, /guides/live-conversations and /api/reference/resources/live.
 */

export const API_MODEL = "gpt-live-1.1"
export const API_BASE = "https://api.openai.com/v1"
const SESSIONS_URL = `${API_BASE}/live/sessions`
const SIDEBAND_BASE = "wss://api.openai.com/v1/live/sessions/"
/** Appends are limited to 500 tokens; this many bytes stays under that even for dense text, in fewer appends. */
export const APPEND_MAX_BYTES = 1_000
/** A speaker's turn counts as finished once their transcript has been quiet this long; the API marks no turn ends. */
export const TURN_QUIET_MS = 1_200
/** Transcripts can trail a delegation; it waits this long so the request includes the user's last words. */
export const DELEGATION_SETTLE_MS = 300
const REQUEST_MAX_CHARS = 1_200
const SEEN_KEPT = 500

/** The request a hand-off carries when the user's words are unknown: the voice agent works it out from the turns. */
export const UNKNOWN_REQUEST =
  "(GPT-Live handed this over without the request text; work it out from the conversation above.)"

export interface ApiAuth {
  key: string
}

/** The session object `POST /v1/live/sessions` takes. Client delegation: OpenCode does the thinking. */
export interface ApiSession {
  model: string
  instructions: string
  input: CallSession["items"]
  audio: { output: { voice: string } }
  delegation: { type: "client"; acknowledgement_delay_ms?: number }
}

export function sessionBody(session: CallSession): ApiSession {
  return {
    model: session.model,
    instructions: session.instructions,
    input: session.items,
    audio: { output: { voice: session.voice } },
    delegation: { type: "client" },
  }
}

export function apiHeaders(auth: ApiAuth, version: string): Record<string, string> {
  return { Authorization: `Bearer ${auth.key}`, "User-Agent": `opencode-live/${version}` }
}

/** The call-creation request, without sending it. */
export function callRequest(input: { auth: ApiAuth; sdp: string; session: CallSession; version: string }) {
  return {
    url: SESSIONS_URL,
    init: {
      method: "POST",
      headers: { ...apiHeaders(input.auth, input.version), "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionBody(input.session), transport: { type: "webrtc", sdp: input.sdp } }),
    },
  }
}

export function describe(status: number, detail: string, model: string) {
  const suffix = detail ? `: ${detail}` : ""
  if (status === 401)
    return `OpenAI rejected the API key (401). Check the key in /connect → OpenAI → API key, the apiKey option or OPENAI_API_KEY${suffix}`
  if (status === 403)
    return `This API key's project has no access to GPT-Live (403). Check the project's model access on platform.openai.com${suffix}`
  if (status === 404)
    return `GPT-Live model "${model}" was not found for this API key (404). Check the liveModel option and the project's model access${suffix}`
  if (status === 429)
    return `OpenAI API quota or rate limit reached (429). Check billing and usage limits on platform.openai.com, or end another live session${suffix}`
  return `GPT-Live session creation failed (${status})${suffix}`
}

/** Reads the session ID and SDP answer from a 201 response body. */
export function parseCreated(body: string): { callID: string; sdp: string } {
  let json: Json | undefined
  try {
    json = record(JSON.parse(body))
  } catch {}
  const id = record(json?.session)?.id
  const sdp = record(json?.transport)?.sdp
  if (typeof id !== "string" || !id.trim())
    throw new LiveError("GPT-Live session response did not include a session id")
  if (typeof sdp !== "string" || !sdp.trim()) throw new LiveError("GPT-Live returned an empty SDP answer")
  return { callID: id, sdp }
}

/**
 * Our channels in the API's words. Careful: the API's "commentary" is the spoken one; silent context is "thinking".
 */
export function contextAppend(text: string, channel: Channel, delegationID?: string): Json[] {
  const type = channel === "speakable" ? "session.commentary.append" : "session.thinking.append"
  return chunk(text, APPEND_MAX_BYTES).map((content) => ({ type, delegation_id: delegationID ?? null, content }))
}

type Role = "user" | "assistant"

/**
 * Turns the API's control-channel events into LiveEvents. The API sends transcript deltas without turn boundaries,
 * and delegations without their request, so this keeps each speaker's open turn, ends it once it goes quiet, and
 * hands a delegation over shortly after it arrives with the user's words since the previous one as its request.
 * Replayed events (the sideband repeats the last 3 seconds on attach) are dropped by event_id.
 */
export class ApiEvents implements EventAdapter {
  private readonly open: Record<Role, { text: string; at: number } | undefined> = {
    user: undefined,
    assistant: undefined,
  }
  private readonly seen = new Set<string>()
  private pending: { id: string; at: number }[] = []
  /** The user's finished turns since the last delegation. */
  private asked: string[] = []
  private lastAsked = ""

  handle(payload: string, now: number): LiveEvent[] {
    const event = parseJson(payload)
    if (!event) return []
    if (typeof event.event_id === "string") {
      if (this.seen.has(event.event_id)) return []
      this.seen.add(event.event_id)
      if (this.seen.size > SEEN_KEPT) this.seen.delete(this.seen.values().next().value!)
    }
    const type = event.type
    switch (type) {
      case "session.started":
        return [{ kind: "started" }]
      case "session.input_transcript.delta":
      case "session.output_transcript.delta": {
        if (typeof event.delta !== "string") return [otherEvent(event)]
        const role: Role = type.includes("input") ? "user" : "assistant"
        const open = this.open[role]
        this.open[role] = { text: (open?.text ?? "") + event.delta, at: now }
        return [{ kind: "transcript", role, text: event.delta, final: false }]
      }
      case "session.output_audio.delta":
        return [{ kind: "output-audio" }]
      // Reflected microphone audio: nothing to act on, and too frequent to trace.
      case "session.input_audio.append":
        return []
      case "session.delegation.created": {
        const delegation = record(event.delegation)
        if (delegation?.target !== "client" || typeof delegation.id !== "string") return [otherEvent(event)]
        this.pending.push({ id: delegation.id, at: now })
        return []
      }
      case "session.closed":
        return [
          ...this.finish("user"),
          ...this.finish("assistant"),
          { kind: "closed", reason: typeof event.reason === "string" ? event.reason : undefined },
        ]
      case "error":
        return [errorEvent(event)]
      default:
        return [otherEvent(event)]
    }
  }

  tick(now: number): LiveEvent[] {
    const events: LiveEvent[] = []
    for (const role of ["user", "assistant"] as const) {
      const open = this.open[role]
      if (open && now - open.at >= TURN_QUIET_MS) events.push(...this.finish(role))
    }
    while (this.pending.length && now - this.pending[0]!.at >= DELEGATION_SETTLE_MS) {
      const { id } = this.pending.shift()!
      // The request is what the user said up to now, so their open turn ends here.
      events.push(...this.finish("user"))
      events.push({ kind: "delegation", id, text: this.request() })
    }
    return events
  }

  private finish(role: Role): LiveEvent[] {
    const open = this.open[role]
    this.open[role] = undefined
    const text = open?.text.trim()
    if (!text) return []
    if (role === "user") {
      this.asked.push(text)
      this.lastAsked = text
    }
    return [{ kind: "transcript", role, text, final: true }]
  }

  private request() {
    const words = this.asked.join(" ").trim() || this.lastAsked
    this.asked = []
    if (!words) return UNKNOWN_REQUEST
    return words.length > REQUEST_MAX_CHARS ? `…${words.slice(-REQUEST_MAX_CHARS)}` : words
  }
}

export function apiBackend(auth: ApiAuth, version: string, model = API_MODEL): Backend {
  const redact = (text: string) => redactSecrets(text, [auth.key])
  return {
    mode: "api",
    model,
    async createCall(input) {
      const request = callRequest({ auth, sdp: input.sdp, session: input.session, version })
      const response = await fetch(request.url, { ...request.init, signal: input.signal })
      if (!response.ok)
        throw new LiveError(
          describe(response.status, await failureDetail(response, redact), input.session.model),
          response.status,
        )
      return parseCreated(await response.text())
    },
    sideband: (callID) => ({
      url: `${SIDEBAND_BASE}${encodeURIComponent(callID)}/attach`,
      headers: apiHeaders(auth, version),
    }),
    events: () => new ApiEvents(),
    contextAppend,
    redact,
  }
}
