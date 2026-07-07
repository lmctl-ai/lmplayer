// Transport-agnostic abstraction for remote-operator poll channels. The
// prototype ships an outbound HTTP-mailbox implementation (`httpMailbox`)
// and an in-memory test double (`stub`). A future websocket implementation
// can drop in behind the same `Channel` interface without touching
// `remote/poller.ts` (see the seam comment on `httpMailbox` below).
import { Effect, Ref, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export type Detail = "full" | "delta" | "summary"

// One queued remote-operator instruction. `seq` is a monotonic sequence
// number; the poller advances an `after` cursor by the highest `seq` it has
// processed so subsequent polls only return new instructions.
export interface Instruction {
  readonly id: string
  readonly seq: number
  readonly text: string
}

export interface Response {
  readonly detail: Detail
  readonly text: string
}

export interface Channel<R = never> {
  readonly poll: (after: number) => Effect.Effect<ReadonlyArray<Instruction>, RemoteChannelError, R>
  readonly respond: (instructionId: string, payload: Response) => Effect.Effect<void, RemoteChannelError, R>
}

export class RemoteChannelError extends Schema.TaggedErrorClass<RemoteChannelError>()("RemoteChannelError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const InstructionSchema = Schema.Struct({
  id: Schema.String,
  seq: Schema.Number,
  text: Schema.String,
})

// Tolerate both `{ instructions: Instruction[] }` and a bare `Instruction[]`
// response body from the poll target.
const PollBodySchema = Schema.Union([
  Schema.Struct({ instructions: Schema.Array(InstructionSchema) }),
  Schema.Array(InstructionSchema),
])

// Build the `POST <base>/response` URL safely: `url` is treated as a path
// base. Strip a trailing slash before appending `/response` and preserve any
// existing query string on the base (moved to the end) so bases like
// `https://host/path/` or `https://host/path?box=a` both resolve correctly.
function responseUrl(base: string): string {
  const parsed = new URL(base)
  const query = parsed.search
  parsed.search = ""
  const withoutTrailingSlash = parsed.toString().replace(/\/$/, "")
  return `${withoutTrailingSlash}/response${query}`
}

// Outbound HTTP-mailbox implementation. lmplayer is client-only / outbound-
// only, so this issues `GET <url>?after=<seq>` to fetch instructions and
// `POST <url>/response` to deliver the reply — never accepts inbound
// connections.
//
// Seam for a future `wsChannel(...)`: a websocket implementation would keep
// this exact `Channel` shape — `poll` draining a buffered in-memory queue
// fed by inbound frames, and `respond` sending a frame on the same socket
// instead of issuing an outbound POST.
export const httpMailbox = (input: { url: string; token?: string }): Channel<HttpClient.HttpClient> => {
  const withAuth = (request: HttpClientRequest.HttpClientRequest) =>
    input.token ? HttpClientRequest.bearerToken(request, input.token) : request

  const poll = Effect.fn("RemoteChannel.poll")(function* (after: number) {
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const request = withAuth(
      HttpClientRequest.get(input.url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setUrlParam("after", String(after))),
    )
    const response = yield* http.execute(request).pipe(
      Effect.mapError((cause) => new RemoteChannelError({ message: "remote poll request failed", cause })),
    )
    const body = yield* HttpClientResponse.schemaBodyJson(PollBodySchema)(response).pipe(
      Effect.mapError((cause) => new RemoteChannelError({ message: "failed to decode remote poll response", cause })),
    )
    return Array.isArray(body) ? body : (body as { instructions: ReadonlyArray<Instruction> }).instructions
  })

  const respond = Effect.fn("RemoteChannel.respond")(function* (instructionId: string, payload: Response) {
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const request = withAuth(
      HttpClientRequest.post(responseUrl(input.url)).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJsonUnsafe({ instructionId, detail: payload.detail, text: payload.text }),
      ),
    )
    yield* http.execute(request).pipe(
      Effect.mapError((cause) => new RemoteChannelError({ message: "remote respond request failed", cause })),
    )
  })

  return { poll, respond }
}

// In-memory stub for tests and design work. `poll(after)` returns queued
// instructions with `seq > after`; `respond` records what was posted back so
// tests can assert on it.
export const stub = () => {
  const queueRef = Ref.makeUnsafe<ReadonlyArray<Instruction>>([])
  const postedRef = Ref.makeUnsafe<ReadonlyArray<{ instructionId: string; payload: Response }>>([])

  const channel: Channel = {
    poll: (after) => Ref.get(queueRef).pipe(Effect.map((items) => items.filter((item) => item.seq > after))),
    respond: (instructionId, payload) =>
      Ref.update(postedRef, (items) => [...items, { instructionId, payload }]).pipe(Effect.asVoid),
  }

  return {
    channel,
    enqueue: (instruction: Instruction) => Ref.update(queueRef, (items) => [...items, instruction]).pipe(Effect.runSync),
    responses: () => Ref.get(postedRef).pipe(Effect.map((items) => items.map((item) => item.payload)), Effect.runSync),
    posted: () => Ref.get(postedRef).pipe(Effect.runSync),
  }
}

export * as RemoteChannel from "./channel"
