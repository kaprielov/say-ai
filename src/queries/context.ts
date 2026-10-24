import { countTokens } from '../ingestion/chunking.js';
import type { ContextChunk } from './answerer.js';

export type PositionedChunk = ContextChunk & { position: number };
export type ContextConfig = { candidates: number; seeds: number; maxTokens: number; neighborTokens: number };
export const retrievalProfiles: Record<string, ContextConfig> = {
  focused: { candidates: 4, seeds: 2, maxTokens: 1500, neighborTokens: 0 },
  expanded: { candidates: 12, seeds: 4, maxTokens: 4500, neighborTokens: 1500 },
};
export const contextConfig = { candidates: 8, seeds: 3, maxTokens: 3000, neighborTokens: 1000 } as const;

export function selectContext(matches: PositionedChunk[], neighbors: PositionedChunk[], config: ContextConfig = contextConfig): ContextChunk[] {
  const context: ContextChunk[] = [];
  const included = new Set<string>();
  let tokens = countTokens(JSON.stringify(context));
  let neighborTokens = 0;
  const byPosition = new Map([...matches, ...neighbors].map(chunk => [chunk.position, chunk]));
  const add = (chunk: PositionedChunk | undefined, isNeighbor = false) => {
    if (!chunk || included.has(chunk.id)) return;
    const candidate = { id: chunk.id, text: chunk.text };
    const nextTokens = countTokens(JSON.stringify([...context, candidate]));
    const additionalTokens = nextTokens - tokens;
    if (nextTokens > config.maxTokens ||
        (isNeighbor && neighborTokens + additionalTokens > config.neighborTokens)) return;
    context.push(candidate);
    included.add(chunk.id);
    tokens = nextTokens;
    if (isNeighbor) neighborTokens += additionalTokens;
  };

  const seeds = matches.slice(0, config.seeds);
  // Preserve coverage of the strongest matches before spending tokens on their surroundings.
  seeds.forEach(seed => add(seed));
  for (const seed of seeds) {
    if (!included.has(seed.id)) continue;
    add(byPosition.get(seed.position + 1), true);
    add(byPosition.get(seed.position - 1), true);
  }
  // Fill unused space with remaining ranked matches. Overlapping windows share IDs.
  matches.slice(config.seeds).forEach(match => add(match));
  return context;
}
