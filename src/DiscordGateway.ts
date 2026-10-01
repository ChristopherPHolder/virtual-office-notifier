import { type Cause, Context, DateTime, Effect, Layer, Option, Queue, Redacted, Schema, Stream } from "effect";
import { Client, Events, GatewayIntentBits, type VoiceState } from "discord.js";

import { DiscordConfig } from "./Config.ts";
import {
  type OfficeEvent,
  type OfficeLocation,
  type Occupants,
  sessionOf,
  trackOccupancy,
  type VoiceStateUpdate,
} from "./OfficeEvent.ts";

export class DiscordLoginError extends Schema.TaggedError<DiscordLoginError>()("DiscordLoginError", {
  cause: Schema.Defect(),
}) {}

const officeEvents =
  (officeChannelId: string, occupants: Occupants) =>
  <E, R>(updates: Stream.Stream<VoiceStateUpdate, E, R>): Stream.Stream<OfficeEvent, E, R> =>
    updates.pipe(
      Stream.mapEffect((update) => DateTime.now.pipe(Effect.map((at) => ({ ...update, at })))),
      Stream.mapAccum(() => sessionOf(occupants), trackOccupancy(officeChannelId)),
    );

const toVoiceStateUpdate = (oldState: VoiceState, newState: VoiceState): VoiceStateUpdate => ({
  userId: newState.id,
  displayName: newState.member?.displayName ?? newState.id,
  // Slack can't show Discord's default WebP avatars.
  avatarUrl: newState.member?.displayAvatarURL({ extension: "png", size: 128 }) ?? null,
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
    readonly officeEvents: Stream.Stream<OfficeEvent>;
    // None when the office channel wasn't found at startup.
    readonly office: Option.Option<OfficeLocation>;
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

      const office = Option.fromUndefinedOr(ready.channels.cache.get(officeChannelId)).pipe(
        Option.filter((channel) => channel.isVoiceBased()),
      );

      yield* Effect.logInfo("Connected to Discord").pipe(
        Effect.annotateLogs({ user: ready.user.tag, guilds: ready.guilds.cache.size }),
      );

      // Seeded from the voice states Discord sends on connect, so restarting while
      // people are in the office doesn't announce it opening again.
      const occupants: Occupants = new Set(
        Option.match(office, {
          onNone: () => [],
          onSome: (channel) => channel.members.filter((member) => !member.user.bot).keys(),
        }),
      );

      // Keep running either way: the bot may be added to the server later.
      yield* Option.match(office, {
        onNone: () =>
          Effect.logWarning(
            "Office voice channel not found. Check DISCORD_OFFICE_CHANNEL_ID and that the bot is in the server and can view the channel.",
          ).pipe(Effect.annotateLogs({ officeChannelId, guilds: ready.guilds.cache.size })),
        onSome: (channel) =>
          Effect.logInfo("Found the office voice channel").pipe(
            Effect.annotateLogs({ officeChannelId, officeChannel: channel.name, occupants: occupants.size }),
          ),
      });

      return DiscordGateway.of({
        officeEvents: voiceStateUpdates(client).pipe(officeEvents(officeChannelId, occupants)),
        office: Option.map(office, (channel) => ({ guildId: channel.guild.id, channelId: officeChannelId })),
      });
    }),
  );

  // Feeds the same occupancy tracking from a queue, so tests exercise everything but
  // discord.js itself.
  static readonly layerTest = (
    updates: Queue.Dequeue<VoiceStateUpdate, Cause.Done>,
    occupants: Occupants = new Set(),
    guildId = "guild",
  ) =>
    Layer.effect(
      DiscordGateway,
      Effect.gen(function* () {
        const { officeChannelId } = yield* DiscordConfig;

        return DiscordGateway.of({
          officeEvents: Stream.fromQueue(updates).pipe(officeEvents(officeChannelId, occupants)),
          office: Option.some({ guildId, channelId: officeChannelId }),
        });
      }),
    );
}
