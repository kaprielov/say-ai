import type { Pool, PoolClient } from 'pg';
import { countTokens } from '../ingestion/chunking.js';
import { QueryError } from '../queries/errors.js';
import type { ContextChunk } from '../queries/answerer.js';

type Database = Pool | PoolClient;
export type ListingSelection = { botId: string; externalId: string; userId: number };
export type ListingCard = { external_id: string; title: string; price_rub: number; is_test: boolean };

export async function catalogCards(db: Database, botId: string, owner: string, page = 0) {
  return (await db.query<ListingCard>(`
    SELECT external_id,title,price_rub,is_test FROM listings
    WHERE bot_id=$1 AND owner_id=$2 AND external_id ~ '^[A-Za-z0-9_-]{1,48}$'
    ORDER BY external_id LIMIT 6 OFFSET $3
  `, [botId, owner, page * 5])).rows;
}

export async function listingEvidence(db: Database, owner: string, kb: string, selection: ListingSelection): Promise<ContextChunk> {
  const row = (await db.query(`
    SELECT l.external_id,l.title,l.source_url,l.price_rub,l.details,l.reference_size_charts,l.is_test,
      (SELECT coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb) FROM (
        SELECT color,size,stock,stock_is_synthetic,measurements_cm
        FROM listing_variants WHERE bot_id=l.bot_id AND external_id=l.external_id
        ORDER BY color,size LIMIT 51
      ) v) AS variants
    FROM listings l
    JOIN telegram_bots b ON b.id=l.bot_id AND b.owner_id=l.owner_id
    JOIN telegram_listing_selections s ON s.bot_id=l.bot_id AND s.owner_id=l.owner_id AND s.external_id=l.external_id
    WHERE l.bot_id=$1 AND l.owner_id=$2 AND l.external_id=$3 AND s.user_id=$4
      AND b.enabled AND b.knowledge_base_id=$5
  `, [selection.botId, owner, selection.externalId, selection.userId, kb])).rows[0];
  if (!row) throw new QueryError(404, 'listing_unavailable', 'This listing is unavailable. Choose another product with /start.');
  const text = JSON.stringify({ evidence_type: 'selected_listing', ...row, measurement_units: 'cm',
    measurement_basis: 'half_waist and half_hips are flat garment half measurements, not body circumferences',
    stock_read_at: new Date().toISOString() });
  if (row.variants.length > 50 || countTokens(text) > 3000) {
    throw new QueryError(503, 'listing_context_too_large', 'The listing is too large to answer safely.');
  }
  return { id: `catalog:${selection.botId}:${selection.externalId}`, text };
}
