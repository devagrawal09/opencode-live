import type { Mode } from "../shared/rpc"
import type { InitialItem } from "./context"

/**
 * What a GPT-Live call needs from a wire contract, whichever way it reaches OpenAI. Two backends implement it:
 *
 * - `api` (live-api.ts): OpenAI's documented GPT-Live API with an API key. The default.
 * - `chatgpt` (live-chatgpt.ts): the ChatGPT plan, through the undocumented Codex voice endpoint.
 *
 * The bridge, the floor and the outbox only ever see `LiveEvent`s and call `Sideband.append(text, channel,
 * delegationID?)`; everything OpenAI-specific (URLs, headers, body shapes, event names) lives in the backends.
 */

export type Channel =
  /** Something GPT-Live should say at its next turn. */
  | "speakable"
  /** Silent background GPT-Live can use but should not read out. */
  | "commentary"

/** A call's session settings, before a backend maps them to its wire shape. */
export interface CallSession {
  model: string
  instructions: string
  voice: string
  /** Conversation the call starts with; see initialItems in context.ts. */
  items: readonly InitialItem[]
}

export interface CreatedCall {
  /** The ID the control channel joins: a call ID (chatgpt) or a Live session ID (api). */
  callID: string
  sdp: string
}

export type Json = Record<string, unknown>

/** Turns one call's raw control-channel messages into LiveEvents. Stateful: backends may need to group or wait. */
export interface EventAdapter {
  handle(payload: string, now: number): LiveEvent[]
  /** Events that are due by `now` without a new message (e.g. a turn that went quiet). */
  tick?(now: number): LiveEvent[]
}

export interface Backend {
  readonly mode: Mode
  /** The model a call uses unless configured otherwise. */
  readonly model: string
  createCall(input: { sdp: string; session: CallSession; signal?: AbortSignal }): Promise<CreatedCall>
  /** The control WebSocket for a created call, and its handshake headers. */
  sideband(callID: string): { url: string; headers: Record<string, string> }
  events(): EventAdapter
  /** Wire messages that add text to the call as speakable or silent context, for the call or one hand-off. */
  contextAppend(text: string, channel: Channel, delegationID?: string): Json[]
  /** Removes credentials from text that may be shown or logged. */
  redact(text: string): string
}

export class LiveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "LiveError"
  }
}

export type LiveEvent =
  | { kind: "started" }
  | { kind: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { kind: "delegation"; id: string; text: string }
  /** A user or GPT-Live turn started (`turn.created`), before any transcript of it. */
  | { kind: "turn"; role: "user" | "assistant"; id?: string }
  /** Progress on a started turn (`turn.delta`). */
  | { kind: "turn-delta"; id: string }
  /** GPT-Live sent a chunk of spoken audio. */
  | { kind: "output-audio" }
  | { kind: "speech-cleared" }
  | { kind: "closed"; reason?: string }
  | { kind: "error"; message: string; fatal: boolean }
  | { kind: "other"; type: string; keys?: string[] }

export function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined
}

export function parseJson(payload: string): (Json & { type: string }) | undefined {
  let event: Json | undefined
  try {
    event = record(JSON.parse(payload))
  } catch {
    return undefined
  }
  if (!event || typeof event.type !== "string") return undefined
  return event as Json & { type: string }
}

export function errorMessage(event: Json): string {
  const error = record(event.error)
  if (typeof error?.message === "string") return error.message
  if (typeof event.message === "string") return event.message
  if (typeof event.error === "string") return event.error
  return "GPT-Live error"
}

const FATAL_CODES = new Set(["authentication_error", "invalid_token", "token_expired", "invalid_api_key"])

export function errorEvent(event: Json): LiveEvent {
  const error = record(event.error)
  const status = event.status ?? error?.status
  const code = String(event.code ?? error?.code ?? "").toLowerCase()
  return { kind: "error", message: errorMessage(event), fatal: status === 401 || FATAL_CODES.has(code) }
}

export const otherEvent = (event: Json & { type: string }): LiveEvent => ({
  kind: "other",
  type: event.type,
  keys: Object.keys(event).filter((key) => key !== "type"),
})

/** Splits text into chunks that fit a per-append byte limit without breaking characters. */
export function chunk(text: string, maxBytes = 500): string[] {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) return [text]
  const chunks: string[] = []
  let current = ""
  let bytes = 0
  for (const character of text) {
    const size = encoder.encode(character).length
    if (current && bytes + size > maxBytes) {
      chunks.push(current)
      current = ""
      bytes = 0
    }
    current += character
    bytes += size
  }
  if (current) chunks.push(current)
  return chunks
}

/** Replaces each secret in text; empty secrets are ignored. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]) {
  return secrets.reduce<string>(
    (result, secret) => (secret && secret.length >= 4 ? result.split(secret).join("[redacted]") : result),
    text,
  )
}

/** A rejected call creation's response body, short, readable and without credentials. */
export async function failureDetail(response: Response, redact: (text: string) => string) {
  const body = await response.text().catch(() => "")
  let detail = body.trim()
  try {
    const message = record(record(JSON.parse(detail))?.error)?.message
    if (typeof message === "string") detail = message
  } catch {}
  return redact(detail).slice(0, 300)
}

const TICK_MS = 100

/** The control WebSocket for a live call. */
export class Sideband {
  private socket: WebSocket | undefined
  private closed = false
  private ticker: ReturnType<typeof setInterval> | undefined

  private constructor(
    private readonly backend: Backend,
    private readonly adapter: EventAdapter,
    private readonly onEvent: (event: LiveEvent) => void,
    private readonly onClose: (reason: string) => void,
  ) {}

  static async connect(input: {
    backend: Backend
    callID: string
    onEvent: (event: LiveEvent) => void
    onClose: (reason: string) => void
    signal?: AbortSignal
  }): Promise<Sideband> {
    const sideband = new Sideband(input.backend, input.backend.events(), input.onEvent, input.onClose)
    const { url, headers } = input.backend.sideband(input.callID)
    // Up to five attempts with exponential backoff; each waits for the previous one to fail.
    const attempt = async (index: number): Promise<Sideband> => {
      input.signal?.throwIfAborted()
      try {
        await sideband.open(url, headers)
        return sideband
      } catch (error) {
        if (index >= 4)
          throw error instanceof Error ? error : new LiveError("GPT-Live control channel failed to connect")
        await Bun.sleep(200 * 2 ** index)
        return attempt(index + 1)
      }
    }
    return attempt(0)
  }

  private emit(events: readonly LiveEvent[]) {
    for (const event of events) this.onEvent(event)
  }

  private open(url: string, handshake: Record<string, string>) {
    return new Promise<void>((resolve, reject) => {
      // Bun's WebSocket accepts custom handshake headers.
      const socket = new WebSocket(url, { headers: handshake } as unknown as string[])
      const timeout = setTimeout(() => {
        socket.close()
        reject(new LiveError("GPT-Live control channel timed out"))
      }, 15_000)
      let opened = false
      socket.addEventListener("open", () => {
        opened = true
        clearTimeout(timeout)
        this.socket = socket
        const tick = this.adapter.tick?.bind(this.adapter)
        if (tick) this.ticker = setInterval(() => this.emit(tick(Date.now())), TICK_MS)
        resolve()
      })
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return
        this.emit(this.adapter.handle(message.data, Date.now()))
      })
      socket.addEventListener("error", () => {
        if (!opened) {
          clearTimeout(timeout)
          reject(new LiveError("GPT-Live control channel connection failed"))
        }
      })
      socket.addEventListener("close", (event) => {
        clearTimeout(timeout)
        if (!opened) {
          reject(new LiveError(`GPT-Live control channel closed during startup (${event.code})`))
          return
        }
        clearInterval(this.ticker)
        if (!this.closed) {
          this.closed = true
          this.onClose(this.backend.redact(event.reason) || `closed (${event.code})`)
        }
      })
    })
  }

  send(message: Json) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  append(text: string, channel: Channel, delegationID?: string) {
    for (const message of this.backend.contextAppend(text, channel, delegationID)) this.send(message)
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.ticker)
    this.send({ type: "session.close" })
    setTimeout(() => this.socket?.close(1000, "session closed"), 250)
  }
}
