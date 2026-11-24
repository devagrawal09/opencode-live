import { afterEach, describe, expect, test } from "bun:test"

import { NO_API_KEY, resolveApiKey } from "../src/server/auth"
import type { InitialItem } from "../src/server/context"
import { LiveError, type CallSession, type LiveEvent } from "../src/server/live"
import {
  API_MODEL,
  ApiEvents,
  DELEGATION_SETTLE_MS,
  TURN_QUIET_MS,
  UNKNOWN_REQUEST,
  apiBackend,
  callRequest as apiRequest,
  contextAppend as apiAppend,
  describe as describeApi,
  parseCreated,
} from "../src/server/live-api"
import { MODEL, callRequest as chatgptRequest, chatgptBackend, requestIDs } from "../src/server/live-chatgpt"
import { loadPrompt } from "../src/server/prompt"

const KEY = "sk-test-0123456789abcdef"
const items: InitialItem[] = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "earlier" }] },
  { type: "message", role: "developer", content: [{ type: "input_text", text: "note" }] },
]
const session = (model: string): CallSession => ({ model, instructions: "Be brief.", voice: "marin", items })

describe("api backend: call creation", () => {
  test("posts JSON with the session and a WebRTC transport to /v1/live/sessions", () => {
    const request = apiRequest({ auth: { key: KEY }, sdp: "v=0 offer", session: session(API_MODEL), version: "1.2.3" })
    expect(request.url).toBe("https://api.openai.com/v1/live/sessions")
    expect(request.init.method).toBe("POST")
    expect(request.init.headers as Record<string, string>).toEqual({
      Authorization: `Bearer ${KEY}`,
      "User-Agent": "opencode-live/1.2.3",
      "Content-Type": "application/json",
    })
    expect(JSON.parse(request.init.body)).toEqual({
      session: {
        model: "gpt-live-1.1",
        instructions: "Be brief.",
        input: items,
        audio: { output: { voice: "marin" } },
        delegation: { type: "client" },
      },
      transport: { type: "webrtc", sdp: "v=0 offer" },
    })
  })

  test("reads the session id and SDP answer", () => {
    expect(
      parseCreated(JSON.stringify({ session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0" } })),
    ).toEqual({ callID: "live_123", sdp: "v=0" })
    expect(() => parseCreated(JSON.stringify({ transport: { sdp: "v=0" } }))).toThrow(LiveError)
    expect(() => parseCreated(JSON.stringify({ session: { id: "live_1" }, transport: { sdp: " " } }))).toThrow(
      "empty SDP",
    )
    expect(() => parseCreated("not json")).toThrow(LiveError)
  })

  test("joins the session's sideband with the same key", () => {
    const backend = apiBackend({ key: KEY }, "1.2.3")
    expect(backend.mode).toBe("api")
    expect(backend.model).toBe("gpt-live-1.1")
    expect(apiBackend({ key: KEY }, "1", "gpt-live-1").model).toBe("gpt-live-1")
    expect(backend.sideband("live_abc")).toEqual({
      url: "wss://api.openai.com/v1/live/sessions/live_abc/attach",
      headers: { Authorization: `Bearer ${KEY}`, "User-Agent": "opencode-live/1.2.3" },
    })
  })

  test("errors say what to fix", () => {
    expect(describeApi(401, "", API_MODEL)).toContain("rejected the API key (401)")
    expect(describeApi(403, "", API_MODEL)).toContain("no access to GPT-Live (403)")
    expect(describeApi(404, "", "gpt-live-9")).toContain('"gpt-live-9" was not found')
    expect(describeApi(429, "", API_MODEL)).toContain("quota or rate limit")
    expect(describeApi(500, "boom", API_MODEL)).toBe("GPT-Live session creation failed (500): boom")
  })
})

describe("chatgpt backend: call creation is unchanged", () => {
  test("posts {sdp, session} JSON to the Codex endpoint with ChatGPT headers", () => {
    const ids = requestIDs()
    const auth = { token: "tok", accountID: "acc" }
    const request = chatgptRequest({ auth, ids, sdp: "v=0", session: session(MODEL), version: "1.2.3" })
    expect(request.url).toBe(
      "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
    )
    expect(request.init.headers).toMatchObject({
      Authorization: "Bearer tok",
      "ChatGPT-Account-ID": "acc",
      "OpenAI-Alpha": "quicksilver=v2",
      "Content-Type": "application/json",
    })
    expect(JSON.parse(request.init.body)).toEqual({
      sdp: "v=0",
      session: {
        model: "gpt-live-1.1-codex",
        instructions: "Be brief.",
        audio: { output: { voice: "marin" } },
        delegation: { type: "client" },
        initial_items: items,
      },
    })
    const backend = chatgptBackend(auth, "1.2.3")
    expect(backend.mode).toBe("chatgpt")
    expect(backend.sideband("rtc_1").url).toBe("wss://api.openai.com/v1/live/rtc_1")
    expect(backend.sideband("rtc_1").headers["ChatGPT-Account-ID"]).toBe("acc")
  })
})

describe("api backend: context appends", () => {
  test("speakable is the API's commentary; silent commentary is its thinking", () => {
    expect(apiAppend("done", "speakable", "del_1")).toEqual([
      { type: "session.commentary.append", delegation_id: "del_1", content: "done" },
    ])
    expect(apiAppend("note", "commentary")).toEqual([
      { type: "session.thinking.append", delegation_id: null, content: "note" },
    ])
  })

  test("long text goes out in chunks of at most 1,000 bytes, as plain strings", () => {
    const text = "word ".repeat(500)
    const parts = apiAppend(text, "speakable")
    expect(parts.length).toBe(3)
    expect(parts.map((part) => part.content).join("")).toBe(text)
    for (const part of parts) expect(new TextEncoder().encode(part.content as string).length).toBeLessThanOrEqual(1_000)
  })
})

const event = (value: Record<string, unknown>) => JSON.stringify(value)

describe("api backend: events", () => {
  test("transcript deltas stream, then end as a turn once the speaker goes quiet", () => {
    const events = new ApiEvents()
    expect(
      events.handle(event({ type: "session.input_transcript.delta", delta: "fix the ", event_id: "e1" }), 0),
    ).toEqual([{ kind: "transcript", role: "user", text: "fix the ", final: false }])
    events.handle(event({ type: "session.input_transcript.delta", delta: "tests", event_id: "e2" }), 500)
    expect(events.tick(500 + TURN_QUIET_MS - 1)).toEqual([])
    expect(events.tick(500 + TURN_QUIET_MS)).toEqual([
      { kind: "transcript", role: "user", text: "fix the tests", final: true },
    ])
    expect(events.tick(10_000)).toEqual([])
  })

  test("a delegation waits briefly, then carries the user's words since the last one as its request", () => {
    const events = new ApiEvents()
    events.handle(event({ type: "session.input_transcript.delta", delta: "what changed today?" }), 0)
    const created = {
      type: "session.delegation.created",
      event_id: "d1",
      offset_ms: 900,
      delegation: { id: "del_1", type: "delegation", target: "client" },
    }
    expect(events.handle(event(created), 100)).toEqual([])
    expect(events.tick(100 + DELEGATION_SETTLE_MS - 1)).toEqual([])
    expect(events.tick(100 + DELEGATION_SETTLE_MS)).toEqual([
      { kind: "transcript", role: "user", text: "what changed today?", final: true },
      { kind: "delegation", id: "del_1", text: "what changed today?" },
    ])
    // A second delegation with no new words repeats the last request; with none at all the agent is told to infer it.
    events.handle(event({ ...created, event_id: "d2", delegation: { id: "del_2", target: "client" } }), 1_000)
    expect(events.tick(2_000)).toEqual([{ kind: "delegation", id: "del_2", text: "what changed today?" }])
    const fresh = new ApiEvents()
    fresh.handle(event({ ...created, event_id: "d3" }), 0)
    expect(fresh.tick(1_000)).toEqual([{ kind: "delegation", id: "del_1", text: UNKNOWN_REQUEST }])
  })

  test("replayed events are dropped by event_id", () => {
    const events = new ApiEvents()
    const delta = event({ type: "session.output_transcript.delta", delta: "hi", event_id: "same" })
    expect(events.handle(delta, 0)).toHaveLength(1)
    expect(events.handle(delta, 10)).toEqual([])
  })

  test("audio, close, errors and the rest", () => {
    const events = new ApiEvents()
    expect(events.handle(event({ type: "session.started", event_id: "s" }), 0)).toEqual([{ kind: "started" }])
    expect(
      events.handle(event({ type: "session.output_audio.delta", delta: "AAAA", start_ms: 0, end_ms: 20 }), 0),
    ).toEqual([{ kind: "output-audio" }])
    expect(events.handle(event({ type: "session.input_audio.append", audio: "AAAA" }), 0)).toEqual([])
    const error = {
      type: "error",
      event_id: "x",
      error: { type: "invalid_request_error", code: "invalid_api_key", message: "bad key" },
    }
    expect(events.handle(event(error), 0)).toEqual([{ kind: "error", message: "bad key", fatal: true }])
    expect(events.handle(event({ type: "error", error: { code: "unknown_parameter", message: "nope" } }), 0)).toEqual([
      { kind: "error", message: "nope", fatal: false },
    ])
    expect(events.handle(event({ type: "session.usage.updated", event_id: "u", usage: { seconds: 3 } }), 0)).toEqual([
      { kind: "other", type: "session.usage.updated", keys: ["event_id", "usage"] },
    ])
    events.handle(event({ type: "session.output_transcript.delta", delta: "Bye." }), 0)
    expect(events.handle(event({ type: "session.closed", event_id: "c", reason: "close_requested" }), 10)).toEqual([
      { kind: "transcript", role: "assistant", text: "Bye.", final: true },
      { kind: "closed", reason: "close_requested" },
    ])
    expect(events.handle("garbage", 0)).toEqual([])
  })

  test("Responses delegations are not ours", () => {
    const events = new ApiEvents()
    const out = events.handle(
      event({ type: "session.delegation.created", delegation: { id: "d", target: "responses", response_id: "r" } }),
      0,
    )
    expect(out[0]?.kind).toBe("other")
    expect(events.tick(5_000).filter((item: LiveEvent) => item.kind === "delegation")).toEqual([])
  })
})

describe("api backend: credentials stay out of errors", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("a rejected key's error body is redacted", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}`, code: "invalid_api_key" } }),
        {
          status: 401,
        },
      )) as unknown as typeof fetch
    const backend = apiBackend({ key: KEY }, "1")
    const failure = await backend.createCall({ sdp: "v=0", session: session(API_MODEL) }).catch((error) => error)
    expect(failure).toBeInstanceOf(LiveError)
    expect(failure.status).toBe(401)
    expect(failure.message).toContain("rejected the API key (401)")
    expect(failure.message).toContain("Incorrect API key provided: [redacted]")
    expect(failure.message).not.toContain(KEY)
    expect(backend.redact(`x ${KEY} y`)).toBe("x [redacted] y")
  })
})

type Connection = { type: string; id?: string; method?: string; name?: string }

function fakeContext(connections: Connection[], keys: Record<string, string>, active?: Connection) {
  const resolved: string[] = []
  const ctx = {
    integration: {
      get: async () => ({ data: { connections } }),
      connection: {
        active: async () => active,
        resolve: async (connection: Connection) => {
          const id = connection.id ?? connection.name ?? ""
          resolved.push(id)
          if (connection.method === "oauth") return { type: "oauth", access: "chatgpt-token" }
          return keys[id] ? { type: "key", key: keys[id] } : undefined
        },
      },
    },
  }
  return { ctx: ctx as never, resolved }
}

describe("api key resolution", () => {
  test("the apiKey option comes first", async () => {
    const { ctx } = fakeContext([{ type: "credential", id: "c1", method: "key" }], { c1: "sk-connection" })
    expect(await resolveApiKey(ctx, " sk-option ", { OPENAI_API_KEY: "sk-env" })).toEqual({
      ok: true,
      key: "sk-option",
      source: "option",
    })
  })

  test("then OpenCode's OpenAI API-key connection, the active one first, never a ChatGPT sign-in", async () => {
    const connections = [
      { type: "credential", id: "oauth", method: "oauth" },
      { type: "credential", id: "c1", method: "key" },
      { type: "credential", id: "c2", method: "key" },
    ]
    const { ctx, resolved } = fakeContext(connections, { c1: "sk-one", c2: "sk-two" }, connections[2])
    expect(await resolveApiKey(ctx, undefined, { OPENAI_API_KEY: "sk-env" })).toEqual({
      ok: true,
      key: "sk-two",
      source: "connection",
    })
    expect(resolved).not.toContain("oauth")
  })

  test("an unresolved {env:NAME} option is ignored; OPENAI_API_KEY is the last resort", async () => {
    const { ctx } = fakeContext([{ type: "credential", id: "oauth", method: "oauth" }], {})
    expect(await resolveApiKey(ctx, "{env:MISSING}", { OPENAI_API_KEY: "sk-env" })).toEqual({
      ok: true,
      key: "sk-env",
      source: "env",
    })
  })

  test("no key says how to get one", async () => {
    const { ctx } = fakeContext([], {})
    expect(await resolveApiKey(ctx, "", {})).toEqual({ ok: false, reason: NO_API_KEY })
    expect(NO_API_KEY).toBe(
      "GPT-Live needs an OpenAI API key: /connect → OpenAI → API key, or set mode to chatgpt to use a ChatGPT plan.",
    )
  })
})

describe("GPT-Live's prompt names context the way each mode sends it", () => {
  const variables = { project: "demo", directory: "/work/demo" }
  test("api: thinking is silent, commentary is spoken", () => {
    const text = loadPrompt("gpt-live", { directory: "/", variables, mode: "api" }).text
    expect(text).toContain("Thinking context (appended as thinking) is silent background")
    expect(text).toContain("Commentary context (appended as commentary) is something to say at your next turn")
    expect(text).not.toContain("{{")
  })
  test("chatgpt: the wording is unchanged", () => {
    const text = loadPrompt("gpt-live", { directory: "/", variables, mode: "chatgpt" }).text
    expect(text).toContain("- Context on the commentary channel is silent background.")
    expect(text).toContain("- Context on the speakable channel is something to say at your next turn")
  })
})
