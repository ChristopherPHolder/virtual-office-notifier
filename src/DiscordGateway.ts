import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  ErrorReporter,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  Stream,
} from "effect";
import {
  Client,
  Events,
  GatewayIntentBits,
  GatewayOpcodes,
  type Guild,
  type GuildMember,
  PermissionFlagsBits,
  Routes,
  Status,
  type VoiceChannelEffect,
  type VoiceState,
} from "discord.js";

import { type BotPresence, presenceAfter, presenceAtStartup } from "./BotPresence.ts";
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
import { sentInOffice, type TimedVoiceEffect, type VoiceEffect } from "./VoiceEffect.ts";
import { observe, type VoiceObservation } from "./VoiceObservation.ts";

export class DiscordLoginError extends Schema.TaggedError<DiscordLoginError>()("DiscordLoginError", {
  cause: Schema.Defect(),
}) {}

const stamped = <A extends VoiceStateUpdate | VoiceEffect, E, R>(updates: Stream.Stream<A, E, R>) =>
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

const officeEffects =
  (officeChannelId: string) =>
  <E, R>(effects: Stream.Stream<VoiceEffect, E, R>): Stream.Stream<TimedVoiceEffect, E, R> =>
    stamped(effects).pipe(Stream.filterMap(sentInOffice(officeChannelId)));

const botPresence = <E, R>(occupants: Occupants, events: Stream.Stream<OfficeEvent, E, R>) =>
  Stream.make(presenceAtStartup(occupants)).pipe(Stream.concat(events.pipe(Stream.filterMap(presenceAfter))));

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
  isBot: (state.member?.user.bot ?? false) || state.id === state.client.user?.id,
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

type DefaultSoundNames = ReadonlyMap<string, string>;

const soundNameOf = (effect: VoiceChannelEffect, defaultSounds: DefaultSoundNames): string | null => {
  if (effect.soundId === null) return null;

  const soundId = String(effect.soundId);

  return effect.guild.soundboardSounds.cache.get(soundId)?.name ?? defaultSounds.get(soundId) ?? null;
};

const toVoiceEffect = (effect: VoiceChannelEffect, defaultSounds: DefaultSoundNames): VoiceEffect => {
  const member = effect.guild.members.cache.get(effect.userId);

  return {
    userId: effect.userId,
    displayName: member?.displayName ?? effect.userId,
    isBot: member?.user.bot ?? false,
    guildId: effect.guild.id,
    channelId: effect.channelId,
    soundId: effect.soundId === null ? null : String(effect.soundId),
    soundName: soundNameOf(effect, defaultSounds),
    soundVolume: effect.soundVolume,
    emojiId: effect.emoji?.id ?? null,
    emojiName: effect.emoji?.name ?? null,
    emojiAnimated: effect.emoji?.animated ?? null,
    animationType: effect.animationType,
    animationId: effect.animationId,
  };
};

const voiceEffects = (client: Client, defaultSounds: DefaultSoundNames) =>
  Stream.callback<VoiceEffect>(
    Effect.fnUntraced(function* (queue) {
      const onEffect = (effect: VoiceChannelEffect) => {
        Queue.offerUnsafe(queue, toVoiceEffect(effect, defaultSounds));
      };

      yield* Effect.acquireRelease(
        Effect.sync(() => client.on(Events.VoiceChannelEffectSend, onEffect)),
        () => Effect.sync(() => client.off(Events.VoiceChannelEffectSend, onEffect)),
      );
    }),
  );

const decodeDefaultSounds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ sound_id: Schema.String, name: Schema.String })),
);

const fetchDefaultSoundNames = (client: Client<true>) =>
  Effect.tryPromise(() => client.rest.get(Routes.soundboardDefaultSounds())).pipe(
    Effect.flatMap(decodeDefaultSounds),
    Effect.map((sounds): DefaultSoundNames => new Map(sounds.map((sound) => [sound.sound_id, sound.name]))),
    Effect.timeout(Duration.seconds(10)),
    Effect.catch((error) =>
      Effect.logWarning("Couldn't fetch Discord's default soundboard sounds, so their names aren't recorded").pipe(
        Effect.annotateLogs({ reason: String(error) }),
        Effect.as<DefaultSoundNames>(new Map()),
      ),
    ),
  );

export class BotMoveError extends Schema.TaggedError<BotMoveError>()("BotMoveError", {
  reason: Schema.String,
}) {}

const sendVoiceState = (guild: Guild, channelId: string | null) =>
  guild.shard.status === Status.Ready
    ? Effect.try({
        try: () =>
          guild.shard.send({
            op: GatewayOpcodes.VoiceStateUpdate,
            d: { guild_id: guild.id, channel_id: channelId, self_mute: true, self_deaf: true },
          }),
        catch: (cause) => new BotMoveError({ reason: String(cause) }),
      })
    : Effect.fail(new BotMoveError({ reason: "Discord isn't connected" }));

const moveBot = (guild: Guild, officeChannelId: string) => (presence: BotPresence) =>
  sendVoiceState(guild, presence === "InOffice" ? officeChannelId : null).pipe(
    Effect.andThen(Effect.logInfo("Moved the bot")),
    Effect.catchTag("BotMoveError", (error) =>
      Effect.logWarning("Couldn't move the bot").pipe(Effect.annotateLogs({ reason: error.reason })),
    ),
    Effect.annotateLogs({ presence }),
  );

const login = (client: Client, token: Redacted.Redacted<string>) =>
  Effect.callback<Client<true>, DiscordLoginError>((resume) => {
    client.once(Events.ClientReady, (ready) => resume(Effect.succeed(ready)));
    client.login(Redacted.value(token)).catch((cause: unknown) => {
      resume(Effect.fail(new DiscordLoginError({ cause })));
    });
  });

export interface TestGateway {
  readonly updates: Queue.Dequeue<VoiceStateUpdate, Cause.Done>;
  readonly occupants?: Occupants;
  readonly guildId?: string;
  readonly present?: ReadonlyArray<VoiceStateUpdate>;
  readonly effects?: ReadonlyArray<VoiceEffect>;
  readonly moves?: Queue.Enqueue<BotPresence>;
}

export class DiscordGateway extends Context.Service<
  DiscordGateway,
  {
    readonly officeEvents: Stream.Stream<OfficeEvent>;
    // Everything to record about the office, from the same updates.
    readonly voiceObservations: Stream.Stream<VoiceObservation>;
    readonly voiceEffects: Stream.Stream<TimedVoiceEffect>;
    readonly botPresence: Stream.Stream<BotPresence>;
    moveBot(presence: BotPresence): Effect.Effect<void>;
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
          () =>
            new Client({
              intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildExpressions],
            }),
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

      const defaultSounds = yield* fetchDefaultSoundNames(ready);

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
            Effect.andThen(
              channel.permissionsFor(ready.user)?.has(PermissionFlagsBits.Connect)
                ? Effect.void
                : Effect.logWarning(
                    "The bot can't connect to the office voice channel, so soundboard sounds and emoji reactions aren't recorded. Give it the Connect permission.",
                  ),
            ),
          ),
      });

      return DiscordGateway.of({
        officeEvents: voiceStateUpdates(client).pipe(officeEvents(officeChannelId, occupants)),
        voiceObservations: voiceStateUpdates(client).pipe(
          voiceObservations(officeChannelId, present.map(alreadyPresent)),
        ),
        voiceEffects: voiceEffects(client, defaultSounds).pipe(officeEffects(officeChannelId)),
        botPresence: Option.match(office, {
          onNone: () => Stream.empty,
          onSome: () => botPresence(occupants, voiceStateUpdates(client).pipe(officeEvents(officeChannelId, occupants))),
        }),
        moveBot: Option.match(office, {
          onNone: () => () => Effect.void,
          onSome: (channel) => moveBot(channel.guild, officeChannelId),
        }),
        office: Option.map(office, (channel) => ({ guildId: channel.guild.id, channelId: officeChannelId })),
      });
    }),
  );

  // Feeds the same occupancy tracking and observations from a queue, so tests
  // exercise everything but discord.js itself. `present` is who was in the
  // office at startup.
  static readonly layerTest = ({
    updates,
    occupants = new Set(),
    guildId = "guild",
    present = [],
    effects = [],
    moves,
  }: TestGateway) =>
    Layer.effect(
      DiscordGateway,
      Effect.gen(function* () {
        const { officeChannelId } = yield* DiscordConfig;

        // Every stream needs every update, like the listeners on the real
        // client.
        const shared = yield* Stream.fromQueue(updates).pipe(Stream.broadcast({ capacity: "unbounded", replay: 1000 }));

        return DiscordGateway.of({
          officeEvents: shared.pipe(officeEvents(officeChannelId, occupants)),
          voiceObservations: shared.pipe(voiceObservations(officeChannelId, present)),
          voiceEffects: Stream.fromIterable(effects).pipe(officeEffects(officeChannelId)),
          botPresence: botPresence(occupants, shared.pipe(officeEvents(officeChannelId, occupants))),
          moveBot: (presence) => (moves === undefined ? Effect.void : Queue.offer(moves, presence).pipe(Effect.asVoid)),
          office: Option.some({ guildId, channelId: officeChannelId }),
        });
      }),
    );
}
