import { QueryError } from './errors.js';

// Shared by every query service in this application process.
export class QueryLimits {
  private active = 0;
  private outstanding = 0;

  constructor(private readonly concurrency = 3, private readonly maxOutstanding = 6) {}

  enter() {
    if (this.active >= this.concurrency || this.outstanding >= this.maxOutstanding) {
      throw new QueryError(429, 'query_concurrency_exceeded', 'Query capacity is full. Try again later.');
    }
    this.active++;
    return () => { this.active--; };
  }

  async track<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.outstanding >= this.maxOutstanding) {
      throw new QueryError(429, 'query_concurrency_exceeded', 'Query capacity is full. Try again later.');
    }
    this.outstanding++;
    const operation = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    });
    // Keep counting work that ignores cancellation until it actually settles.
    void operation.then(() => { this.outstanding--; }, () => { this.outstanding--; });
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void operation.then(
        value => { signal.removeEventListener('abort', abort); resolve(value); },
        error => { signal.removeEventListener('abort', abort); reject(error); },
      );
    });
  }
}

export const queryLimits = new QueryLimits();
