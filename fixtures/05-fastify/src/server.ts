import app from './app';

await app.listen({ port: Number(process.env.PORT ?? 3000) });
