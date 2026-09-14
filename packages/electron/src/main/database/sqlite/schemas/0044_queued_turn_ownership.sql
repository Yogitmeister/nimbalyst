-- Durable identity for one queued dispatch. `host_dispatch_id` is local
-- provenance only; provider_thread_id/provider_turn_id come from Codex
-- turn/start and are the only identities recovery is allowed to reconcile.

ALTER TABLE queued_prompts ADD COLUMN attention_generation TEXT;
ALTER TABLE queued_prompts ADD COLUMN host_dispatch_id TEXT;
ALTER TABLE queued_prompts ADD COLUMN provider_thread_id TEXT;
ALTER TABLE queued_prompts ADD COLUMN provider_turn_id TEXT;
ALTER TABLE queued_prompts ADD COLUMN provider_turn_attached_at TEXT;
ALTER TABLE queued_prompts ADD COLUMN provider_turn_state TEXT NOT NULL DEFAULT 'unbound'
  CHECK (provider_turn_state IN ('unbound', 'active', 'completed', 'failed', 'interrupted', 'uncertain'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_queued_prompts_provider_turn
  ON queued_prompts(provider_thread_id, provider_turn_id)
  WHERE provider_thread_id IS NOT NULL AND provider_turn_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_queued_prompts_active_turn_owner
  ON queued_prompts(session_id, status, attention_generation, provider_turn_state)
  WHERE status = 'executing';
