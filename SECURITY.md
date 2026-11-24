# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/devagrawal09/opencode-live/security/advisories/new),
not in a public issue. Include steps to reproduce and the version you tested.

Once a fix is ready, it ships in a release and the advisory is published with credit to you, unless you prefer
otherwise.

## Scope

Areas where a flaw would matter most:

- **Credentials.** The server plugin reads your ChatGPT sign-in from OpenCode and sends it only to OpenAI. It must never
  reach the desktop window, logs or other sessions.
- **The voice agent's reach.** The voice session's tools act only on the session the call was started from, and are
  hidden from every other session.
- **The microphone.** With the wake word on, audio is processed on the device and nothing is sent before the wake
  word is heard. The wake word's model and ONNX Runtime WebAssembly are downloaded by the app and used only if their
  SHA-256 matches the pinned digest.
- **Local files.** Call logs are written under your user state directory.

## Supported versions

Security fixes go into the latest release.
