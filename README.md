# Virtual Office Notifier

Posts a message in Slack when our Discord "virtual office" voice channel opens or closes, so people know when they can jump in:

> 🎙️ **Ada** opened the virtual office — everyone's welcome to [join](#)!
>
> 👋 The virtual office is closed for now — see you soon!

The office opens when the first person joins an empty channel and closes when the last person leaves. Joins and leaves in between aren't announced, to keep the Slack channel quiet. On startup it counts whoever is already in the channel, so a restart mid-session doesn't announce the office opening again.

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

The process exits at startup with an error naming the variable if one is missing.

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

3. Create the service user and app directory. Your SSH user deploys into it:

   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin notifier
   sudo mkdir -p /opt/virtual-office-notifier
   sudo chown "$USER":notifier /opt/virtual-office-notifier
   ```

4. Write the env file with the three variables above:

   ```bash
   sudo install -m 600 -o root -g root /dev/null /etc/virtual-office-notifier.env
   sudo nano /etc/virtual-office-notifier.env
   ```

5. Install and enable the unit from `deploy/virtual-office-notifier.service`:

   ```bash
   sudo tee /etc/systemd/system/virtual-office-notifier.service < virtual-office-notifier.service
   sudo systemctl daemon-reload
   sudo systemctl enable virtual-office-notifier
   ```

   Copy the unit file over first, e.g. `gcloud compute scp deploy/virtual-office-notifier.service virtual-office-notifier:~ --zone=us-central1-a`.

Then run the first deploy below; it starts the service.

### Deploying

```bash
node scripts/deploy.ts
```

This bundles locally, copies `dist/main.js` and its source map to the VM, swaps them into place and restarts the service. Override the target with `DEPLOY_INSTANCE` (default `virtual-office-notifier`), `DEPLOY_ZONE` (default `us-central1-a`) and `DEPLOY_PROJECT` (default: your `gcloud` project).

### Logs

```bash
gcloud compute ssh virtual-office-notifier --zone=us-central1-a -- journalctl -u virtual-office-notifier -f
```

There's no monitoring. If announcements stop, check the logs.

## Privacy

This broadcasts people's presence to a wider audience. Tell the team before turning it on.
