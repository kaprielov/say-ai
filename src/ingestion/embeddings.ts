export class IngestionError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = true) {
    super(message);
  }
}

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}

export function validateVectors(vectors: number[][], count: number, dimensions: number) {
  if (!Array.isArray(vectors) || vectors.length !== count || vectors.some(vector =>
    !Array.isArray(vector) || vector.length !== dimensions ||
    vector.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 3.4e38) ||
    !vector.some(value => Math.abs(value) >= 1.2e-38))) {
    throw new IngestionError('invalid_embedding_response', 'Embedding provider returned invalid vectors.');
  }
}

export class OpenAIEmbedder implements Embedder {
  constructor(
    private readonly apiKey: string,
    public readonly model: string,
    public readonly dimensions: number,
    private readonly fetchRequest: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async embed(texts: string[], signal: AbortSignal) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const response = await this.fetchRequest('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, dimensions: this.dimensions, input: texts, encoding_format: 'float' }),
        signal: requestSignal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new IngestionError(
          'embedding_provider_error',
          `Embedding provider returned HTTP ${response.status}.`,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      const body = await response.json() as { data?: { index: number; embedding: number[] }[] };
      if (!Array.isArray(body.data) || body.data.length !== texts.length ||
          new Set(body.data.map(item => item?.index)).size !== texts.length ||
          body.data.some(item => !item || !Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length)) {
        throw new IngestionError('invalid_embedding_response', 'Embedding provider returned invalid indices.');
      }
      const vectors = body.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
      validateVectors(vectors, texts.length, this.dimensions);
      return vectors;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof IngestionError) throw error;
      if (requestSignal.aborted) throw new IngestionError('embedding_timeout', 'Embedding request timed out.');
      throw new IngestionError('embedding_request_failed', 'Embedding request failed.');
    }
  }
}
