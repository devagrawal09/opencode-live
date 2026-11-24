# Contributing

Thanks for helping. Bug reports, prompt improvements and code are all welcome.

## Where to start

- **Found a bug?** [Open a bug report](https://github.com/devagrawal09/opencode-live/issues/new?template=bug.yml).
  Include the call log from `~/.local/state/opencode-gpt-live/calls/`; it shows exactly what happened during the call.
- **Have an idea?** [Open a feature request](https://github.com/devagrawal09/opencode-live/issues/new?template=feature.yml)
  before writing a lot of code, so we can agree on the shape first.
- **Security issue?** Follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development

The [development guide](docs/development.md) covers setup, running the plugin from your checkout in OpenCode Desktop
and debugging calls. The [architecture guide](docs/architecture.md) explains how the pieces fit.

The short version:

```sh
bun install
bun run check       # formatting, lint, types, tests
bun run build:gui   # the desktop bundle
```

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change, with tests where it makes sense: `test/` covers the pure logic (GPT-Live message parsing, the
   bridge and floor, prompts, the panel's models, the wake word's idle clock and file checks).
3. Run `bun run check` and `bun run build:gui`.
4. Try it in a real call in OpenCode Desktop when your change affects calls or the panel, and say in the pull request
   what you tested.
5. Open the pull request with a [Conventional Commit](https://www.conventionalcommits.org/) title (`feat:`, `fix:`,
   `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `chore:`; add `!` for a breaking change).

CI must pass before anything merges.

### Code style

- TypeScript is formatted with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) and linted with
  [oxlint](https://oxc.rs/docs/guide/usage/linter); CI rejects warnings. Fix findings in the code rather than disabling
  rules; a targeted `oxlint-disable-next-line` needs a comment explaining why.
- Comments explain why something is done, not what the next line does.

### Improving the prompts

The prompts in [`src/server/prompts/`](src/server/prompts) shape how the voice behaves, and they are plain Markdown.
See the [prompts README](src/server/prompts/README.md) for how they are assembled. Prompt changes are reviewed like code:
describe the behavior you saw, the change and how it behaved afterwards.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind and assume good intent.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
