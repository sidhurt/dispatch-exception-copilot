// Builds the mock ERP web service: /odata for the copilot, /sim for everything else.
import Fastify from 'fastify';
import { Chaos } from './chaos';
import type { Db } from './db/client';
import { ErpError } from './domain/errors';
import { logEvent } from './domain/support';
import { registerOData } from './odata/routes';
import { registerSim } from './sim/routes';

export type Ctx = { db: Db; chaos: Chaos };

export function buildApp(db: Db, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false });
  const ctx: Ctx = { db, chaos: new Chaos() };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ErpError) return reply.code(err.status).send(err.toBody());
    // Fastify's own 400s, e.g. a body that isn't valid JSON.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send(new ErpError(status, 'VALIDATION_FAILED', (err as Error).message).toBody());
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'The mock ERP hit an unexpected error.', details: [] } });
  });

  // Step 0 of every /odata call: is there an outage right now? Reads are hit too.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/odata')) return;
    const retryAfter = ctx.chaos.outageRetryAfter();
    if (retryAfter === null) return;
    await logEvent(db, {
      documentType: 'System',
      documentId: '-',
      eventType: 'CHAOS_INJECTED',
      by: 'CHAOS',
      details: { kind: 'outage', method: req.method, url: req.url },
    });
    return reply
      .code(503)
      .header('Retry-After', String(retryAfter))
      .send(new ErpError(503, 'SERVICE_UNAVAILABLE', 'The ERP is unavailable. Try again later.').toBody());
  });

  app.get('/health', async () => ({ ok: true }));
  registerOData(app, ctx);
  registerSim(app, ctx);
  return app;
}
