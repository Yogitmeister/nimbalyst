-- Add the durable host-control foundation without disturbing the candidate's
-- already-applied queued-prompt priority, fencing, and provenance migrations.

CREATE TABLE IF NOT EXISTS host_control_receipts (
  id TEXT PRIMARY KEY,
  reservation_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation = 'inject_attention_reply'),
  session_id TEXT NOT NULL,
  event_identity TEXT NOT NULL,
  attention_generation TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'injected', 'already_resolved', 'failed')),
  reservation_owner TEXT,
  lease_expires_at TEXT,
  mutation_id TEXT,
  mutation_fence INTEGER NOT NULL DEFAULT 0,
  mutation_state TEXT NOT NULL DEFAULT 'not_started'
    CHECK (mutation_state IN ('not_started', 'unknown', 'not_applied', 'applied', 'legacy_unknown')),
  mutation_started_at TEXT,
  mutation_applied_at TEXT,
  mutation_receipt TEXT,
  cleanup_prompt_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (cleanup_prompt_state IN ('pending', 'claimed', 'complete')),
  cleanup_prompt_fence INTEGER NOT NULL DEFAULT 0,
  cleanup_attention_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (cleanup_attention_state IN ('pending', 'claimed', 'complete')),
  cleanup_attention_fence INTEGER NOT NULL DEFAULT 0,
  cleanup_attention_result TEXT
    CHECK (cleanup_attention_result IN ('settled', 'already_absent')),
  cleanup_terminal_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (cleanup_terminal_state IN ('pending', 'claimed', 'complete')),
  cleanup_terminal_fence INTEGER NOT NULL DEFAULT 0,
  receipt TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_host_control_receipts_session
  ON host_control_receipts(session_id, created_at);

CREATE TABLE IF NOT EXISTS native_winner_outbox (
  id TEXT PRIMARY KEY,
  reservation_key TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  event_identity TEXT NOT NULL,
  attention_generation TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  receipt TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_attempt_at TEXT,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_native_winner_outbox_pending
  ON native_winner_outbox(created_at, id) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS host_control_store_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id TEXT NOT NULL UNIQUE,
  authority_root TEXT NOT NULL
);

ALTER TABLE queued_prompts ADD COLUMN interrupt_lease_expires_at TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_operation_id TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queued_prompts ADD COLUMN interrupt_application_state TEXT NOT NULL DEFAULT 'not_started'
  CHECK (interrupt_application_state IN ('not_started', 'unknown', 'not_applied', 'applied', 'legacy_unknown'));
ALTER TABLE queued_prompts ADD COLUMN interrupt_started_at TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_applied_at TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_application_receipt TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_cleanup_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (interrupt_cleanup_state IN ('pending', 'claimed', 'complete'));
ALTER TABLE queued_prompts ADD COLUMN interrupt_cleanup_fence INTEGER NOT NULL DEFAULT 0;

UPDATE queued_prompts
SET interrupt_operation_id = COALESCE(
      interrupt_operation_id,
      'legacy-interrupt:' || id || ':' || COALESCE(interrupt_target_generation, 'missing')
    ),
    interrupt_reservation_owner = COALESCE(interrupt_reservation_owner, 'legacy-orphan'),
    interrupt_lease_expires_at = COALESCE(interrupt_lease_expires_at, '1970-01-01T00:00:00.000Z'),
    interrupt_application_state = 'legacy_unknown'
WHERE interrupt_target_generation IS NOT NULL
  AND interrupt_receipt IS NULL
  AND interrupt_operation_id IS NULL
  AND interrupt_reservation_owner IS NULL
  AND interrupt_lease_expires_at IS NULL
  AND interrupt_fence = 0
  AND interrupt_application_state = 'not_started';

UPDATE queued_prompts
SET interrupt_operation_id = COALESCE(
      interrupt_operation_id,
      'legacy-interrupt:' || id || ':' || COALESCE(interrupt_target_generation, 'missing')
    )
WHERE interrupt_receipt IS NOT NULL
  AND interrupt_operation_id IS NULL;
