import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260804023541_session_job_owner_fencing",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_job\` ADD \`runtime_pid\` integer;`)
      yield* tx.run(`ALTER TABLE \`session_job\` ADD \`output_delete_token\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
