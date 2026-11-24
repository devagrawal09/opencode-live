import { gui } from "@opencode/plugin/gui/vite"
import { type Plugin, defineConfig } from "vite"

/**
 * ONNX Runtime, which runs the wake word model, finds its WebAssembly and worker scripts from `import.meta.url`. A
 * library build would inline the 15 MB WebAssembly as a data URL, twice, and compute the URL at load time in every
 * window and in Electron's main process. The window hands ONNX Runtime the bytes instead (`env.wasm.wasmBinary` in
 * src/gui/wake.ts) and runs it on one thread with no proxy worker, so the URL is never used: make it a constant, and
 * fail the build if the WebAssembly still ends up inlined.
 */
const ortWasm: Plugin = {
  name: "gptlive-ort-wasm",
  enforce: "pre",
  transform(code, id) {
    if (id.includes("onnxruntime-web") && code.includes("import.meta.url"))
      return { code: code.replaceAll("import.meta.url", JSON.stringify("file:///onnxruntime-web/")), map: null }
  },
  generateBundle(_options, bundle) {
    for (const file of Object.values(bundle))
      if (file.type === "chunk" && file.code.includes("data:application/wasm"))
        this.error(`${file.fileName} inlines ONNX Runtime's WebAssembly; update the gptlive-ort-wasm plugin`)
  },
}

export default defineConfig({ plugins: [ortWasm, gui({ entry: "gui.tsx", outFile: "dist/gui-experimental.cjs" })] })
