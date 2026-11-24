import { describe, expect, test } from "bun:test"

import { GptLive, PACES, VOICES, isPace, isVoice } from "../src/shared/rpc"

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
