import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918103549_session_cron",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_cron\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`cron\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`recurring\` integer DEFAULT true NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_expires\` integer,
          \`time_last_fired\` integer,
          CONSTRAINT \`fk_session_cron_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_cron_session_idx\` ON \`session_cron\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_cron_session_time_created_idx\` ON \`session_cron\` (\`session_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
