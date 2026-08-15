import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815012222_add_notification_claim_pid",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_job\` ADD \`notification_claim_pid\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
