import { countTokens } from '../ingestion/chunking.js';
import type { ContextChunk } from './answerer.js';

export type PositionedChunk = ContextChunk & { position: number };
export const contextConfig = { candidates: 8, seeds: 3, maxTokens: 3000, neighborTokens: 1000 } as const;

export function selectContext(matches: PositionedChunk[], neighbors: PositionedChunk[]): ContextChunk[] {
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
    if (nextTokens > contextConfig.maxTokens ||
        (isNeighbor && neighborTokens + additionalTokens > contextConfig.neighborTokens)) return;
    context.push(candidate);
    included.add(chunk.id);
    tokens = nextTokens;
    if (isNeighbor) neighborTokens += additionalTokens;
  };

  const seeds = matches.slice(0, contextConfig.seeds);
  // Preserve coverage of the strongest matches before spending tokens on their surroundings.
  seeds.forEach(seed => add(seed));
  for (const seed of seeds) {
    if (!included.has(seed.id)) continue;
    add(byPosition.get(seed.position + 1), true);
    add(byPosition.get(seed.position - 1), true);
  }
  // Fill unused space with remaining ranked matches. Overlapping windows share IDs.
  matches.slice(contextConfig.seeds).forEach(match => add(match));
  return context;
}
