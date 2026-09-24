import { ConfigProvider, Effect, Layer, Ref } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { SlackNotifier } from "../src/SlackNotifier.ts";
import type { VoiceJoin } from "../src/VoiceJoin.ts";

export const WEBHOOK_URL = "https://hooks.slack.com/services/TEST/WEBHOOK/secret";

export const join: VoiceJoin = {
  userId: "u1",
  displayName: "Ada",
  guildId: "g1",
  channelId: "c1",
};

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
export const makeFakeSlack = Effect.fnUntraced(function* (replies: ReadonlyArray<Reply>) {
  const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);

  const client = HttpClient.make((request) =>
    Ref.modify(requests, (sent) => [sent.length, [...sent, request]]).pipe(
      Effect.flatMap((index) => (replies[index] ?? replies.at(-1) ?? ok)(request)),
    ),
  );

  const layer = SlackNotifier.layerNoDeps.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));

  return {
    layer,
    requests: Ref.get(requests),
    postedTexts: Ref.get(requests).pipe(
      Effect.map((sent) => sent.map((request) => JSON.parse(requestText(request)).text)),
    ),
  };
});

export const withEnv = (env: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));
