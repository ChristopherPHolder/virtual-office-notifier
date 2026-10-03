import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { AiConfig, DiscordConfig, ProductionDatabaseConfig, SlackConfig } from "../src/Config.ts";

const APP_DIR = "/opt/virtual-office-notifier";

const SERVICE = "virtual-office-notifier";

const UNIT_FILE = `deploy/${SERVICE}.service`;

const ENV_FILE = `${SERVICE}.env`;

class DeployError extends Schema.TaggedError<DeployError>()("DeployError", {
  step: Schema.String,
  exitCode: Schema.Int,
}) {}

const DeployConfig = Config.all({
  instance: Config.String("DEPLOY_INSTANCE").pipe(Config.withDefault("virtual-office-notifier")),
  zone: Config.String("DEPLOY_ZONE").pipe(Config.withDefault("us-central1-a")),
  project: Config.option(Config.String("DEPLOY_PROJECT")),
});

const run = Effect.fnUntraced(function* (step: string, command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  yield* Effect.logInfo(step);

  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(command, args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
  );

  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new DeployError({ step, exitCode });
  }
});

const envLine = (name: string, value: Option.Option<Redacted.Redacted<string>>): ReadonlyArray<string> =>
  Option.toArray(Option.map(value, (secret) => `${name}=${Redacted.value(secret)}`));

// Writes the service's environment file into a scoped temp directory, so the
// secrets never land in the working tree and are deleted after the upload.
const writeEnvFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const discord = yield* DiscordConfig;
  const slack = yield* SlackConfig;
  const ai = yield* AiConfig;
  const database = yield* ProductionDatabaseConfig;

  const dir = yield* fs.makeTempDirectoryScoped({ prefix: `${SERVICE}-` });
  const file = path.join(dir, ENV_FILE);

  yield* fs.writeFileString(
    file,
    [
      `DISCORD_BOT_TOKEN=${Redacted.value(discord.botToken)}`,
      `DISCORD_OFFICE_CHANNEL_ID=${discord.officeChannelId}`,
      `SLACK_WEBHOOK_URL=${Redacted.value(slack.webhookUrl)}`,
      ...envLine("OPENROUTER_API_KEY", ai.openRouter.apiKey),
      ...envLine("CLOUDFLARE_ACCOUNT_ID", ai.cloudflare.accountId),
      ...envLine("CLOUDFLARE_API_TOKEN", ai.cloudflare.apiToken),
      `DATABASE_URL=${Redacted.value(database.url)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  return file;
});

const program = Effect.gen(function* () {
  const { instance, zone, project } = yield* DeployConfig;

  // Fresh CI runners have no SSH key yet; --quiet generates one without
  // prompting, and the expiry stops keys piling up on the VM.
  const target = [
    `--zone=${zone}`,
    ...Option.match(project, { onNone: () => [], onSome: (id) => [`--project=${id}`] }),
    "--quiet",
    "--ssh-key-expire-after=1h",
  ];

  const envFile = yield* writeEnvFile;

  yield* run("Bundling", "pnpm", ["build"]);

  yield* run("Uploading release", "gcloud", [
    "compute",
    "scp",
    ...target,
    "dist/main.js",
    "dist/main.js.map",
    UNIT_FILE,
    envFile,
    `${instance}:~/`,
  ]);

  yield* run("Installing and restarting service", "gcloud", [
    "compute",
    "ssh",
    instance,
    ...target,
    "--command",
    [
      "set -eu",
      `trap 'rm -f main.js main.js.map ${SERVICE}.service ${ENV_FILE}' EXIT`,
      `sudo install -m 600 -o root -g root ${ENV_FILE} /etc/${ENV_FILE}`,
      `sudo install -m 644 -o root -g root ${SERVICE}.service /etc/systemd/system/${SERVICE}.service`,
      `sudo install -m 644 -o root -g root main.js main.js.map ${APP_DIR}/`,
      "sudo systemctl daemon-reload",
      `sudo systemctl enable ${SERVICE}`,
      `sudo systemctl restart ${SERVICE}`,
      // A bad token or missing variable crashes on startup; wait long enough
      // to catch it so the deploy fails instead of silently restart-looping.
      "sleep 15",
      `systemctl is-active --quiet ${SERVICE} || { sudo journalctl -u ${SERVICE} -n 50 --no-pager; exit 1; }`,
    ].join("\n"),
  ]);

  yield* Effect.logInfo(`Deployed. Logs: journalctl -u ${SERVICE} -f`);
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
