/**
 * The wake word's files: LiveKit WakeWord's "hey jarvis" model and ONNX Runtime's WebAssembly, which runs it.
 *
 * The Electron main process downloads them once, checks them against pinned SHA-256 digests and caches them on disk;
 * windows get the bytes over the `Host` Ipc. A window cannot fetch them itself: GitHub's release downloads send no CORS
 * headers, and the GUI bundle is one CommonJS file evaluated from a string, with no files of its own beside it.
 * Inlining them would add about 30 MB of base64 to the bundle every window and main evaluate.
 */
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

export interface WakeAsset {
  /** File name in the cache folder. */
  file: string
  url: string
  sha256: string
}

/** The `onnxruntime-web` version the bundle is built with; its WebAssembly must be the same version. */
export const ORT_VERSION = "1.31.1"

export const WAKE_ASSETS = {
  model: {
    file: "hey_jarvis-v2.1.3.onnx",
    url: "https://github.com/livekit/livekit-wakeword/releases/download/v2.1.3/hey_jarvis.onnx",
    sha256: "8b554c50809888ac14f67fa21acc3bd85e58f5678ee4f2be5d0041f9a2e62843",
  },
  runtime: {
    file: `ort-wasm-simd-threaded-${ORT_VERSION}.wasm`,
    url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.wasm`,
    sha256: "4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d",
  },
} as const satisfies Record<string, WakeAsset>

/** Decodes the base64 a window gets from main, in the window: no Node `Buffer` there. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

type Download = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>

/** The asset's bytes: the cached copy if it still matches its digest, else a fresh download that must match it. */
export async function loadAsset(asset: WakeAsset, directory: string, download: Download = fetch): Promise<Uint8Array> {
  const file = path.join(directory, asset.file)
  const cached = await readFile(file).catch(() => undefined)
  if (cached && sha256(cached) === asset.sha256) return cached
  const response = await download(asset.url)
  if (!response.ok) throw new Error(`Could not download ${asset.file} (HTTP ${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (sha256(bytes) !== asset.sha256) throw new Error(`The downloaded ${asset.file} did not match its checksum`)
  await mkdir(directory, { recursive: true })
  // Written aside and renamed, so a cut-off write never leaves a file that looks cached.
  const partial = `${file}.${process.pid}.partial`
  await writeFile(partial, bytes)
  await rename(partial, file)
  return bytes
}
