import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260802054542_session_job_output_reads",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_job_output_read\` (
          \`token\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`job_id\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          CONSTRAINT \`fk_session_job_output_read_job_id_session_job_id_fk\` FOREIGN KEY (\`job_id\`) REFERENCES \`session_job\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session_job\` ADD \`output_deleting\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX \`session_job_output_read_job_idx\` ON \`session_job_output_read\` (\`session_id\`,\`job_id\`,\`expires_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
