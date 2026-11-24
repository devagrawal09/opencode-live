import path from "node:path"

import type { Plugin } from "@opencode/plugin/gui"
import { type BrowserWindow, app, systemPreferences } from "electron"

import { GptLive } from "../shared/rpc"
import { Host } from "./contract"
import { WAKE_ASSETS, loadAsset } from "./wake-assets"

interface WindowCall {
  window: BrowserWindow
  callID: string
  directory?: string
}

/** The wake word's files, base64 for the Ipc: from the cache in the app's data folder, or downloaded once. */
async function loadAssets() {
  const directory = path.join(app.getPath("userData"), "plugin-data", "opencode-gpt-live", "wakeword")
  const [model, runtime] = await Promise.all([
    loadAsset(WAKE_ASSETS.model, directory),
    loadAsset(WAKE_ASSETS.runtime, directory),
  ])
  return { model: Buffer.from(model).toString("base64"), runtime: Buffer.from(runtime).toString("base64") }
}

function throttle(window: BrowserWindow | undefined, enabled: boolean) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  // A call, or listening for the wake word, keeps running while its window is in the background, like the app's own
  // voice calls.
  window.webContents.setBackgroundThrottling(enabled)
}

/**
 * Electron main process: microphone permission, background throttling, hanging up for closed windows, and which
 * window listens for the wake word.
 */
export const main: Plugin.MainSetup = (ctx) => {
  /** Calls on the app's own server, which main ends when their window closes. */
  const calls = new Map<number, WindowCall>()
  /** Windows with a call up, on any server. */
  const calling = new Set<number>()
  /** The window listening for the wake word. */
  let listener: number | undefined
  let assets: Promise<{ model: string; runtime: string }> | undefined

  const awake = (id: number) => throttle(ctx.windows.get(id), !(calling.has(id) || listener === id))

  // The server ends calls whose window stops sending heartbeats after 20 s; this ends them at once.
  const hangUp = (call: WindowCall) =>
    void ctx.client
      .rpc(GptLive)
      .stop({ callID: call.callID }, call.directory ? { location: { directory: call.directory } } : undefined)
      .catch(() => undefined)

  const provider = ctx.provide(Host, {
    state: (window) => ({ wake: listener === undefined ? "free" : listener === window ? "mine" : "other" }),
    microphone: async () => {
      if (process.platform !== "darwin") return true
      if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return true
      return systemPreferences.askForMediaAccess("microphone")
    },
    call: (input, caller) => {
      const window = ctx.windows.get(caller.window)
      if (input.active) calling.add(caller.window)
      else calling.delete(caller.window)
      awake(caller.window)
      if (input.active && input.callID && input.sidecar && window)
        calls.set(caller.window, { window, callID: input.callID, directory: input.directory })
      else calls.delete(caller.window)
    },
    listen: (input, caller) => {
      const previous = listener
      if (input.active) {
        const held = previous !== undefined && previous !== caller.window && ctx.windows.get(previous)
        if (held && !input.take) return
        listener = caller.window
      } else if (previous === caller.window) listener = undefined
      if (listener === previous) return
      if (previous !== undefined) awake(previous)
      awake(caller.window)
      provider.changed()
    },
    // Shared by windows that ask at once; a failed download is tried again on the next request.
    wakeAssets: () =>
      (assets ??= loadAssets().finally(() => {
        assets = undefined
      })),
  })

  ctx.windows.on("close", (window) => {
    for (const [id, call] of calls) {
      if (call.window !== window) continue
      calls.delete(id)
      hangUp(call)
    }
    for (const id of calling) if (ctx.windows.get(id) === window) calling.delete(id)
    if (listener !== undefined && ctx.windows.get(listener) === window) {
      listener = undefined
      provider.changed()
    }
  })

  return () => {
    for (const call of calls.values()) hangUp(call)
    for (const id of new Set([...calling, ...(listener === undefined ? [] : [listener])]))
      throttle(ctx.windows.get(id), true)
    calls.clear()
    calling.clear()
    listener = undefined
  }
}
