import type { RequestHandler } from 'express';

// Operator limits. Bot owners cannot override these process-level bounds.
export const serverLimits = {
  httpConcurrent: 64, httpPerSecond: 100,
  queued: 1000, queuedPerBot: 100, queuedPerOwner: 200, queuedPerVisitor: 5, managerReserve: 100,
  outbox: 5000, visitorPerMinute: 30, ownerPerMinute: 120,
} as const;

export function httpAdmission(): RequestHandler {
  let active = 0, tokens: number = serverLimits.httpPerSecond, previous = performance.now();
  return (_request, response, next) => {
    const now = performance.now();
    tokens = Math.min(serverLimits.httpPerSecond, tokens + (now - previous) * serverLimits.httpPerSecond / 1000);
    previous = now;
    if (active >= serverLimits.httpConcurrent || tokens < 1) {
      response.set('Retry-After', '2').status(503).json({ error: { code: 'server_busy', message: 'Server capacity is full. Try again later.' } });
      return;
    }
    tokens--; active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    response.once('finish', release); response.once('close', release);
    next();
  };
}
