import { describe, expect, test } from "bun:test"

import {
  API_VOICES,
  DEFAULT_MODE,
  GptLive,
  MODES,
  PACES,
  VOICES,
  defaultVoiceFor,
  isMode,
  isPace,
  isVoice,
  isVoiceFor,
  voicesFor,
} from "../src/shared/rpc"

describe("voices", () => {
  test("keep the original nine first, with cove as the first", () => {
    expect(VOICES.slice(0, 9)).toEqual([
      "cove",
      "juniper",
      "maple",
      "spruce",
      "ember",
      "vale",
      "breeze",
      "arbor",
      "sol",
    ])
  })

  test("include Codex's newer voices, once each", () => {
    for (const voice of ["marin", "aube", "bubbie", "haetsal", "hanul", "himari", "leher", "miko", "neer"])
      expect(VOICES).toContain(voice as never)
    for (const voice of ["porto", "rindo", "rio", "rivage", "selva", "sonna", "tinta", "viola"])
      expect(VOICES).toContain(voice as never)
    expect(VOICES).toHaveLength(26)
    expect(new Set(VOICES).size).toBe(VOICES.length)
  })

  test("isVoice accepts listed names only", () => {
    expect(isVoice("viola")).toBe(true)
    expect(isVoice("Viola")).toBe(false)
    expect(isVoice(undefined)).toBe(false)
  })

  test("start accepts a new voice and a pace", () => {
    const input = GptLive.methods.start.input
    expect(input.safeParse({ sessionID: "s", sdp: "o", voice: "himari", pace: "slower" }).success).toBe(true)
    expect(input.safeParse({ sessionID: "s", sdp: "o", voice: "nobody" }).success).toBe(false)
    expect(input.safeParse({ sessionID: "s", sdp: "o", pace: "fast" }).success).toBe(false)
  })

  test("start takes an optional wake flag", () => {
    const input = GptLive.methods.start.input
    expect(input.safeParse({ sessionID: "s", sdp: "o", wake: true }).success).toBe(true)
    expect(input.safeParse({ sessionID: "s", sdp: "o" }).success).toBe(true)
    expect(input.safeParse({ sessionID: "s", sdp: "o", wake: "yes" }).success).toBe(false)
  })
})

describe("paces", () => {
  test("are normal, slower and faster", () => {
    expect(PACES).toEqual(["normal", "slower", "faster"])
    expect(isPace("faster")).toBe(true)
    expect(isPace("quick")).toBe(false)
  })
})

describe("modes", () => {
  test("api is the default; chatgpt is the other", () => {
    expect(MODES).toEqual(["api", "chatgpt"])
    expect(DEFAULT_MODE).toBe("api")
    expect(isMode("chatgpt")).toBe(true)
    expect(isMode("subscription")).toBe(false)
  })

  test("each mode has its own voices and default", () => {
    expect(API_VOICES).toHaveLength(38)
    expect(new Set(API_VOICES).size).toBe(API_VOICES.length)
    expect(voicesFor("api")).toBe(API_VOICES)
    expect(voicesFor("chatgpt")).toBe(VOICES)
    expect(defaultVoiceFor("api")).toBe("marin")
    expect(defaultVoiceFor("chatgpt")).toBe("cove")
    expect(isVoiceFor("api", "cedar")).toBe(true)
    expect(isVoiceFor("api", "cove")).toBe(false)
    expect(isVoiceFor("chatgpt", "cedar")).toBe(false)
    expect(isVoiceFor("chatgpt", "marin")).toBe(true)
  })

  test("start takes a mode and a voice from either list; status takes an optional mode", () => {
    const start = GptLive.methods.start.input
    expect(start.safeParse({ sessionID: "s", sdp: "o", mode: "api", voice: "cedar" }).success).toBe(true)
    expect(start.safeParse({ sessionID: "s", sdp: "o", mode: "chatgpt", voice: "cove" }).success).toBe(true)
    expect(start.safeParse({ sessionID: "s", sdp: "o", mode: "plan" }).success).toBe(false)
    const status = GptLive.methods.status.input
    expect(status.safeParse({}).success).toBe(true)
    expect(status.safeParse({ mode: "api" }).success).toBe(true)
  })
})
