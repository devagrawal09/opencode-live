# Development guide

Everything you need to change the plugin, run it from a checkout and test calls.

## Prerequisites

| Tool                                           | Why                                                  |
| ---------------------------------------------- | ---------------------------------------------------- |
| [Bun](https://bun.sh) 1.3+                     | Installs dependencies, runs tests and scripts.       |
| [OpenCode Desktop](https://opencode.ai) 2.3.0+ | Runs the plugin.                                     |
| A ChatGPT Plus or Pro sign-in in OpenCode      | Real calls. Tests and the build work without one.    |
| A microphone                                   | Real calls. There is no file-based or headless mode. |

The sign-in must be OpenAI › "Codex browser (legacy)" under `/connect`. "Sign in with ChatGPT" logins have no account
ID and are refused; ChatGPT Go accounts are rejected by OpenAI with a 404.

## Setup

```sh
git clone https://github.com/devagrawal09/opencode-live
cd opencode-live
bun install
bun run build:gui
```

`bun run build:gui` writes `dist/gui-experimental.cjs`, the desktop bundle that the package's `./gui-experimental`
export points at. Without it the server plugin loads but no window gets the panel or commands.

## Running the plugin from your checkout

Point OpenCode's config (`~/.config/opencode/opencode.json`, or a project's) at the checkout by absolute path:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/opencode-live",
      "options": { "log": true },
    },
  ],
}
```

Restart OpenCode once so it loads the plugin, open a session and run `/voice`.

While you work, keep the bundle rebuilding:

```sh
bun run dev:gui    # vite build --watch
```

- **Server plugin changes** (`src/server`, `src/shared`) reload on save. Reloading ends an active call.
- **Window changes** (`src/gui`, `gui.tsx`) need the bundle rebuilt (`dev:gui` does it). Windows only take the new
  bundle after a clean server reload of the plugin; if a window still shows the old behavior, press Cmd+R in it.
- **Electron main changes** (`src/gui/main.ts`, `src/gui/wake-assets.ts`) run in the app's main process. If a reload
  does not pick them up, quit and reopen the app.
- **Prompt changes** (`src/server/prompts/`) need nothing: prompts are read at the start of every call.

### When a reload goes wrong

Hot reload can leave a stale module cache after an edit that touches several files at once (an export added in one
file and imported in another). The plugin then fails to load, and `~/.local/share/opencode/log/opencode.log` shows
something like `Export named 'X' not found in module ...`. Restart the OpenCode service to clear it:

```sh
opencode service restart
```

That ends any call in progress. Afterwards, reload the windows (Cmd+R) so they pick up the current bundle.

## Checks

```sh
bun run check       # oxfmt --check, oxlint, tsc (server and GUI configs), bun test
bun run build:gui   # the desktop bundle; fails if ONNX Runtime's WebAssembly gets inlined
bun run format      # format with oxfmt
bun run lint:fix    # apply oxlint's automatic fixes
```

oxfmt leaves the prompt section folders (`src/server/prompts/gpt-live`, `src/server/prompts/voice-agent`) alone:
reformatting them would change the text the models read.

CI (`.github/workflows/ci.yml`) runs formatting, lint, types, tests and the desktop build on every pull request.

## Tests

`test/` covers the logic that does not need a call: GPT-Live event parsing, call IDs, auth claims and the call's
initial items (`live.test.ts`), the bridge's task outcomes, holding for the floor and hand-off steps
(`bridge.test.ts`), the floor tracker (`floor.test.ts`), prompts and the pace and wake hints (`prompt.test.ts`),
voices and paces (`rpc.test.ts`), the panel's transcript, debug events and hand-off models (`gui-*.test.ts`) and the
wake word's idle clock and file checks (`wake.test.ts`).

Audio, WebRTC and the wake word listener run only in a real window. Nothing in the repository fakes the microphone,
so testing a call means talking to it in OpenCode Desktop.

## Debugging calls

- **Call logs.** With `log` on (the default), each call writes
  `~/.local/state/opencode-gpt-live/calls/<time>-<callID>.jsonl`: transcripts, hand-offs, voice-agent steps, tool
  calls, holds, errors and the GPT-Live event types seen. Start here when a call misbehaves.
- **GPT-Live events.** Run "Show GPT-Live events" from the command palette for a live list of the call's data-channel
  events and their counts in the panel.
- **Voice agent column.** Each hand-off's request, tools, reply and timing show in the panel; "Open voice session"
  shows the full voice session.
- **OpenCode's log.** `~/.local/share/opencode/log/opencode.log` has plugin load errors and server-side failures.

## Releases

There is no release automation. Pull requests use [Conventional Commit](https://www.conventionalcommits.org/) titles
so a changelog can be written from them.
