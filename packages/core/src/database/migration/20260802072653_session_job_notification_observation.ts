import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260802072653_session_job_notification_observation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_job\` ADD \`notification_observed_message_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
