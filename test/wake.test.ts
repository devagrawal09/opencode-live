import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { IDLE_AFTER, IdleClock, SPEAKER_QUIET } from "../src/gui/idle"
import { ORT_VERSION, WAKE_ASSETS, fromBase64, loadAsset, sha256, type WakeAsset } from "../src/gui/wake-assets"

const quiet = { speaker: 0, queued: 0, working: false }
const scratch = () => mkdtempSync(path.join(os.tmpdir(), "gpt-live-wake-"))
const serve = (body: Uint8Array, status = 200) => {
  const calls: string[] = []
  const download = async (url: string) => {
    calls.push(url)
    return { ok: status === 200, status, arrayBuffer: async () => body.slice().buffer }
  }
  return { calls, download }
}

describe("idle clock", () => {
  test("expires after the quiet period with nothing going on", () => {
    const clock = new IdleClock(IDLE_AFTER, 0)
    expect(clock.expired(quiet, IDLE_AFTER - 1)).toBe(false)
    expect(clock.expired(quiet, IDLE_AFTER)).toBe(true)
  })

  test("a touch, e.g. a transcript, starts the quiet period again", () => {
    const clock = new IdleClock(1000, 0)
    clock.touch(900)
    expect(clock.expired(quiet, 1500)).toBe(false)
    expect(clock.expired(quiet, 1900)).toBe(true)
  })

  test("an older touch never moves it back", () => {
    const clock = new IdleClock(1000, 0)
    clock.touch(900)
    clock.touch(100)
    expect(clock.expired(quiet, 1500)).toBe(false)
  })

  test("GPT-Live talking, queued tasks and work in progress keep the call up", () => {
    for (const busy of [
      { ...quiet, speaker: SPEAKER_QUIET + 0.05 },
      { ...quiet, queued: 1 },
      { ...quiet, working: true },
    ]) {
      const clock = new IdleClock(1000, 0)
      expect(clock.expired(busy, 5000)).toBe(false)
      expect(clock.expired(quiet, 5999)).toBe(false)
      expect(clock.expired(quiet, 6000)).toBe(true)
    }
  })

  test("speaker hiss under the threshold counts as quiet", () => {
    const clock = new IdleClock(1000, 0)
    expect(clock.expired({ ...quiet, speaker: SPEAKER_QUIET / 2 }, 1000)).toBe(true)
  })
})

describe("wake word files", () => {
  const bytes = new TextEncoder().encode("model bytes")
  const asset: WakeAsset = { file: "model.onnx", url: "https://example.test/model.onnx", sha256: sha256(bytes) }

  test("downloads once, then reads the cached copy", async () => {
    const directory = scratch()
    const server = serve(bytes)
    expect(await loadAsset(asset, directory, server.download)).toEqual(bytes)
    expect(new Uint8Array(readFileSync(path.join(directory, asset.file)))).toEqual(bytes)
    expect(await loadAsset(asset, directory, server.download)).toEqual(new Uint8Array(bytes))
    expect(server.calls).toEqual([asset.url])
  })

  test("replaces a cached copy that no longer matches", async () => {
    const directory = scratch()
    writeFileSync(path.join(directory, asset.file), "corrupt")
    const server = serve(bytes)
    expect(await loadAsset(asset, directory, server.download)).toEqual(bytes)
    expect(server.calls).toHaveLength(1)
  })

  test("refuses a download that does not match its digest, and keeps nothing", async () => {
    const directory = scratch()
    await expect(loadAsset(asset, directory, serve(new TextEncoder().encode("other")).download)).rejects.toThrow(
      "did not match its checksum",
    )
    expect(() => readFileSync(path.join(directory, asset.file))).toThrow()
  })

  test("reports HTTP failures", async () => {
    await expect(loadAsset(asset, scratch(), serve(bytes, 404).download)).rejects.toThrow("HTTP 404")
  })

  test("the WebAssembly is the installed onnxruntime-web's, byte for byte", () => {
    const root = path.join(import.meta.dir, "../node_modules/onnxruntime-web")
    const installed = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }
    expect(installed.version).toBe(ORT_VERSION)
    expect(WAKE_ASSETS.runtime.url).toContain(`onnxruntime-web@${installed.version}/`)
    expect(sha256(readFileSync(path.join(root, "dist/ort-wasm-simd-threaded.wasm")))).toBe(WAKE_ASSETS.runtime.sha256)
  })

  test("base64 from main decodes to the same bytes", () => {
    const original = new Uint8Array(Array.from({ length: 1000 }, (_, index) => (index * 37) % 256))
    expect(fromBase64(Buffer.from(original).toString("base64"))).toEqual(original)
  })
})
