import { ConfigProvider, DateTime, Effect, ErrorReporter, Layer, Random, Ref } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { ActivityRecorder } from "../src/ActivityRecorder.ts";
import { HeadlineWriter } from "../src/HeadlineWriter.ts";
import { SlackNotifier } from "../src/SlackNotifier.ts";
import { OfficeEvent } from "../src/OfficeEvent.ts";
import type { VoiceObservation } from "../src/VoiceObservation.ts";

export const WEBHOOK_URL = "https://hooks.slack.com/services/TEST/WEBHOOK/secret";

export const opened = OfficeEvent.Opened({
  userId: "u1",
  displayName: "Ada",
  avatarUrl: "https://cdn.discordapp.com/avatars/u1/a.png",
  guildId: "g1",
  channelId: "c1",
  at: DateTime.makeUnsafe(0),
});

// Always picks the first phrasing, so tests can assert exact text.
export const firstVariant = Effect.provideService(Random.Random, {
  nextIntUnsafe: () => 0,
  nextDoubleUnsafe: () => 0,
});

export type Reply = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

export const respond =
  (status: number, body: string, headers: Record<string, string> = {}): Reply =>
  (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status, headers })));

export const ok = respond(200, "ok");

export const networkDown: Reply = (request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request,
        description: "connect ECONNREFUSED",
      }),
    }),
  );

export const hang: Reply = () => Effect.never;

export const requestText = (request: HttpClientRequest.HttpClientRequest): string =>
  request.body instanceof HttpBody.Uint8Array ? new TextDecoder().decode(request.body.body) : "";

// A fake Slack webhook: serves the scripted replies in order, repeating the
// last one, and records every request so tests can count attempts.
export const makeFakeSlack = Effect.fnUntraced(function* (
  replies: ReadonlyArray<Reply>,
  headlines: Layer.Layer<HeadlineWriter> = HeadlineWriter.layerFixed,
) {
  const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);

  const client = HttpClient.make((request) =>
    Ref.modify(requests, (sent) => [sent.length, [...sent, request]]).pipe(
      Effect.flatMap((index) => (replies[index] ?? replies.at(-1) ?? ok)(request)),
    ),
  );

  const layer = SlackNotifier.layerNoDeps.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(headlines),
  );

  return {
    layer,
    requests: Ref.get(requests),
    postedTexts: Ref.get(requests).pipe(
      Effect.map((sent) => sent.map((request) => JSON.parse(requestText(request)).text)),
    ),
    postedBodies: Ref.get(requests).pipe(Effect.map((sent) => sent.map((request) => JSON.parse(requestText(request))))),
  };
});

// Collects what the program would record, without a database.
export const makeFakeRecorder = Effect.fnUntraced(function* () {
  const recorded = yield* Ref.make<ReadonlyArray<VoiceObservation>>([]);

  const layer = Layer.succeed(
    ActivityRecorder,
    ActivityRecorder.of({ record: (observation) => Ref.update(recorded, (all) => [...all, observation]) }),
  );

  return { layer, recorded: Ref.get(recorded) };
});

export const withEnv = (env: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));

export interface Report {
  readonly name: string;
  readonly message: string;
  readonly severity: string;
}

// Collects what would be reported to Sentry.
export const captureReports = () => {
  const reports: Array<Report> = [];

  const layer = ErrorReporter.layer([
    ErrorReporter.make(({ error, severity }) => {
      reports.push({ name: error.name, message: error.message, severity });
    }),
  ]);

  return { reports, layer };
};
