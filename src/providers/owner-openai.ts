import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { QueryError } from '../queries/errors.js';
import { OpenAIEmbedder, IngestionError } from '../ingestion/embeddings.js';
import { OpenAIImageRecognizer } from '../ingestion/image-recognition.js';
import { OpenAIAnswerer } from '../queries/answerer.js';
import { decryptToken, encryptToken } from '../telegram/client.js';
import { spendingTransport, type SpendingContext } from './spending.js';

export interface OwnerCredentials {
  available(owner: string): Promise<boolean>;
  stored(owner: string): Promise<boolean>;
  validate(key: string, owner?: string): Promise<void>;
  save(owner: string, key: string): Promise<void>;
  remove(owner: string): Promise<void>;
}

export class OwnerOpenAI implements OwnerCredentials {
  private readonly encryptionKey: Buffer;
  constructor(
    private readonly pool: Pool,
    masterKey: Buffer,
    private readonly defaultKey?: string,
    private readonly model = 'text-embedding-3-small',
    private readonly dimensions = 1536,
    private readonly request: typeof fetch = fetch,
  ) {
    // Separate encryption domains even though the deployment uses one master secret.
    this.encryptionKey = createHmac('sha256', masterKey).update('say-ai/owner-openai-keys/v1').digest();
  }

  async available(owner: string) {
    return Boolean((await this.pool.query('SELECT 1 FROM owner_openai_keys WHERE owner_id = $1 AND valid', [owner])).rowCount);
  }

  async stored(owner: string) {
    return Boolean((await this.pool.query('SELECT 1 FROM owner_openai_keys WHERE owner_id = $1', [owner])).rowCount);
  }

  async save(owner: string, key: string) {
    await this.pool.query(`
      INSERT INTO owner_openai_keys (owner_id, ciphertext) VALUES ($1, $2)
      ON CONFLICT (owner_id) DO UPDATE SET ciphertext = $2, revision = gen_random_uuid(), valid = true, updated_at = now()
    `, [owner, encryptToken(key, this.encryptionKey)]);
  }

  async remove(owner: string) {
    await this.pool.query('DELETE FROM owner_openai_keys WHERE owner_id = $1', [owner]);
  }

  async providers(owner: string, model = this.model, dimensions = this.dimensions, context: SpendingContext = { purpose: 'answers' }) {
    let key: string;
    let request = this.request;
    if (owner.startsWith('telegram:')) {
      const row = (await this.pool.query<{ ciphertext: string; revision: string }>(
        'SELECT ciphertext, revision FROM owner_openai_keys WHERE owner_id = $1 AND valid', [owner],
      )).rows[0];
      if (!row) throw new QueryError(503, 'openai_key_required', 'Connect your OpenAI API key in the manager to continue.');
      key = decryptToken(row.ciphertext, this.encryptionKey);
      request = async (input, options) => {
        const response = await this.request(input, options);
        if (response.status === 401 || response.status === 403) {
          // A failed in-flight request must not invalidate a replacement key.
          await this.pool.query('UPDATE owner_openai_keys SET valid = false WHERE owner_id = $1 AND revision = $2', [owner, row.revision]);
        }
        return response;
      };
      request = spendingTransport(this.pool, request, owner, context);
    } else {
      if (!this.defaultKey) throw new QueryError(503, 'querying_unavailable', 'Question answering is not configured.');
      key = this.defaultKey;
    }
    return { embedder: new OpenAIEmbedder(key, model, dimensions, request), answerer: new OpenAIAnswerer(key, request), imageRecognizer: new OpenAIImageRecognizer(key, request) };
  }

  async imageRecognizer(owner: string, knowledgeBaseId?: string) {
    return (await this.providers(owner, this.model, this.dimensions, { purpose: 'ingestion', knowledgeBaseId })).imageRecognizer;
  }

  async ingestionEmbedder(owner: string, model = this.model, dimensions = this.dimensions, knowledgeBaseId?: string) {
    try { return (await this.providers(owner, model, dimensions, { purpose: 'ingestion', knowledgeBaseId })).embedder; }
    catch (error) {
      if (error instanceof QueryError) throw new IngestionError('owner_key_unavailable', 'Connect a valid OpenAI API key and submit the content again.', false);
      throw error;
    }
  }

  async validate(key: string, owner?: string) {
    if (!/^sk-[A-Za-z0-9_-]{16,512}$/.test(key)) throw new QueryError(400, 'invalid_openai_key', 'Enter a valid OpenAI API key.');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const request = owner ? spendingTransport(this.pool, this.request, owner, { purpose: 'key_check' }) : this.request;
    const checkedRequest: typeof fetch = async (input, options) => {
      let response: Response;
      try { response = await request(input, { ...options, signal }); }
      catch { throw new QueryError(503, 'key_check_unavailable', 'OpenAI could not be reached. Try again shortly.'); }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new QueryError(400, 'invalid_openai_key', 'OpenAI rejected this key. Check it and try again.');
        if (response.status === 403 || response.status === 404) throw new QueryError(400, 'key_permissions', 'This key needs access to embeddings and the answering model.');
        if (response.status === 429) throw new QueryError(429, 'key_quota', 'OpenAI reports a quota or rate limit. Check API billing and try again later.');
        throw new QueryError(503, 'key_check_unavailable', 'OpenAI could not validate this key. Try again shortly.');
      }
      return response;
    };
    try {
      // Verify both required capabilities; never log or store provider response bodies.
      const embedding = await checkedRequest('https://api.openai.com/v1/embeddings', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, dimensions: this.dimensions, input: 'Connection check.', encoding_format: 'float' }),
      });
      const embedded = await embedding.json() as { data?: { embedding?: number[] }[] };
      if (!embedded.data?.[0]?.embedding?.length) throw new QueryError(503, 'key_check_unavailable', 'OpenAI could not validate this key. Try again shortly.');
      const response = await checkedRequest('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-6-luna', service_tier: 'default', reasoning: { effort: 'none' }, input: 'Reply OK.', max_output_tokens: 16, store: false }),
      });
      const body = await response.json() as { status?: string };
      if (body.status !== 'completed') throw new QueryError(503, 'key_check_unavailable', 'OpenAI could not validate this key. Try again shortly.');
    } catch (error) {
      if (error instanceof QueryError) throw error;
      throw new QueryError(503, 'key_check_unavailable', 'OpenAI could not validate this key. Try again shortly.');
    } finally { controller.abort(); }
  }
}
