// Small helpers shared by all documents: the history log, number ranges, rounding.
import { eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { counters, documentEvents } from '../db/schema';

type Conn = Db | Tx;

export type DocumentType =
  | 'SalesOrder'
  | 'OutboundDelivery'
  | 'Shipment'
  | 'Customer'
  | 'Truck'
  | 'PostingPeriod'
  | 'System';

export async function logEvent(
  conn: Conn,
  e: {
    documentType: DocumentType;
    documentId: string;
    eventType: string;
    by: string;
    details?: Record<string, unknown>;
  },
) {
  await conn.insert(documentEvents).values({ ...e, details: e.details ?? {}, at: new Date() });
}

export async function logStatusChange(
  conn: Conn,
  documentType: DocumentType,
  documentId: string,
  from: string | null,
  to: string,
  by: string,
) {
  await logEvent(conn, { documentType, documentId, eventType: 'STATUS_CHANGED', by, details: { from, to } });
}

// Number ranges. Starting points sit above anything the fixtures use.
export const NUMBER_RANGES = {
  salesOrder: 10000500,
  delivery: 80500,
  shipment: 50500,
  goodsMovement: 4900000500,
  billingDocument: 90000500,
  weighment: 1,
  lock: 1,
  creditRelease: 1,
} as const;
export type NumberRange = keyof typeof NUMBER_RANGES;

export async function nextNumber(conn: Conn, range: NumberRange): Promise<number> {
  const [row] = await conn
    .update(counters)
    .set({ nextValue: sql`${counters.nextValue} + 1` })
    .where(eq(counters.name, range))
    .returning({ value: sql<number>`${counters.nextValue} - 1` });
  if (!row) throw new Error(`Number range ${range} is missing; was the ERP reset?`);
  return Number(row.value);
}

// Quantities are tonnes with 3 decimals. Round after arithmetic so 29.62 stays 29.62.
export const round3 = (n: number) => Math.round(n * 1000) / 1000;
