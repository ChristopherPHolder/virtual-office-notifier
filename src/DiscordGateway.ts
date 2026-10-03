import {
  Cause,
  Context,
  DateTime,
  Effect,
  ErrorReporter,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { Client, Events, GatewayIntentBits, type GuildMember, type VoiceState } from "discord.js";

import { DiscordConfig } from "./Config.ts";
import {
  NO_VOICE_DETAILS,
  type OfficeEvent,
  type OfficeLocation,
  type Occupants,
  sessionOf,
  trackOccupancy,
  type VoiceDetails,
  type VoiceStateUpdate,
} from "./OfficeEvent.ts";
import { observe, type VoiceObservation } from "./VoiceObservation.ts";

export class DiscordLoginError extends Schema.TaggedError<DiscordLoginError>()("DiscordLoginError", {
  cause: Schema.Defect(),
}) {}

const stamped = <E, R>(updates: Stream.Stream<VoiceStateUpdate, E, R>) =>
  updates.pipe(Stream.mapEffect((update) => DateTime.now.pipe(Effect.map((at) => ({ ...update, at })))));

const officeEvents =
  (officeChannelId: string, occupants: Occupants) =>
  <E, R>(updates: Stream.Stream<VoiceStateUpdate, E, R>): Stream.Stream<OfficeEvent, E, R> =>
    stamped(updates).pipe(Stream.mapAccum(() => sessionOf(occupants), trackOccupancy(officeChannelId)));

// Starts with whoever was already in the office at startup, then follows every
// update touching it.
const voiceObservations =
  (officeChannelId: string, present: ReadonlyArray<VoiceStateUpdate>) =>
  <E, R>(updates: Stream.Stream<VoiceStateUpdate, E, R>): Stream.Stream<VoiceObservation, E, R> =>
    stamped(Stream.fromIterable(present)).pipe(
      Stream.map((update): VoiceObservation => ({ ...update, source: "startup", officeChannelId })),
      Stream.concat(stamped(updates).pipe(Stream.filterMap(observe(officeChannelId)))),
    );

const detailsOf = (state: VoiceState): VoiceDetails => ({
  selfMute: state.selfMute,
  selfDeaf: state.selfDeaf,
  serverMute: state.serverMute,
  serverDeaf: state.serverDeaf,
  selfVideo: state.selfVideo,
  streaming: state.streaming,
  suppress: state.suppress,
  requestToSpeakAt: state.requestToSpeakTimestamp === null ? null : DateTime.makeUnsafe(state.requestToSpeakTimestamp),
  sessionId: state.sessionId,
});

const memberOf = (state: VoiceState) => ({
  userId: state.id,
  displayName: state.member?.displayName ?? state.id,
  // Slack can't show Discord's default WebP avatars.
  avatarUrl: state.member?.displayAvatarURL({ extension: "png", size: 128 }) ?? null,
  guildId: state.guild.id,
  isBot: state.member?.user.bot ?? false,
});

const toVoiceStateUpdate = (oldState: VoiceState, newState: VoiceState): VoiceStateUpdate => ({
  ...memberOf(newState),
  oldChannelId: oldState.channelId,
  newChannelId: newState.channelId,
  oldDetails: detailsOf(oldState),
  newDetails: detailsOf(newState),
});

// Someone already in the office at startup, as if they had just joined.
const alreadyPresent = (member: GuildMember): VoiceStateUpdate => ({
  ...memberOf(member.voice),
  oldChannelId: null,
  newChannelId: member.voice.channelId,
  oldDetails: NO_VOICE_DETAILS,
  newDetails: detailsOf(member.voice),
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
    // Everything to record about the office, from the same updates.
    readonly voiceObservations: Stream.Stream<VoiceObservation>;
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
      client.on(Events.Error, (error) =>
        runFork(Effect.logError("Discord client error", error).pipe(Effect.andThen(ErrorReporter.report(Cause.fail(error))))),
      );
      client.on(Events.Warn, (message) => runFork(Effect.logWarning("Discord client warning", message)));

      const ready = yield* login(client, botToken);

      const office = Option.fromUndefinedOr(ready.channels.cache.get(officeChannelId)).pipe(
        Option.filter((channel) => channel.isVoiceBased()),
      );

      yield* Effect.logInfo("Connected to Discord").pipe(
        Effect.annotateLogs({ user: ready.user.tag, guilds: ready.guilds.cache.size }),
      );

      // From the voice states Discord sends on connect.
      const present = Option.match(office, {
        onNone: () => [],
        onSome: (channel) => [...channel.members.filter((member) => !member.user.bot).values()],
      });

      // Seeded from who's present, so restarting while people are in the office
      // doesn't announce it opening again.
      const occupants: Occupants = new Set(present.map((member) => member.id));

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
        voiceObservations: voiceStateUpdates(client).pipe(
          voiceObservations(officeChannelId, present.map(alreadyPresent)),
        ),
        office: Option.map(office, (channel) => ({ guildId: channel.guild.id, channelId: officeChannelId })),
      });
    }),
  );

  // Feeds the same occupancy tracking and observations from a queue, so tests
  // exercise everything but discord.js itself. `present` is who was in the
  // office at startup.
  static readonly layerTest = (
    updates: Queue.Dequeue<VoiceStateUpdate, Cause.Done>,
    occupants: Occupants = new Set(),
    guildId = "guild",
    present: ReadonlyArray<VoiceStateUpdate> = [],
  ) =>
    Layer.effect(
      DiscordGateway,
      Effect.gen(function* () {
        const { officeChannelId } = yield* DiscordConfig;

        // Both streams need every update, like the two listeners on the real
        // client.
        const shared = yield* Stream.fromQueue(updates).pipe(Stream.broadcast({ capacity: "unbounded", replay: 1000 }));

        return DiscordGateway.of({
          officeEvents: shared.pipe(officeEvents(officeChannelId, occupants)),
          voiceObservations: shared.pipe(voiceObservations(officeChannelId, present)),
          office: Option.some({ guildId, channelId: officeChannelId }),
        });
      }),
    );
}
