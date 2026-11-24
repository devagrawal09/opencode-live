import type { InitialItem } from "./context"
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
 * GPT-Live through a ChatGPT plan (`chatgpt` mode).
 *
 * Call creation posts the WebRTC offer to the Codex backend, which returns the SDP answer and a call id. The control
 * channel ("sideband") is a WebSocket on api.openai.com joined with the same ChatGPT credentials. This mirrors what
 * Codex does for its Voice feature. None of it is a documented public API.
 */

export const MODEL = "gpt-live-1.1-codex"
const CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas"
const SIDEBAND_URL = "wss://api.openai.com/v1/live/"
const APPEND_MAX_BYTES = 500
const CALL_ID = /^(rtc_[\w-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

export interface Auth {
  token: string
  accountID: string
}

export interface RequestIDs {
  realtimeSessionID: string
  sessionID: string
  threadID: string
}

/** The session object this endpoint takes. */
export interface LiveSession {
  model: string
  instructions: string
  audio: { output: { voice: string } }
  delegation: { type: "client"; ack_filler?: boolean }
  initial_items?: readonly InitialItem[]
}

export function requestIDs(): RequestIDs {
  return {
    realtimeSessionID: crypto.randomUUID(),
    sessionID: crypto.randomUUID(),
    threadID: crypto.randomUUID(),
  }
}

export function headers(auth: Auth, ids: RequestIDs, version: string): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.token}`,
    "ChatGPT-Account-ID": auth.accountID,
    "OpenAI-Alpha": "quicksilver=v2",
    "session-id": ids.sessionID,
    "thread-id": ids.threadID,
    "x-session-id": ids.realtimeSessionID,
    originator: "opencode",
    "User-Agent": `opencode-gpt-live/${version}`,
  }
}

export function sessionBody(session: CallSession): LiveSession {
  return {
    model: session.model,
    instructions: session.instructions,
    audio: { output: { voice: session.voice } },
    delegation: { type: "client" },
    initial_items: session.items,
  }
}

export function describe(status: number, detail: string) {
  if (status === 401) return "ChatGPT rejected the sign-in (401). Sign in again with /connect → OpenAI → ChatGPT."
  if (status === 403)
    return "GPT-Live rejected the session (403). Your ChatGPT plan may not include voice, or the voice allowance is used up."
  if (status === 404) return "GPT-Live voice is not available on this ChatGPT plan (404)."
  if (status === 429) return "GPT-Live voice limit reached (429). Try again later."
  return `GPT-Live call creation failed (${status})${detail ? `: ${detail}` : ""}`
}

export function parseCallID(location: string | null, sessionHeader: string | null): string {
  if (location) {
    const segments = new URL(location, CALL_URL).pathname.split("/").filter(Boolean)
    const id = segments.find((segment) => CALL_ID.test(segment))
    if (id) return id
  }
  const fallback = sessionHeader?.trim()
  if (fallback && CALL_ID.test(fallback)) return fallback
  throw new LiveError("GPT-Live call response did not include a call id")
}

/** The call-creation request, without sending it. */
export function callRequest(input: {
  auth: Auth
  ids: RequestIDs
  sdp: string
  session: CallSession
  version: string
}) {
  return {
    url: CALL_URL,
    init: {
      method: "POST",
      headers: { ...headers(input.auth, input.ids, input.version), "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: input.sdp, session: sessionBody(input.session) }),
    },
  }
}

export function parseEvent(payload: string): LiveEvent | undefined {
  const event = parseJson(payload)
  if (!event) return undefined
  const type = event.type
  switch (type) {
    case "session.started":
      return { kind: "started" }
    case "input_transcript.added":
    case "output_transcript.added": {
      const text = record(event.item)?.text
      if (typeof text !== "string") return { kind: "other", type }
      return { kind: "transcript", role: type.startsWith("input") ? "user" : "assistant", text, final: false }
    }
    case "session.input_transcript.delta":
    case "session.output_transcript.delta": {
      if (typeof event.delta !== "string") return { kind: "other", type }
      return {
        kind: "transcript",
        role: type.includes("input") ? "user" : "assistant",
        text: event.delta,
        final: false,
      }
    }
    case "turn.done": {
      const turn = record(event.turn)
      if ((turn?.role !== "user" && turn?.role !== "assistant") || typeof turn.transcript !== "string")
        return { kind: "other", type }
      return { kind: "transcript", role: turn.role, text: turn.transcript, final: true }
    }
    case "turn.created": {
      const turn = record(event.turn)
      if (turn?.role !== "user" && turn?.role !== "assistant") return otherEvent(event)
      return { kind: "turn", role: turn.role, ...(typeof turn.id === "string" ? { id: turn.id } : {}) }
    }
    case "turn.delta":
      if (typeof event.turn_id !== "string") return otherEvent(event)
      return { kind: "turn-delta", id: event.turn_id }
    case "session.output_audio.delta":
      return { kind: "output-audio" }
    case "delegation.created": {
      const item = record(event.item)
      if (!item || item.type !== "delegation" || item.target !== "client" || typeof item.id !== "string")
        return { kind: "other", type }
      const content = Array.isArray(item.content) ? item.content : []
      const text = content
        .map(record)
        .filter((part) => part?.type === "input_text" && typeof part.text === "string")
        .map((part) => part!.text as string)
        .join("")
      return { kind: "delegation", id: item.id, text }
    }
    case "output_audio_buffer.cleared":
      return { kind: "speech-cleared" }
    case "session.closed":
      return { kind: "closed", reason: typeof event.reason === "string" ? event.reason : undefined }
    case "error":
      return errorEvent(event)
    default:
      return otherEvent(event)
  }
}

/** On this endpoint `speakable` and `commentary` are channels of one append event. */
export function contextAppend(text: string, channel: Channel, delegationID?: string): Json[] {
  return chunk(text, APPEND_MAX_BYTES).map((part) => {
    const content = [{ type: "input_text", text: part }]
    return delegationID
      ? { type: "delegation.context.append", delegation_item_id: delegationID, channel, content }
      : { type: "session.context.append", channel, content }
  })
}

export function chatgptBackend(auth: Auth, version: string): Backend {
  const ids = requestIDs()
  const redact = (text: string) => redactSecrets(text, [auth.token, auth.accountID])
  return {
    mode: "chatgpt",
    model: MODEL,
    async createCall(input) {
      const request = callRequest({ auth, ids, sdp: input.sdp, session: input.session, version })
      const response = await fetch(request.url, { ...request.init, signal: input.signal })
      if (!response.ok)
        throw new LiveError(describe(response.status, await failureDetail(response, redact)), response.status)
      const callID = parseCallID(response.headers.get("location"), response.headers.get("openai-session-id"))
      const sdp = await response.text()
      if (!sdp.trim()) throw new LiveError("GPT-Live returned an empty SDP answer", response.status)
      return { callID, sdp }
    },
    sideband: (callID) => ({
      url: `${SIDEBAND_URL}${encodeURIComponent(callID)}`,
      headers: headers(auth, ids, version),
    }),
    events: (): EventAdapter => ({
      handle: (payload) => {
        const event = parseEvent(payload)
        return event ? [event] : []
      },
    }),
    contextAppend,
    redact,
  }
}
