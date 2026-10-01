# Virtual Office Notifier

Posts a message in Slack when someone opens our Discord "virtual office" voice channel or it empties out, so people know when they can jump in:

> 🎙️ **Ada** opened the virtual office — everyone's welcome to join!
>
> `🎧 Join the office`
>
> 🔊 Opened on Discord at 4:05 PM

> 🪑 The virtual office is empty right now — jump in and get it going!
>
> **Open for** 2h 14m · **Stopped by** 5 people
>
> `🎧 Jump in`

Each post is a Block Kit card with a button that opens the office in Discord. The opening post shows the person's Discord avatar, and times render in each reader's own time zone. The wording is picked at random from a few phrasings so the channel doesn't read like the same line every day.

The office opens when the first person joins an empty channel and empties when the last person leaves. The empty post recaps how long the office was open and how many different people came by, except for a session that was already under way when the bot started, since it missed the beginning. Joins and leaves in between aren't announced, to keep the Slack channel quiet. On startup it counts whoever is already in the channel, so a restart mid-session doesn't announce the office opening again.

It also posts a daily reminder on weekdays at 11:15 UTC+2:

> ⏰ Daily reminder: come hang out in the virtual office!

The reminder uses a fixed UTC+2 offset, so it doesn't shift with daylight saving. It's skipped if the office channel wasn't found at startup, since there's nothing to link to.

It only watches the one office channel and ignores bots. Moving in from another voice channel counts as joining, and moving out counts as leaving. Mute, deafen and video changes are ignored. See [issue #1](https://github.com/ChristopherPHolder/virtual-office-notifier/issues/1) for the original design.

## How it works

Discord only pushes voice-state changes over its Gateway WebSocket, so this is an always-on Node.js process rather than a webhook or serverless function. It uses `discord.js` to receive `voiceStateUpdate` events and posts to a Slack Incoming Webhook. Failed Slack posts are retried with backoff and logged; they never crash the process.

Built with TypeScript and [Effect](https://effect.website) v4.

## Configuration

All configuration comes from environment variables. Copy `.env.example` to `.env` for local runs. `.env` is git-ignored and must never be committed.

| Variable | Description |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token from the Discord Developer Portal. Secret. |
| `DISCORD_OFFICE_CHANNEL_ID` | ID of the office voice channel (Developer Mode → right-click the channel → Copy Channel ID). |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL. Secret: anyone with it can post to the channel. |
| `OPENROUTER_API_KEY` | Optional. [OpenRouter](https://openrouter.ai/settings/keys) API key for AI-written headlines. Secret. Without it, the fixed headlines are used. |
| `OPENROUTER_MODELS` | Optional. Comma-separated OpenRouter models to try, preferred first. Defaults to a list of free models (see `DEFAULT_MODELS` in `src/Config.ts`). |

The process exits at startup with an error naming the variable if one is missing.

### AI headlines

Every message (office opened, office emptied and the weekday reminder) gets a fresh headline and join button label from a free model on OpenRouter, and the card credits the model that wrote them. The model never sees anyone's name: for an opened office it writes a `{name}` placeholder that's filled in afterwards, and the other messages don't name anyone. Each reply is checked (a headline line and a button label line, the placeholder exactly once for an opened office and not at all otherwise, no Slack link syntax, at most 160 characters for the headline and 30 for the label) and escaped before it's posted.

Each message tries the models one at a time in a random order. The first model in the list (`openrouter/free` by default, which lets OpenRouter choose any free model that's up) goes first at least half the time. A model that fails, takes longer than a minute, or replies with something unusable is skipped for the next one, and each skip is logged with the model and the reason. If OpenRouter says the key's daily free limit is used up (50 requests a day without credits, 1,000 with at least $10 of credit), the remaining models are skipped, since they'd all be refused too. If there's no key or every model fails, the post goes out with the fixed headline and label instead.

Free models come and go on OpenRouter. To change the list, pick from the [free models](https://openrouter.ai/models?max_price=0) and set `OPENROUTER_MODELS`, preferred model first.

### Discord bot

1. Create an application at <https://discord.com/developers/applications> and add a bot. Revealing the token requires the account password.
2. Under **Bot**, turn off **Public Bot**. No privileged intents are needed; the bot only uses `Guilds` and `GuildVoiceStates`.
3. Under **OAuth2 → URL Generator**, pick the `bot` scope with the **View Channels** permission, open the URL and add the bot to the server.

### Slack webhook

1. Create an app at <https://api.slack.com/apps> → **From scratch** → pick the workspace.
2. **Features → Incoming Webhooks** → turn it on → **Add New Webhook to Workspace** → pick the channel → **Allow**. Webhooks can't post to `#general`.

## Development

Requires Node 26 (see `.nvmrc`) and pnpm.

```bash
pnpm install
pnpm dev         # run from source with .env
pnpm typecheck   # TypeScript 7 + Effect diagnostics
pnpm lint
pnpm test
pnpm build       # bundle to dist/main.js
pnpm start       # run the bundle with .env
```

TypeScript is pinned to the exact version `@effect/tsgo` supports; upgrade the two together.

## Deployment

Runs on a GCP Always Free `e2-micro` VM under systemd. There must be exactly one running copy, otherwise every announcement is posted twice.

### First-time VM setup

1. Create the VM (Debian 12, `e2-micro`, `us-central1`):

   ```bash
   gcloud compute instances create virtual-office-notifier \
     --machine-type=e2-micro --zone=us-central1-a \
     --image-family=debian-12 --image-project=debian-cloud
   ```

2. SSH in (`gcloud compute ssh virtual-office-notifier --zone=us-central1-a`) and install Node 26 from NodeSource:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_26.x | sudo bash -
   sudo apt-get install -y nodejs
   ```

3. Create the service user and app directory:

   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin notifier
   sudo mkdir -p /opt/virtual-office-notifier
   ```

The deploy writes the env file and installs the systemd unit, so there's nothing else to do on the VM. Set up CI below; the first deploy starts the service.

### Continuous deployment

Every push to `main` that passes the checks deploys from GitHub Actions (the `deploy` job in `.github/workflows/ci.yml`). It authenticates to GCP through Workload Identity Federation, so there's no service account key to leak, and only pushes to `main` on this repo can get a token.

One-time setup, from the repo root with `gcloud` on the right project and `gh` logged in to the repo owner's account:

```bash
scripts/setup-ci.sh
```

This creates a `github-deploy` service account, a Workload Identity pool trusting this repo's `main` branch, turns on OS Login for the VM and grants the account SSH and sudo there. It then stores these repository secrets:

| Secret | Source |
|---|---|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | The Workload Identity provider created above |
| `GCP_SERVICE_ACCOUNT` | The `github-deploy` service account email |
| `DISCORD_BOT_TOKEN`, `DISCORD_OFFICE_CHANNEL_ID`, `SLACK_WEBHOOK_URL` | Your local `.env` |
| `OPENROUTER_API_KEY` | Optional, your local `.env` |

GitHub secrets are the source of truth for the app's configuration. To change a value, update the secret and re-run the latest `CI` workflow on `main`:

```bash
gh secret set SLACK_WEBHOOK_URL
```

### What a deploy does

`scripts/deploy.ts` bundles the app, writes the env file from the configuration variables, copies `dist/main.js`, its source map, the systemd unit and the env file to the VM, installs them under `/opt/virtual-office-notifier` and `/etc`, reloads systemd and restarts the service. It then waits 15 seconds and fails, printing the last log lines, if the service isn't running.

To deploy by hand from your machine:

```bash
node --env-file=.env scripts/deploy.ts
```

Override the target with `DEPLOY_INSTANCE` (default `virtual-office-notifier`), `DEPLOY_ZONE` (default `us-central1-a`) and `DEPLOY_PROJECT` (default: your `gcloud` project).

### Logs

```bash
gcloud compute ssh virtual-office-notifier --zone=us-central1-a -- journalctl -u virtual-office-notifier -f
```

There's no monitoring. If announcements stop, check the logs.

## Privacy

This broadcasts people's presence to a wider audience. Tell the team before turning it on.
