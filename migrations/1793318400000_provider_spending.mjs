export function up(pgm) {
  pgm.sql(`
    CREATE TABLE provider_spending (
      id bigserial PRIMARY KEY,
      owner_id text NOT NULL,
      bot_id bigint,
      knowledge_base_id uuid,
      purpose text NOT NULL CHECK (purpose IN ('answers', 'testing', 'ingestion', 'key_check')),
      endpoint text NOT NULL CHECK (endpoint IN ('responses', 'embeddings')),
      model text NOT NULL,
      input_tokens bigint CHECK (input_tokens >= 0),
      output_tokens bigint CHECK (output_tokens >= 0),
      cached_tokens bigint CHECK (cached_tokens >= 0),
      cache_write_tokens bigint CHECK (cache_write_tokens >= 0),
      cache_write_30m_tokens bigint CHECK (cache_write_30m_tokens >= 0),
      cache_write_12h_tokens bigint CHECK (cache_write_12h_tokens >= 0),
      reasoning_tokens bigint CHECK (reasoning_tokens >= 0),
      estimated_usd numeric(24,12) CHECK (estimated_usd >= 0),
      rates jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX provider_spending_owner_time ON provider_spending (owner_id, created_at);
    COMMENT ON TABLE provider_spending IS 'Independent API-attempt ledger. No credentials or content. Null cost means unknown; retained after bot or knowledge-base deletion.';
  `);
}

export function down(pgm) {
  pgm.sql('DROP TABLE provider_spending');
}
