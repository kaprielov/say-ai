import type { Pool, PoolClient } from 'pg';

export type SpendingContext = {
  purpose: 'answers' | 'testing' | 'ingestion' | 'key_check';
  botId?: string;
  knowledgeBaseId?: string;
};

type Usage = {
  input_tokens?: unknown; prompt_tokens?: unknown; total_tokens?: unknown; output_tokens?: unknown;
  input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown;
    cache_write_tokens_details?: { ttl_30m_tokens?: unknown; ttl_12h_tokens?: unknown } };
  output_tokens_details?: { reasoning_tokens?: unknown };
};
type ProviderBody = { model?: unknown; usage?: Usage; service_tier?: unknown };
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

// Standard global API rates, USD per million tokens. Keep historical estimates immutable.
// Source: https://developers.openai.com/api/docs/pricing (verified 2026-10-25).
const rateVersion = 'openai-2026-10-25';
const embeddingRates: Record<string, number> = { 'text-embedding-3-small': 0.02, 'text-embedding-3-large': 0.13 };

export function priceUsage(endpoint: 'embeddings' | 'responses', requestedModel: string, body: ProviderBody) {
  const model = typeof body.model === 'string' ? body.model : requestedModel;
  const usage = body.usage;
  const input = count(endpoint === 'embeddings' ? usage?.prompt_tokens ?? usage?.total_tokens : usage?.input_tokens);
  const output = endpoint === 'embeddings' ? 0 : count(usage?.output_tokens);
  const details = usage?.input_tokens_details;
  const cached = endpoint === 'embeddings' ? 0 : count(details?.cached_tokens);
  const writes = endpoint === 'embeddings' ? 0 : count(details?.cache_write_tokens);
  const shortWrites = count(details?.cache_write_tokens_details?.ttl_30m_tokens) ?? (writes === 0 ? 0 : null);
  const longWrites = count(details?.cache_write_tokens_details?.ttl_12h_tokens) ?? (writes === 0 ? 0 : null);
  const reasoning = count(usage?.output_tokens_details?.reasoning_tokens);
  let cost: number | null = null;
  let rates: Record<string, string | number> | null = null;
  if (input !== null && output !== null && endpoint === 'embeddings' && Object.hasOwn(embeddingRates, model)) {
    rates = { version: rateVersion, input: embeddingRates[model]! };
    cost = input * embeddingRates[model]! / 1_000_000;
  }
  if (endpoint === 'responses' && /^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(model) &&
      input !== null && input <= 272_000 && output !== null && cached !== null && writes !== null && cached + writes <= input &&
      (body.service_tier === undefined || body.service_tier === 'default')) {
    if (shortWrites !== null && longWrites !== null && shortWrites + longWrites === writes) {
      rates = { version: rateVersion, input: 0.10, cached: 0.01, write30m: 0.125, write12h: 0.25, output: 0.50 };
      // Reasoning tokens are already included in output_tokens.
      cost = ((input - cached - writes) * 0.10 + cached * 0.01 + shortWrites * 0.125 + longWrites * 0.25 + output * 0.50) / 1_000_000;
    }
  }
  return { model, input, output, cached, writes, shortWrites, longWrites, reasoning, cost: cost === null ? null : cost.toFixed(12), rates };
}

export function spendingTransport(pool: Pool, request: typeof fetch, owner: string, context: SpendingContext): typeof fetch {
  return async (input, options) => {
    const endpoint = String(input).endsWith('/embeddings') ? 'embeddings' : 'responses';
    const requestedModel = (JSON.parse(String(options?.body)) as { model: string }).model;
    // Commit an unknown attempt before sending. A timeout/crash or failed final write cannot become a false zero.
    // Use the pool rather than the caller's transaction: paid calls survive downstream rollbacks.
    const row = await pool.query<{ id: string }>(`
      INSERT INTO provider_spending (owner_id, bot_id, knowledge_base_id, purpose, endpoint, model)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
    `, [owner, context.botId ?? null, context.knowledgeBaseId ?? null, context.purpose, endpoint, requestedModel]);
    const response = await request(input, options);
    let body: ProviderBody;
    try { body = await response.clone().json() as ProviderBody; }
    catch { return response; }
    const priced = priceUsage(endpoint, requestedModel, body ?? {});
    try {
      await pool.query(`
        UPDATE provider_spending SET model=$2,input_tokens=$3,output_tokens=$4,cached_tokens=$5,
          cache_write_tokens=$6,reasoning_tokens=$7,estimated_usd=$8,rates=$9,
          cache_write_30m_tokens=$10,cache_write_12h_tokens=$11 WHERE id=$1
      `, [row.rows[0]!.id, priced.model, priced.input, priced.output, priced.cached, priced.writes, priced.reasoning, priced.cost, priced.rates, priced.shortWrites, priced.longWrites]);
    } catch {
      console.error('Unable to finalize API spending; the attempt remains unknown.');
    }
    return response;
  };
}

export type SpendingPeriod = 'today' | 'week' | 'month';
export async function spendingSummary(db: PoolClient, owner: string, period: SpendingPeriod, page: number) {
  const start = period === 'today' ? "date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
    : period === 'week' ? "now() - interval '7 days'" : "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
  const summary = (await db.query<{ purpose: SpendingContext['purpose']; usd: string; unknown: number; calls: number }>(`
    SELECT purpose, COALESCE(sum(estimated_usd),0)::text AS usd,
      count(*) FILTER (WHERE estimated_usd IS NULL)::int AS unknown, count(*)::int AS calls
    FROM provider_spending WHERE owner_id=$1 AND created_at >= ${start} GROUP BY purpose
  `, [owner])).rows;
  const bots = (await db.query<{ bot_id: string; username: string | null; usd: string; unknown: number }>(`
    SELECT s.bot_id, b.username, COALESCE(sum(s.estimated_usd),0)::text AS usd,
      count(*) FILTER (WHERE s.estimated_usd IS NULL)::int AS unknown
    FROM provider_spending s LEFT JOIN telegram_bots b ON b.id=s.bot_id AND b.owner_id=s.owner_id
    WHERE s.owner_id=$1 AND s.created_at >= ${start} AND s.bot_id IS NOT NULL AND s.purpose='answers'
    GROUP BY s.bot_id,b.username ORDER BY sum(s.estimated_usd) DESC NULLS LAST,s.bot_id
    LIMIT 6 OFFSET $2
  `, [owner, page * 5])).rows;
  return { summary, bots: bots.slice(0, 5), more: bots.length > 5 };
}

export function spendingAmount(value: number | string) {
  const amount = Number(value);
  return amount > 0 && amount < 0.0001 ? '<$0.0001' : `$${amount.toFixed(4)}`;
}
