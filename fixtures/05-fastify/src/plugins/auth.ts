import fp from 'fastify-plugin';

export const authPlugin = fp(async (app) => {
  app.decorateRequest('user', null);
});
