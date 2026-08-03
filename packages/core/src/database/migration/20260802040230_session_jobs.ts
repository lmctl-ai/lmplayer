import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260802040230_session_jobs",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_job\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`tool_call_id\` text NOT NULL,
          \`submission_hash\` text NOT NULL,
          \`kind\` text DEFAULT 'shell' NOT NULL,
          \`command\` text NOT NULL,
          \`cwd\` text NOT NULL,
          \`shell\` text NOT NULL,
          \`timeout_ms\` integer NOT NULL,
          \`deadline_at\` integer,
          \`status\` text NOT NULL,
          \`runtime_id\` text,
          \`launch_fence\` integer DEFAULT 0 NOT NULL,
          \`pid\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_started\` integer,
          \`time_completed\` integer,
          \`exit_code\` integer,
          \`signal\` text,
          \`error_code\` text,
          \`diagnostic_error\` text,
          \`output_path\` text NOT NULL,
          \`output_bytes\` integer DEFAULT 0 NOT NULL,
          \`output_truncated\` integer DEFAULT false NOT NULL,
          \`output_dropped_bytes\` integer DEFAULT 0 NOT NULL,
          \`output_expired\` integer DEFAULT false NOT NULL,
          \`notification_state\` text DEFAULT 'none' NOT NULL,
          \`notification_claim_token\` text,
          \`notification_claim_until\` integer,
          \`notification_batch_id\` text,
          \`notification_message_id\` text,
          \`notification_delivered_at\` integer,
          CONSTRAINT \`fk_session_job_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_job_submission_idx\` ON \`session_job\` (\`session_id\`,\`assistant_message_id\`,\`tool_call_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_job_session_status_idx\` ON \`session_job\` (\`session_id\`,\`status\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_job_session_notification_idx\` ON \`session_job\` (\`session_id\`,\`notification_state\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
