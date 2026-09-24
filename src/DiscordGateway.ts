import { type Cause, Context, Effect, Layer, Queue, Redacted, Schema, Stream } from "effect";
import { Client, Events, GatewayIntentBits, type VoiceState } from "discord.js";

import { DiscordConfig } from "./Config.ts";
import { isOfficeJoin, toVoiceJoin, type VoiceJoin, type VoiceStateUpdate } from "./VoiceJoin.ts";

export class DiscordLoginError extends Schema.TaggedError<DiscordLoginError>()("DiscordLoginError", {
  cause: Schema.Defect(),
}) {}

export const officeJoins =
  (officeChannelId: string) =>
  <E, R>(updates: Stream.Stream<VoiceStateUpdate, E, R>): Stream.Stream<VoiceJoin, E, R> =>
    updates.pipe(
      Stream.filter((update) => isOfficeJoin(officeChannelId, update)),
      Stream.map((update) => toVoiceJoin(officeChannelId, update)),
    );

const toVoiceStateUpdate = (oldState: VoiceState, newState: VoiceState): VoiceStateUpdate => ({
  userId: newState.id,
  displayName: newState.member?.displayName ?? newState.id,
  guildId: newState.guild.id,
  oldChannelId: oldState.channelId,
  newChannelId: newState.channelId,
  isBot: newState.member?.user.bot ?? false,
});

const voiceStateUpdates = (client: Client) =>
  Stream.callback<VoiceStateUpdate>(
    Effect.fnUntraced(function* (queue) {
      const onUpdate = (oldState: VoiceState, newState: VoiceState) => {
        Queue.offerUnsafe(queue, toVoiceStateUpdate(oldState, newState));
      };

      yield* Effect.acquireRelease(
        Effect.sync(() => client.on(Events.VoiceStateUpdate, onUpdate)),
        () => Effect.sync(() => client.off(Events.VoiceStateUpdate, onUpdate)),
      );
    }),
  );

const login = (client: Client, token: Redacted.Redacted<string>) =>
  Effect.callback<Client<true>, DiscordLoginError>((resume) => {
    client.once(Events.ClientReady, (ready) => resume(Effect.succeed(ready)));
    client.login(Redacted.value(token)).catch((cause: unknown) => {
      resume(Effect.fail(new DiscordLoginError({ cause })));
    });
  });

export class DiscordGateway extends Context.Service<
  DiscordGateway,
  {
    readonly voiceJoins: Stream.Stream<VoiceJoin>;
  }
>()("virtual-office-notifier/DiscordGateway") {
  static readonly layer = Layer.effect(
    DiscordGateway,
    Effect.gen(function* () {
      const { botToken, officeChannelId } = yield* DiscordConfig;
      const context = yield* Effect.context();
      const runFork = Effect.runForkWith(context);

      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () => new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] }),
        ),
        (client) =>
          Effect.promise(() => client.destroy()).pipe(Effect.andThen(Effect.logInfo("Disconnected from Discord"))),
      );

      // An EventEmitter "error" event with no listener would crash the process.
      client.on(Events.Error, (error) => runFork(Effect.logError("Discord client error", error)));
      client.on(Events.Warn, (message) => runFork(Effect.logWarning("Discord client warning", message)));

      const ready = yield* login(client, botToken);
      const office = ready.channels.cache.get(officeChannelId);

      yield* Effect.logInfo("Connected to Discord").pipe(
        Effect.annotateLogs({
          user: ready.user.tag,
          officeChannelId,
          officeChannel: office !== undefined && "name" in office ? office.name : "not found",
        }),
      );

      return DiscordGateway.of({
        voiceJoins: voiceStateUpdates(client).pipe(officeJoins(officeChannelId)),
      });
    }),
  );

  // Feeds the same join filter from a queue, so tests exercise everything but
  // discord.js itself.
  static readonly layerTest = (updates: Queue.Dequeue<VoiceStateUpdate, Cause.Done>) =>
    Layer.effect(
      DiscordGateway,
      Effect.gen(function* () {
        const { officeChannelId } = yield* DiscordConfig;

        return DiscordGateway.of({
          voiceJoins: Stream.fromQueue(updates).pipe(officeJoins(officeChannelId)),
        });
      }),
    );
}
