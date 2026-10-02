// Load a full starting state into the ERP. docs/SPEC.md §10.4.
// A fixture is a JSON file: { "plants": [...], "customers": [...], "outboundDeliveries": [...], ... }
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client';
import * as t from '../db/schema';
import { validationFailed } from '../domain/errors';
import { NUMBER_RANGES } from '../domain/support';

const FIXTURE_TABLES: Record<string, PgTable> = {
  plants: t.plants,
  storageLocations: t.storageLocations,
  materials: t.materials,
  batches: t.batches,
  customers: t.customers,
  carriers: t.carriers,
  trucks: t.trucks,
  stocks: t.stocks,
  postingPeriods: t.postingPeriods,
  salesOrders: t.salesOrders,
  outboundDeliveries: t.outboundDeliveries,
  shipments: t.shipments,
  weighmentEvents: t.weighmentEvents,
  goodsMovements: t.goodsMovements,
  billingDocuments: t.billingDocuments,
  documentLocks: t.documentLocks,
};

const ALL_TABLES: PgTable[] = [
  ...Object.values(FIXTURE_TABLES),
  t.documentEvents,
  t.creditReleaseRequests,
  t.counters,
];

// After loading, each number range must start above the highest number the fixture used.
const NUMBERED: Array<[keyof typeof NUMBER_RANGES, string, string]> = [
  ['salesOrder', 'sales_orders', 'sales_order_id'],
  ['delivery', 'outbound_deliveries', 'delivery_id'],
  ['shipment', 'shipments', 'shipment_id'],
  ['goodsMovement', 'goods_movements', 'goods_movement_id'],
  ['billingDocument', 'billing_documents', 'billing_document_id'],
  ['weighment', 'weighment_events', 'weighment_id'],
  ['lock', 'document_locks', 'lock_id'],
];

export type FixtureState = Record<string, Record<string, unknown>[]>;

const fixturesDir = fileURLToPath(new URL('../../fixtures/', import.meta.url));

export async function readFixtures(names: string[]): Promise<FixtureState> {
  const merged: FixtureState = {};
  for (const name of names) {
    if (!/^[\w-]+$/.test(name)) throw validationFailed(`Bad fixture name "${name}".`);
    let state: FixtureState;
    try {
      state = JSON.parse(await readFile(`${fixturesDir}${name}.json`, 'utf8'));
    } catch {
      throw validationFailed(`Fixture "${name}" not found or not valid JSON.`);
    }
    for (const [key, rows] of Object.entries(state)) merged[key] = [...(merged[key] ?? []), ...rows];
  }
  return merged;
}

// JSON has no dates; turn "...At" strings back into Date objects for timestamp columns.
const reviveDates = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, /At$|^at$/.test(k) && typeof v === 'string' ? new Date(v) : v]),
  );

/** Wipe everything and load this state. */
export async function resetErp(db: Db, state: FixtureState) {
  const unknown = Object.keys(state).filter((k) => !(k in FIXTURE_TABLES));
  if (unknown.length) throw validationFailed(`Unknown fixture keys: ${unknown.join(', ')}.`);

  await db.transaction(async (tx) => {
    const names = ALL_TABLES.map((table) => `"${getTableName(table)}"`).join(', ');
    await tx.execute(sql.raw(`TRUNCATE ${names} RESTART IDENTITY`));
    await tx
      .insert(t.counters)
      .values(Object.entries(NUMBER_RANGES).map(([name, nextValue]) => ({ name, nextValue })));

    for (const [key, table] of Object.entries(FIXTURE_TABLES)) {
      const rows = state[key];
      if (rows?.length) await tx.insert(table).values(rows.map(reviveDates) as never);
    }

    for (const [range, table, column] of NUMBERED) {
      await tx.execute(sql`
        UPDATE counters SET next_value = GREATEST(next_value, COALESCE(
          (SELECT MAX(${sql.identifier(column)}::bigint) FROM ${sql.identifier(table)}
           WHERE ${sql.identifier(column)} ~ '^[0-9]+$'), 0) + 1)
        WHERE name = ${range}`);
    }
  });
}
