import express from 'express';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
