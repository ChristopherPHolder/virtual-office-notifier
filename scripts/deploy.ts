import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const APP_DIR = "/opt/virtual-office-notifier";

const SERVICE = "virtual-office-notifier";

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

const program = Effect.gen(function* () {
  const { instance, zone, project } = yield* DeployConfig;

  const target = [
    `--zone=${zone}`,
    ...Option.match(project, { onNone: () => [], onSome: (id) => [`--project=${id}`] }),
  ];

  yield* run("Bundling", "pnpm", ["build"]);

  yield* run("Copying bundle", "gcloud", [
    "compute",
    "scp",
    ...target,
    "dist/main.js",
    `${instance}:${APP_DIR}/main.js.new`,
  ]);

  yield* run("Copying source map", "gcloud", [
    "compute",
    "scp",
    ...target,
    "dist/main.js.map",
    `${instance}:${APP_DIR}/main.js.map.new`,
  ]);

  yield* run("Restarting service", "gcloud", [
    "compute",
    "ssh",
    instance,
    ...target,
    "--command",
    [
      `cd ${APP_DIR}`,
      "mv main.js.map.new main.js.map",
      "mv main.js.new main.js",
      `sudo systemctl restart ${SERVICE}`,
    ].join(" && "),
  ]);

  yield* Effect.logInfo(`Deployed. Logs: journalctl -u ${SERVICE} -f`);
});

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
