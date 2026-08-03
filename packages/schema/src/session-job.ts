export * as SessionJob from "./session-job"

import { Schema } from "effect"
import { Event } from "./event"
import { optional } from "./schema"
import { SessionID } from "./session-id"

export const Status = Schema.Literals([
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
])
export type Status = Schema.Schema.Type<typeof Status>

export const ErrorCode = Schema.Literals([
  "spawn_failed",
  "nonzero_exit",
  "timed_out",
  "explicit_stop",
  "runtime_shutdown",
  "launch_abandoned",
  "output_capture_failed",
])
export type ErrorCode = Schema.Schema.Type<typeof ErrorCode>

export const NotificationState = Schema.Literals(["none", "pending", "claimed", "admitted", "delivered"])
export type NotificationState = Schema.Schema.Type<typeof NotificationState>

export const Info = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  status: Status,
  timeout: Schema.Number,
  outputBytes: Schema.Number,
  outputTruncated: Schema.Boolean,
  outputExpired: Schema.Boolean,
  exitCode: optional(Schema.Number),
  signal: optional(Schema.String),
  errorCode: optional(ErrorCode),
  time: Schema.Struct({
    created: Schema.Number,
    updated: Schema.Number,
    started: optional(Schema.Number),
    completed: optional(Schema.Number),
  }),
}).annotate({ identifier: "SessionJob.Info" })
export type Info = Schema.Schema.Type<typeof Info>

export const Output = Schema.Struct({
  jobID: Schema.String,
  startOffset: Schema.Number,
  nextOffset: Schema.Number,
  totalBytes: Schema.Number,
  eof: Schema.Boolean,
  outputExpired: Schema.Boolean,
  untrustedOutput: Schema.String,
}).annotate({ identifier: "SessionJob.Output" })
export type Output = Schema.Schema.Type<typeof Output>

const EventFields = {
  sessionID: SessionID,
  jobID: Schema.String,
}

export namespace Events {
  export const Started = Event.define({
    type: "session.job.started",
    schema: EventFields,
  })
  export const Progress = Event.define({
    type: "session.job.progress",
    schema: {
      ...EventFields,
      outputBytes: Schema.Number,
      outputTruncated: Schema.Boolean,
    },
  })
  export const Completed = Event.define({
    type: "session.job.completed",
    schema: {
      ...EventFields,
      status: Status,
      outputBytes: Schema.Number,
      outputTruncated: Schema.Boolean,
      exitCode: optional(Schema.Number),
      errorCode: optional(ErrorCode),
    },
  })
}

export const Definitions = Event.inventory(Events.Started, Events.Progress, Events.Completed)
