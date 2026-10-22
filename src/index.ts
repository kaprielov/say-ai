import { createApp } from './app.js';
import { config, readAuthConfig } from './config.js';
import { pool } from './db.js';

const app = createApp({ pool, ...readAuthConfig() });

const server = app.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      void pool.end();
    });
  });
}
