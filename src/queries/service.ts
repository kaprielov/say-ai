import { hasOnlyEvidenceLinks, topics, type AnswerSafety, type QuestionTopic } from './safety.js';
import { validateBotSettings, type BotAnswerSettings } from '../bots/settings.js';
import { answerRequest } from './answerer.js';
import type { Pool } from 'pg';
import { countTokens } from '../ingestion/chunking.js';
import { validateVectors, type Embedder } from '../ingestion/embeddings.js';
import type { Answerer, ContextChunk, GeneratedAnswer } from './answerer.js';
import { QueryError } from './errors.js';
import { QUERY_DEADLINE_MS, queryLimits, type QueryLimits } from './limits.js';
import { contextConfig, retrievalProfiles, selectContext, type PositionedChunk } from './context.js';

type QueryOptions = {
  pool: Pool;
  embedder: (model: string, dimensions: number) => Embedder;
  answerer: Answerer;
  safety: AnswerSafety;
  providers?: (owner: string, model: string, dimensions: number) => Promise<{ embedder: Embedder; answerer: Answerer; safety: AnswerSafety }>;
  deadlineMs?: number;
  limits?: QueryLimits;
};

const refusal = () => ({ outcome: 'insufficient_context' as const, answer: null, sources: [] });

export class QuestionAnswering {
  constructor(private readonly options: QueryOptions) {}

  async ask(id: string, ownerId: string, question: string, disconnect: AbortSignal, run?: { settings: BotAnswerSettings; revision: string; inspect?: boolean }) {
    const started = performance.now();
    const settings = run ? validateBotSettings(run.settings) : undefined;
    const selectedConfig = retrievalProfiles[settings?.retrieval ?? 'balanced'] ?? contextConfig;
    const { pool, embedder, answerer, safety, deadlineMs = QUERY_DEADLINE_MS, limits = queryLimits } = this.options;
    const release = limits.enter();
    const controller = new AbortController();
    const timeoutError = () => new QueryError(504, 'query_timeout', 'The query exceeded its deadline.');
    const deadline = performance.now() + deadlineMs;
    const timer = setTimeout(() => controller.abort(timeoutError()), deadlineMs);
    const signal = AbortSignal.any([controller.signal, disconnect]);
    const check = () => {
      if (performance.now() >= deadline && !controller.signal.aborted) controller.abort(timeoutError());
      signal.throwIfAborted();
    };
    const call = async <T>(work: () => Promise<T>) => {
      check();
      const value = await limits.track(work, signal);
      check();
      return value;
    };
    try {
      if (countTokens(question) > 1024) {
        throw new QueryError(400, 'question_too_long', 'question must not exceed 4096 characters or 1024 tokens.');
      }
      check();
      const metadata = await call(() => pool.query<{
        version_id: string | null; embedding_model: string; embedding_dimensions: number;
      }>(`
        SELECT v.id AS version_id, v.embedding_model, v.embedding_dimensions
        FROM knowledge_bases kb
        LEFT JOIN content_versions v ON v.id = kb.active_version_id
          AND v.knowledge_base_id = kb.id AND v.status = 'ready'
        WHERE kb.id = $1 AND kb.owner_id = $2
      `, [id, ownerId]));
      const version = metadata.rows[0];
      if (!version) throw new QueryError(404, 'not_found', 'Knowledge base not found.');
      if (!version.version_id) throw new QueryError(409, 'knowledge_base_not_ready', 'No ready version is available for queries.');
      const maxDimensions = version.embedding_model === 'text-embedding-3-small' ? 1536
        : version.embedding_model === 'text-embedding-3-large' ? 3072 : 0;
      if (version.embedding_dimensions < 1 || version.embedding_dimensions > maxDimensions) {
        throw new QueryError(503, 'embedding_configuration_unavailable', 'The active version uses an unsupported embedding configuration.');
      }
      const providers = this.options.providers
        ? await call(() => this.options.providers!(ownerId, version.embedding_model, version.embedding_dimensions))
        : { embedder: embedder(version.embedding_model, version.embedding_dimensions), answerer, safety };
      const vectors = await call(() => providers.embedder.embed([question], signal));
      validateVectors(vectors, 1, version.embedding_dimensions);
      const matches = await call(() => pool.query<PositionedChunk>(`
        SELECT c.id, c.text, c.position
        FROM chunks c JOIN content_versions v ON v.id = c.version_id
        WHERE c.version_id = $2 AND v.knowledge_base_id = $3
        ORDER BY c.embedding <=> $1::vector, c.position LIMIT $4
      `, [JSON.stringify(vectors[0]), version.version_id, id, selectedConfig.candidates]));
      const positions = [...new Set(matches.rows.slice(0, selectedConfig.seeds)
        .flatMap(match => [match.position + 1, match.position - 1]).filter(position => position >= 0))];
      const neighbors = positions.length ? await call(() => pool.query<PositionedChunk>(`
        SELECT c.id, c.text, c.position
        FROM chunks c JOIN content_versions v ON v.id = c.version_id
        WHERE c.version_id = $1 AND v.knowledge_base_id = $2 AND c.position = ANY($3::int[])
        ORDER BY c.position
      `, [version.version_id, id, positions])) : { rows: [] };
      const context = selectContext(matches.rows, neighbors.rows, selectedConfig);
      check();
      let topic: QuestionTopic = 'uncertain';
      let review: 'not_generated' | 'not_required' | 'blocked_links' | 'rejected' | 'supported' = 'not_generated';
      let result: ReturnType<QuestionAnswering['validateAnswer']> = refusal();
      if (context.length) {
        if (!providers.safety?.classify || !providers.safety.review) throw new QueryError(503, 'safety_unavailable', 'Answer safety checks are not configured.');
        topic = await call(() => providers.safety.classify(question, context, signal));
        if (!topics.includes(topic)) throw new QueryError(502, 'safety_check_failed', 'The answer safety check could not be completed.');
        const generated = await call(() => providers.answerer.answer(question, context, signal, settings));
        const candidate = this.validateAnswer(generated, context);
        review = 'not_required';
        // The generator cannot turn an unrelated question into an unmoderated factual answer.
        if (candidate.outcome !== 'insufficient_context' && !(topic === 'off_topic' && candidate.outcome === 'answered')) {
          const evidence = context.filter(chunk => generated.chunk_ids.includes(chunk.id));
          if (!hasOnlyEvidenceLinks(candidate.answer!, evidence)) review = 'blocked_links';
          else {
            const supported = await call(() => providers.safety.review(question, evidence, generated, signal));
            if (typeof supported !== 'boolean') throw new QueryError(502, 'safety_check_failed', 'The answer safety check could not be completed.');
            review = supported ? 'supported' : 'rejected';
            if (supported) result = candidate;
          }
        }
      }
      return { ...result, ...(topic === 'off_topic' ? { topic: 'off_topic' as const } : {}), ...(run?.inspect ? { debug: {
        revision: run.revision, contentVersion: version.version_id, context,
        request: context.length ? answerRequest(question, context, settings) : null,
        safety: { topic, review }, elapsedMs: Math.round(performance.now() - started),
      } } : {}) };
    } catch (error) {
      check();
      if (error instanceof QueryError) throw error;
      throw new QueryError(502, 'query_processing_failed', 'The query could not be completed.');
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  private validateAnswer(result: GeneratedAnswer, context: ContextChunk[]) {
    if (!result || !Array.isArray(result.chunk_ids) || result.chunk_ids.some(id => typeof id !== 'string')) {
      throw new QueryError(502, 'invalid_answer_response', 'The answering provider returned an invalid response.');
    }
    if (result.outcome === 'insufficient_context' && result.answer === null && result.chunk_ids.length === 0) return refusal();
    if (!['answered', 'redirected'].includes(result.outcome) || typeof result.answer !== 'string' || !result.answer.trim() ||
        !result.chunk_ids.length || result.chunk_ids.some(id => !context.some(chunk => chunk.id === id))) {
      throw new QueryError(502, 'invalid_answer_response', 'The answering provider returned an unsupported answer.');
    }
    if (result.outcome === 'redirected' && [...result.answer].length > 280) {
      throw new QueryError(502, 'invalid_answer_response', 'The answering provider returned an oversized redirection.');
    }
    return {
      outcome: result.outcome as 'answered' | 'redirected', answer: result.answer,
      sources: [...new Set(result.chunk_ids)].map(id => ({ chunk_id: id, text: context.find(chunk => chunk.id === id)!.text })),
    };
  }
}
