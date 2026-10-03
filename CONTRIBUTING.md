# Contributing

Thanks for helping out. The process here is light, but every merge into `main` deploys straight to production, so a pull request has to be ready to ship.

- [Before you start](#before-you-start)
- [Setting up](#setting-up)
- [Making a change](#making-a-change)
- [Checks](#checks)
- [Commits and pull requests](#commits-and-pull-requests)
- [Deploys](#deploys)
- [License](#license)

## Before you start

For anything bigger than a small fix, open an issue first so we can agree on the approach before you put time into it. This posts to a shared Slack channel, so changes to what it says, or when, affect everyone in it.

Found a security problem? Don't open an issue. Follow [SECURITY.md](SECURITY.md) instead.

## Setting up

You'll need Node 26 (see `.nvmrc`) and pnpm. The pnpm version is pinned in `package.json`, and `corepack enable` picks it up.

```bash
pnpm install
cp .env.example .env
```

Most changes don't need a `.env` at all, since the tests run without tokens or network access. To try a change for real, fill in `.env` with your own Discord bot, test server and Slack webhook. The [README](README.md#configuration) covers setting those up.

> [!WARNING]
> Never point a local run at the production bot token or webhook. Two copies watching the same channel post every announcement twice.

## Making a change

- Branch off `main`, and keep a pull request to one change. Unrelated cleanups go in their own.
- Add or update tests for any change in behaviour.
- Update the [README](README.md) when you change what gets posted, the configuration or the deploy.

### Code style

The app is built on [Effect](https://effect.website) v4. Follow the patterns already in `src/`:

- Services are `Context.Service` classes with a `layer`, and a test layer where tests need one.
- Errors are `Schema.TaggedError` classes, handled by tag.
- Configuration is read through `Config` in [`src/Config.ts`](src/Config.ts). Secrets are `Redacted` and never logged. Watch out for errors that carry a request URL, since the webhook URL is itself a secret.
- Anything posted to Slack that comes from outside, like a Discord display name or AI output, goes through `escapeSlackText`, so it can't ping `@channel` or post links.
- Names are never sent to the AI providers.
- Comments explain why, not what.

There's no separate formatter. `pnpm lint` runs oxlint with the vendored [anti-slop](tools/oxlint/anti-slop/UPSTREAM.md) rules, and `pnpm lint:fix` applies the fixes it can.

### Tests

Tests live in `test/` and use [`@effect/vitest`](https://www.npmjs.com/package/@effect/vitest). They swap in fakes through layers rather than mocking modules, which the linter rejects:

- [`test/fakes.ts`](test/fakes.ts) has a fake Slack webhook that serves scripted replies and records every request, and a helper that pins the random phrasing so tests can assert the exact text.
- `DiscordGateway.layerTest` feeds voice-state updates from a queue through the same occupancy tracking the real gateway uses.
- `HeadlineWriter.layerProviders` takes fake language models, so the provider fallback can be tested without calling a real one.
- Database code runs against [PGlite](https://pglite.dev), an in-process Postgres, with the real migrations. Give it `columnNaming` from `src/Database.ts` so column names convert the same way as in production. `test/fakes.ts` also has a fake recorder for program tests.

### Adding a configuration variable

A new environment variable has to be wired through in several places, or production won't get it:

1. Read it in [`src/Config.ts`](src/Config.ts).
2. Add it to [`.env.example`](.env.example).
3. Add it to the configuration table in the [README](README.md#configuration).
4. Pass the secret to the deploy step in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
5. Write it to the env file in [`scripts/deploy.ts`](scripts/deploy.ts).

I add the matching GitHub secret before merging.

## Checks

CI runs these on every push and pull request. Run them before you push:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Commits and pull requests

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) with a short lowercase summary, like `feat: fall back to Cloudflare Workers AI for headlines`. Use `feat`, `fix`, `docs`, `test`, `refactor`, `ci` or `chore`.
- Pull requests are squash-merged, so the title becomes the commit summary. Use the same format for it.
- Explain why in the description, not just what changed, and say how you tested it. The pull request template has the checklist.

## Deploys

Merging into `main` deploys to production, and that's the only way anything gets deployed. There are no manual deploys. If a deploy fails, the job prints the service's last log lines. Fix it, or revert it, with a new pull request.

## License

By contributing, you agree that your contributions are licensed under the [0BSD license](LICENSE), like the rest of the project.
