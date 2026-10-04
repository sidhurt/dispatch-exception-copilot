// Mock ERP tables. One table per entity in docs/SPEC.md §3.
// Column names are snake_case in Postgres; Drizzle maps them to camelCase in code.
// Item lists (order items, delivery items, movement items) are stored as JSON on their
// parent document: nothing ever queries an item on its own.
import {
  bigint,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const tonnes = () => numeric({ precision: 12, scale: 3, mode: 'number' });
const money = () => numeric({ precision: 14, scale: 2, mode: 'number' });
const at = () => timestamp({ withTimezone: true, mode: 'date' });
const day = () => date({ mode: 'string' });
// Optimistic-locking version, exposed to clients as the ETag W/"<version>".
const version = () => integer().notNull().default(1);

export type SalesOrderItem = { itemNo: number; materialId: string; quantityT: number };
export type DeliveryItem = {
  itemNo: number;
  materialId: string;
  slocId: string;
  batchId: string | null;
  plannedQtyT: number;
  confirmedQtyT: number | null;
};
export type MovementItem = {
  itemNo: number;
  materialId: string;
  batchId: string;
  slocId: string;
  quantityT: number;
};

// ---------- master data ----------

export const plants = pgTable('plants', {
  plantId: text().primaryKey(),
  name: text().notNull(),
  weighTolerancePct: numeric({ precision: 5, scale: 2, mode: 'number' }).notNull(),
});

export const storageLocations = pgTable(
  'storage_locations',
  { plantId: text().notNull(), slocId: text().notNull(), name: text().notNull() },
  (t) => [primaryKey({ columns: [t.plantId, t.slocId] })],
);

export const materials = pgTable('materials', {
  materialId: text().primaryKey(),
  description: text().notNull(),
  packaging: text().$type<'BAG' | 'BULK'>().notNull(),
});

export const batches = pgTable('batches', {
  batchId: text().primaryKey(),
  materialId: text().notNull(),
  plantId: text().notNull(),
  producedOn: day().notNull(),
});

export const customers = pgTable('customers', {
  customerId: text().primaryKey(),
  name: text().notNull(),
  creditLimit: money().notNull(),
  creditExposure: money().notNull(),
  creditStatus: text().$type<'OK' | 'BLOCKED'>().notNull(),
  currency: text().notNull(),
  version: version(),
});

export const carriers = pgTable('carriers', {
  carrierId: text().primaryKey(),
  name: text().notNull(),
  remarks: text().notNull().default(''),
});

export const trucks = pgTable('trucks', {
  truckId: text().primaryKey(),
  carrierId: text().notNull(),
  registrationNo: text().notNull(),
  capacityT: tonnes().notNull(),
  status: text().$type<'AVAILABLE' | 'ASSIGNED' | 'OUT_OF_SERVICE'>().notNull(),
  version: version(),
});

export const stocks = pgTable(
  'stocks',
  {
    plantId: text().notNull(),
    slocId: text().notNull(),
    materialId: text().notNull(),
    batchId: text().notNull(),
    unrestrictedT: tonnes().notNull(),
    blockedT: tonnes().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.plantId, t.slocId, t.materialId, t.batchId] })],
);

// ---------- documents ----------

export const salesOrders = pgTable('sales_orders', {
  salesOrderId: text().primaryKey(),
  customerId: text().notNull(),
  plantId: text().notNull(),
  status: text()
    .$type<'CREATED' | 'CREDIT_BLOCKED' | 'RELEASED' | 'DELIVERY_CREATED' | 'COMPLETED'>()
    .notNull(),
  orderValue: money().notNull(),
  currency: text().notNull(),
  requestedDate: day().notNull(),
  items: jsonb().$type<SalesOrderItem[]>().notNull(),
  createdAt: at().notNull(),
  version: version(),
});

export const outboundDeliveries = pgTable('outbound_deliveries', {
  deliveryId: text().primaryKey(),
  salesOrderId: text().notNull(),
  customerId: text().notNull(),
  plantId: text().notNull(),
  shipmentId: text(),
  status: text()
    .$type<'CREATED' | 'PICKED' | 'QTY_CONFIRMED' | 'PGI_POSTED' | 'BILLED' | 'REVERSED'>()
    .notNull(),
  notes: text().notNull().default(''),
  items: jsonb().$type<DeliveryItem[]>().notNull(),
  createdAt: at().notNull(),
  pgiPostedAt: at(),
  billedAt: at(),
  version: version(),
});

export const shipments = pgTable('shipments', {
  shipmentId: text().primaryKey(),
  deliveryId: text().notNull(),
  truckId: text(),
  status: text()
    .$type<
      | 'PLANNED'
      | 'TRUCK_ASSIGNED'
      | 'GATE_IN'
      | 'TARE_DONE'
      | 'LOADING'
      | 'GROSS_DONE'
      | 'CHECKED_OUT'
      | 'COMPLETED'
    >()
    .notNull(),
  tareT: tonnes(),
  grossT: tonnes(),
  netT: tonnes(),
  version: version(),
});

export const weighmentEvents = pgTable('weighment_events', {
  weighmentId: text().primaryKey(),
  shipmentId: text().notNull(),
  kind: text().$type<'TARE' | 'GROSS'>().notNull(),
  weightT: tonnes().notNull(),
  recordedAt: at().notNull(),
});

export const goodsMovements = pgTable('goods_movements', {
  goodsMovementId: text().primaryKey(),
  movementType: text().$type<'601' | '602'>().notNull(),
  deliveryId: text().notNull(),
  plantId: text().notNull(),
  reversesGoodsMovementId: text(),
  // Label the caller attached to the write (e.g. a proposal id), so it can find its own posting later.
  // The ERP only stores it; it does not reject repeats. (ADR-004)
  clientReference: text(),
  postingDate: day().notNull(),
  postedAt: at().notNull(),
  postedBy: text().notNull(),
  items: jsonb().$type<MovementItem[]>().notNull(),
});

export const billingDocuments = pgTable('billing_documents', {
  billingDocumentId: text().primaryKey(),
  deliveryId: text().notNull(),
  amount: money().notNull(),
  currency: text().notNull(),
  createdAt: at().notNull(),
});

// ---------- control data ----------

export const postingPeriods = pgTable(
  'posting_periods',
  {
    year: integer().notNull(),
    month: integer().notNull(),
    status: text().$type<'OPEN' | 'CLOSED'>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.year, t.month] })],
);

export const documentLocks = pgTable('document_locks', {
  lockId: text().primaryKey(),
  documentType: text().$type<'OutboundDelivery' | 'SalesOrder' | 'Shipment'>().notNull(),
  documentId: text().notNull(),
  lockedBy: text().notNull(),
  lockedAt: at().notNull(),
});

// The ERP's own history: every status change, every write (accepted or rejected),
// every chaos injection. Chaos events are hidden from /odata reads.
export const documentEvents = pgTable('document_events', {
  eventId: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  documentType: text().notNull(),
  documentId: text().notNull(),
  eventType: text().notNull(),
  at: at().notNull(),
  by: text().notNull(),
  details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
});

// Not an OData entity: requests show up to the copilot as events on the sales order.
export const creditReleaseRequests = pgTable('credit_release_requests', {
  requestId: text().primaryKey(),
  salesOrderId: text().notNull(),
  reason: text().notNull(),
  requestedBy: text().notNull(),
  status: text().$type<'REQUESTED'>().notNull(),
  createdAt: at().notNull(),
});

// Number ranges for new documents (next delivery number, next goods movement number, ...).
export const counters = pgTable('counters', {
  name: text().primaryKey(),
  nextValue: bigint({ mode: 'number' }).notNull(),
});
