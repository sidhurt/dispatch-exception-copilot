// /sim: plays the physical world and the other departments. docs/SPEC.md §5.5.
// Seeds, evals, the demo and chaos drills use it. The copilot never does.
import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app';
import { chaosConfigSchema } from '../chaos';
import { customers, documentEvents, documentLocks, postingPeriods } from '../db/schema';
import { billDelivery, createDelivery, pickDelivery } from '../domain/deliveries';
import { notFound, validationFailed } from '../domain/errors';
import { createSalesOrder, releaseCredit } from '../domain/salesOrders';
import { recordShipmentEvent } from '../domain/shipments';
import { logEvent, nextNumber } from '../domain/support';
import { serialize } from '../odata/entitySets';
import { readFixtures, resetErp } from './fixtures';

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    throw validationFailed(
      'Request body is invalid.',
      r.error.issues.map((i) => ({ code: 'VALIDATION_FAILED', target: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

const by = (req: FastifyRequest) => {
  const h = req.headers['x-user'];
  return typeof h === 'string' && h.trim() ? h.trim() : 'SIM';
};
const param = (req: FastifyRequest, name: string) => (req.params as Record<string, string>)[name]!;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const qty = z.number().positive();

const schemas = {
  reset: z.object({ fixtures: z.array(z.string()).optional(), state: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional() }).strict(),
  salesOrder: z
    .object({
      salesOrderId: z.string().optional(),
      customerId: z.string(),
      plantId: z.string(),
      orderValue: z.number().positive(),
      currency: z.string().optional(),
      requestedDate: isoDate,
      items: z.array(z.object({ itemNo: z.int(), materialId: z.string(), quantityT: qty }).strict()).min(1),
    })
    .strict(),
  delivery: z
    .object({
      deliveryId: z.string().optional(),
      salesOrderId: z.string(),
      notes: z.string().optional(),
      items: z
        .array(
          z
            .object({ itemNo: z.int(), materialId: z.string(), slocId: z.string(), batchId: z.string().nullable().optional(), plannedQtyT: qty })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  pick: z.object({ batches: z.record(z.string(), z.string()).optional() }).strict(),
  shipmentEvent: z
    .object({ type: z.enum(['GATE_IN', 'TARE', 'LOADING', 'GROSS', 'CHECK_OUT', 'COMPLETE']), weightT: z.number().optional() })
    .strict(),
  lock: z
    .object({ documentType: z.enum(['OutboundDelivery', 'SalesOrder', 'Shipment']), documentId: z.string(), lockedBy: z.string().min(1) })
    .strict(),
  customer: z
    .object({ creditStatus: z.enum(['OK', 'BLOCKED']).optional(), creditLimit: z.number().nonnegative().optional(), creditExposure: z.number().nonnegative().optional() })
    .strict(),
  period: z.object({ status: z.enum(['OPEN', 'CLOSED']) }).strict(),
};

export function registerSim(app: FastifyInstance, { db, chaos }: Ctx) {
  app.post('/sim/reset', async (req) => {
    const body = parse(schemas.reset, req.body);
    const state = body.state ?? (await readFixtures(body.fixtures ?? ['base']));
    chaos.clear();
    await resetErp(db, state);
    return { reset: true, loaded: Object.fromEntries(Object.entries(state).map(([k, rows]) => [k, rows.length])) };
  });

  // ---------- chaos ----------
  app.get('/sim/chaos', async () => ({ rules: chaos.describe() }));
  app.put('/sim/chaos', async (req) => {
    chaos.set(parse(chaosConfigSchema, req.body).rules);
    return { rules: chaos.describe() };
  });
  app.delete('/sim/chaos', async () => {
    chaos.clear();
    return { rules: [] };
  });

  // ---------- orders, deliveries, the gate and weighbridge ----------
  app.post('/sim/salesorders', async (req) => {
    const body = parse(schemas.salesOrder, req.body);
    return serialize(await db.transaction((tx) => createSalesOrder(tx, body, by(req))));
  });

  app.post('/sim/salesorders/:id/release-credit', async (req) =>
    serialize(await db.transaction((tx) => releaseCredit(tx, param(req, 'id'), by(req)))),
  );

  app.post('/sim/deliveries', async (req) => {
    const body = parse(schemas.delivery, req.body);
    return serialize(await db.transaction((tx) => createDelivery(tx, body, by(req))));
  });

  app.post('/sim/deliveries/:id/pick', async (req) => {
    const body = parse(schemas.pick, req.body);
    return serialize(await db.transaction((tx) => pickDelivery(tx, param(req, 'id'), body.batches ?? {}, by(req))));
  });

  app.post('/sim/deliveries/:id/bill', async (req) =>
    serialize(await db.transaction((tx) => billDelivery(tx, param(req, 'id'), by(req)))),
  );

  app.post('/sim/shipments/:id/events', async (req) => {
    const body = parse(schemas.shipmentEvent, req.body);
    return serialize(await db.transaction((tx) => recordShipmentEvent(tx, param(req, 'id'), body, by(req))));
  });

  // ---------- locks, credit, posting periods ----------
  app.post('/sim/locks', async (req) => {
    const body = parse(schemas.lock, req.body);
    return db.transaction(async (tx) => {
      const lockId = String(await nextNumber(tx, 'lock'));
      const [lock] = await tx.insert(documentLocks).values({ ...body, lockId, lockedAt: new Date() }).returning();
      await logEvent(tx, { documentType: body.documentType, documentId: body.documentId, eventType: 'LOCKED', by: body.lockedBy, details: { lockId } });
      return lock!;
    });
  });

  app.delete('/sim/locks/:lockId', async (req) => {
    const [lock] = await db.delete(documentLocks).where(eq(documentLocks.lockId, param(req, 'lockId'))).returning();
    if (!lock) throw notFound(`Lock ${param(req, 'lockId')}`);
    await logEvent(db, { documentType: lock.documentType, documentId: lock.documentId, eventType: 'UNLOCKED', by: lock.lockedBy, details: { lockId: lock.lockId } });
    return { deleted: lock.lockId };
  });

  app.patch('/sim/customers/:id', async (req) => {
    const body = parse(schemas.customer, req.body);
    return db.transaction(async (tx) => {
      const c = await tx.query.customers.findFirst({ where: eq(customers.customerId, param(req, 'id')) });
      if (!c) throw notFound(`Customer ${param(req, 'id')}`);
      const [updated] = await tx
        .update(customers)
        .set({ ...body, version: c.version + 1 })
        .where(eq(customers.customerId, c.customerId))
        .returning();
      await logEvent(tx, { documentType: 'Customer', documentId: c.customerId, eventType: 'CREDIT_CHANGED', by: by(req), details: body });
      return serialize(updated!);
    });
  });

  app.put('/sim/posting-periods/:year/:month', async (req) => {
    const { status } = parse(schemas.period, req.body);
    const year = Number(param(req, 'year'));
    const month = Number(param(req, 'month'));
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw validationFailed('Bad year or month.');
    const [period] = await db
      .insert(postingPeriods)
      .values({ year, month, status })
      .onConflictDoUpdate({ target: [postingPeriods.year, postingPeriods.month], set: { status } })
      .returning();
    await logEvent(db, { documentType: 'PostingPeriod', documentId: `${year}-${String(month).padStart(2, '0')}`, eventType: `PERIOD_${status}`, by: by(req) });
    return period;
  });

  // ---------- full history, including chaos (for diagnosing after a drill) ----------
  app.get('/sim/events', async (req) => {
    const q = req.query as { documentId?: string; documentType?: string };
    const conditions: SQL[] = [];
    if (q.documentId) conditions.push(eq(documentEvents.documentId, q.documentId));
    if (q.documentType) conditions.push(eq(documentEvents.documentType, q.documentType));
    const rows = await db.select().from(documentEvents).where(and(...conditions)).orderBy(asc(documentEvents.eventId));
    return { value: rows.map(serialize) };
  });
}
