// The lists you can read over /odata, and the links between them. docs/SPEC.md §5.1.
import { getTableColumns, ne, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import * as t from '../db/schema';

export const SET_NAMES = [
  'Plants', 'StorageLocations', 'Materials', 'Batches', 'Customers', 'Carriers', 'Trucks', 'Stocks',
  'SalesOrders', 'OutboundDeliveries', 'Shipments', 'WeighmentEvents', 'GoodsMovements',
  'BillingDocuments', 'PostingPeriods', 'DocumentLocks', 'DocumentEvents',
] as const;
export type SetName = (typeof SET_NAMES)[number];

export type NavDef = {
  target: SetName;
  many: boolean;
  from: string; // field on this record
  to: string; // field on the target record
  where?: Record<string, string>; // fixed extra conditions on the target
};

export type SetDef = {
  table: PgTable;
  keys: string[];
  nav?: Record<string, NavDef>;
  /** Rows the copilot must never see through /odata. */
  hidden?: () => SQL;
};

const locksOf = (documentType: string, from: string): NavDef => ({
  target: 'DocumentLocks', many: true, from, to: 'documentId', where: { documentType },
});
const eventsOf = (documentType: string, from: string): NavDef => ({
  target: 'DocumentEvents', many: true, from, to: 'documentId', where: { documentType },
});

export const ENTITY_SETS: Record<SetName, SetDef> = {
  Plants: { table: t.plants, keys: ['plantId'] },
  StorageLocations: { table: t.storageLocations, keys: ['plantId', 'slocId'] },
  Materials: { table: t.materials, keys: ['materialId'] },
  Batches: { table: t.batches, keys: ['batchId'] },
  Customers: { table: t.customers, keys: ['customerId'] },
  Carriers: { table: t.carriers, keys: ['carrierId'] },
  Trucks: {
    table: t.trucks,
    keys: ['truckId'],
    nav: { carrier: { target: 'Carriers', many: false, from: 'carrierId', to: 'carrierId' } },
  },
  Stocks: { table: t.stocks, keys: ['plantId', 'slocId', 'materialId', 'batchId'] },
  SalesOrders: {
    table: t.salesOrders,
    keys: ['salesOrderId'],
    nav: {
      customer: { target: 'Customers', many: false, from: 'customerId', to: 'customerId' },
      deliveries: { target: 'OutboundDeliveries', many: true, from: 'salesOrderId', to: 'salesOrderId' },
      locks: locksOf('SalesOrder', 'salesOrderId'),
      events: eventsOf('SalesOrder', 'salesOrderId'),
    },
  },
  OutboundDeliveries: {
    table: t.outboundDeliveries,
    keys: ['deliveryId'],
    nav: {
      salesOrder: { target: 'SalesOrders', many: false, from: 'salesOrderId', to: 'salesOrderId' },
      customer: { target: 'Customers', many: false, from: 'customerId', to: 'customerId' },
      shipment: { target: 'Shipments', many: false, from: 'deliveryId', to: 'deliveryId' },
      goodsMovements: { target: 'GoodsMovements', many: true, from: 'deliveryId', to: 'deliveryId' },
      billingDocuments: { target: 'BillingDocuments', many: true, from: 'deliveryId', to: 'deliveryId' },
      locks: locksOf('OutboundDelivery', 'deliveryId'),
      events: eventsOf('OutboundDelivery', 'deliveryId'),
    },
  },
  Shipments: {
    table: t.shipments,
    keys: ['shipmentId'],
    nav: {
      delivery: { target: 'OutboundDeliveries', many: false, from: 'deliveryId', to: 'deliveryId' },
      truck: { target: 'Trucks', many: false, from: 'truckId', to: 'truckId' },
      weighments: { target: 'WeighmentEvents', many: true, from: 'shipmentId', to: 'shipmentId' },
      locks: locksOf('Shipment', 'shipmentId'),
      events: eventsOf('Shipment', 'shipmentId'),
    },
  },
  WeighmentEvents: { table: t.weighmentEvents, keys: ['weighmentId'] },
  GoodsMovements: { table: t.goodsMovements, keys: ['goodsMovementId'] },
  BillingDocuments: { table: t.billingDocuments, keys: ['billingDocumentId'] },
  PostingPeriods: { table: t.postingPeriods, keys: ['year', 'month'] },
  DocumentLocks: { table: t.documentLocks, keys: ['lockId'] },
  DocumentEvents: {
    table: t.documentEvents,
    keys: ['eventId'],
    // Chaos injections are for after-the-fact diagnosis (GET /sim/events), not for the copilot.
    hidden: () => ne(t.documentEvents.eventType, 'CHAOS_INJECTED'),
  },
};

export const isSetName = (name: string): name is SetName => Object.hasOwn(ENTITY_SETS, name);
export const setDef = (name: SetName): SetDef => ENTITY_SETS[name];
export const columnsOf = (name: SetName) => getTableColumns(setDef(name).table);

/** A database row as the API shows it: version becomes @odata.etag, ids are strings. */
export function serialize(row: Record<string, unknown>) {
  const { version, ...rest } = row;
  if (typeof rest.eventId === 'number') rest.eventId = String(rest.eventId);
  return version === undefined ? rest : { '@odata.etag': etagOf(version as number), ...rest };
}

export const etagOf = (version: number) => `W/"${version}"`;

/** Read the version number out of an If-Match header. Anything else (including "*") is no match. */
export function parseEtag(header: string): number | null {
  const m = /^(?:W\/)?"(\d+)"$/.exec(header.trim());
  return m ? Number(m[1]) : null;
}
