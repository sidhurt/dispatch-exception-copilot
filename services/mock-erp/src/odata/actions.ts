// The only ways to change ERP data from outside: five actions. docs/SPEC.md §5.4.
// Every action runs the same checks in the same order (§5.7):
//   (0 outage: app hook) → 1 body → 2 If-Match present → 3 record exists → 4 version matches
//   → 5 locks (stored, then chaos) → 6 the action's own guards → 7 commit (then maybe drop the reply)
import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActionName } from '../chaos';
import { adjustQuantity, postGoodsIssue, reverseGoodsIssue } from '../domain/deliveries';
import { ErpError, notFound, validationFailed } from '../domain/errors';
import { requestCreditRelease } from '../domain/salesOrders';
import { assignTruck } from '../domain/shipments';
import { logEvent, type DocumentType } from '../domain/support';
import { documentLocks } from '../db/schema';
import type { Ctx } from '../app';
import { columnsOf, etagOf, parseEtag, serialize, setDef, type SetName } from './entitySets';
import { parseKey } from './query';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const clientReference = z.string().min(1).max(64);

type ActionDef = {
  set: SetName;
  documentType: Extract<DocumentType, 'OutboundDelivery' | 'SalesOrder' | 'Shipment'>;
  body: z.ZodType;
  run: (tx: any, row: any, body: any, by: string) => Promise<Record<string, unknown>>;
};

const ACTIONS: Record<ActionName, ActionDef> = {
  AssignTruck: {
    set: 'Shipments',
    documentType: 'Shipment',
    body: z.object({ truckId: z.string().min(1) }).strict(),
    run: assignTruck,
  },
  AdjustQuantity: {
    set: 'OutboundDeliveries',
    documentType: 'OutboundDelivery',
    body: z.object({ itemNo: z.int(), newQuantityT: z.number() }).strict(),
    run: adjustQuantity,
  },
  PostGoodsIssue: {
    set: 'OutboundDeliveries',
    documentType: 'OutboundDelivery',
    body: z.object({ postingDate: isoDate, clientReference: clientReference.optional() }).strict(),
    run: postGoodsIssue,
  },
  ReverseGoodsIssue: {
    set: 'OutboundDeliveries',
    documentType: 'OutboundDelivery',
    body: z
      .object({ goodsMovementId: z.string().min(1), postingDate: isoDate, reason: z.string().min(1), clientReference: clientReference.optional() })
      .strict(),
    run: reverseGoodsIssue,
  },
  RequestCreditRelease: {
    set: 'SalesOrders',
    documentType: 'SalesOrder',
    body: z.object({ reason: z.string().min(1) }).strict(),
    run: requestCreditRelease,
  },
};

const isAction = (name: string): name is ActionName => Object.hasOwn(ACTIONS, name);

export async function runAction(
  { db, chaos }: Ctx,
  set: SetName,
  rawKey: string,
  actionName: string,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  if (!isAction(actionName) || ACTIONS[actionName].set !== set) throw notFound(`Action ${set}/${actionName}`);
  const action = ACTIONS[actionName];
  const def = setDef(set);
  const keyName = def.keys[0]!;
  const keyColumn = columnsOf(set)[keyName]!;
  const documentId = String(parseKey(rawKey, def.keys)[keyName]);
  const userHeader = req.headers['x-user'];
  const by = typeof userHeader === 'string' && userHeader.trim() ? userHeader.trim() : null;
  let chaosLockFired = false;

  try {
    // 1. body
    if (!by) throw validationFailed('Writes need an X-User header naming the approving user.');
    const parsed = action.body.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw validationFailed(
        'Request body is invalid.',
        parsed.error.issues.map((i) => ({ code: 'VALIDATION_FAILED', target: i.path.join('.'), message: i.message })),
      );
    }
    // 2. If-Match present
    const ifMatch = req.headers['if-match'];
    if (!ifMatch) throw new ErpError(428, 'ETAG_REQUIRED', 'Send If-Match with the ETag of the version you read.');

    const result = await db.transaction(async (tx) => {
      // 3. record exists (and hold it so nobody else changes it mid-action)
      const [row] = await tx.select().from(def.table).where(eq(keyColumn, documentId)).for('update');
      if (!row) throw notFound(`${set}('${documentId}')`);

      // 4. version matches
      const current = (row as { version: number }).version;
      if (parseEtag(ifMatch) !== current) {
        throw new ErpError(412, 'ETAG_MISMATCH', `${set}('${documentId}') has changed since you read it. Read it again.`);
      }

      // 5. locks: a person holding the document first, then a passing lock from chaos
      const lock = await tx.query.documentLocks.findFirst({
        where: and(eq(documentLocks.documentType, action.documentType), eq(documentLocks.documentId, documentId)),
      });
      if (lock) {
        throw new ErpError(423, 'DOCUMENT_LOCKED', `${documentId} is locked by ${lock.lockedBy}.`, [
          { code: 'DOCUMENT_LOCKED', lockedBy: lock.lockedBy, lockedAt: lock.lockedAt.toISOString() },
        ]);
      }
      if (chaos.take('lock_conflict', actionName)) {
        chaosLockFired = true;
        throw new ErpError(423, 'DOCUMENT_LOCKED', `${documentId} is locked by SYSTEM_BATCH_JOB.`, [
          { code: 'DOCUMENT_LOCKED', lockedBy: 'SYSTEM_BATCH_JOB' },
        ]);
      }

      // 6 + 7. the action's own guards, then the write
      const body = await action.run(tx, row, parsed.data, by);
      await logEvent(tx, { documentType: action.documentType, documentId, eventType: 'WRITE_ACCEPTED', by, details: { action: actionName } });
      const [after] = await tx.select().from(def.table).where(eq(keyColumn, documentId));
      return { body, version: (after as { version: number }).version };
    });

    // 7b. timeout after commit: the write is saved, but the caller never hears about it.
    if (chaos.take('timeout_after_commit', actionName)) {
      await logEvent(db, {
        documentType: action.documentType,
        documentId,
        eventType: 'CHAOS_INJECTED',
        by: 'CHAOS',
        details: { kind: 'timeout_after_commit', action: actionName },
      });
      reply.hijack();
      req.raw.socket.destroy();
      return reply;
    }

    const out = Object.fromEntries(
      Object.entries(result.body).map(([k, v]) => [k, v && typeof v === 'object' ? serialize(v as Record<string, unknown>) : v]),
    );
    return reply.header('ETag', etagOf(result.version)).send(out);
  } catch (e) {
    if (!(e instanceof ErpError)) throw e;
    if (chaosLockFired) {
      await logEvent(db, {
        documentType: action.documentType,
        documentId,
        eventType: 'CHAOS_INJECTED',
        by: 'CHAOS',
        details: { kind: 'lock_conflict', action: actionName },
      });
    }
    await logEvent(db, {
      documentType: action.documentType,
      documentId,
      eventType: 'WRITE_REJECTED',
      by: by ?? 'UNKNOWN',
      details: { action: actionName, httpStatus: e.status, code: e.code, message: e.message },
    });
    return reply.code(e.status).send(e.toBody());
  }
}
