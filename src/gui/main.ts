import type { Plugin } from "@opencode/plugin/gui"
import { type BrowserWindow, systemPreferences } from "electron"

import { GptLive } from "../shared/rpc"
import { Host } from "./contract"

interface WindowCall {
  window: BrowserWindow
  callID: string
  directory?: string
}

function throttle(window: BrowserWindow | undefined, enabled: boolean) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  // A call keeps running while its window is in the background, like the app's own voice calls.
  window.webContents.setBackgroundThrottling(enabled)
}

/** Electron main process: microphone permission, background throttling, and hanging up for closed windows. */
export const main: Plugin.MainSetup = (ctx) => {
  const calls = new Map<number, WindowCall>()

  // The server ends calls whose window stops sending heartbeats after 20 s; this ends them at once.
  const hangUp = (call: WindowCall) =>
    void ctx.client
      .rpc(GptLive)
      .stop({ callID: call.callID }, call.directory ? { location: { directory: call.directory } } : undefined)
      .catch(() => undefined)

  ctx.provide(Host, {
    microphone: async () => {
      if (process.platform !== "darwin") return true
      if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return true
      return systemPreferences.askForMediaAccess("microphone")
    },
    call: (input, caller) => {
      const window = ctx.windows.get(caller.window)
      throttle(window, !input.active)
      if (input.active && input.callID && input.sidecar && window)
        calls.set(caller.window, { window, callID: input.callID, directory: input.directory })
      else calls.delete(caller.window)
    },
  })

  ctx.windows.on("close", (window) => {
    for (const [id, call] of calls) {
      if (call.window !== window) continue
      calls.delete(id)
      hangUp(call)
    }
  })

  return () => {
    for (const call of calls.values()) {
      throttle(call.window, true)
      hangUp(call)
    }
    calls.clear()
  }
}
