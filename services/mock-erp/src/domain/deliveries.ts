// Outbound deliveries: picking, weighment tolerance, quantity changes, goods issue (601),
// reversal (602) and billing. docs/SPEC.md §4.2.
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  billingDocuments,
  customers,
  goodsMovements,
  outboundDeliveries,
  plants,
  postingPeriods,
  salesOrders,
  shipments,
  stocks,
  type DeliveryItem,
  type MovementItem,
} from '../db/schema';
import { ErpError, invalidState, notFound, validationFailed, type ErrorDetail } from './errors';
import { completeIfAllBilled } from './salesOrders';
import { logEvent, logStatusChange, nextNumber, round3 } from './support';

type Delivery = typeof outboundDeliveries.$inferSelect;

const sumPlanned = (items: DeliveryItem[]) => round3(items.reduce((s, i) => s + i.plannedQtyT, 0));

/**
 * The weighbridge check. Net weight must be within the plant's tolerance of the planned
 * quantity. If it is, each item's confirmed quantity is its share of the net weight.
 */
export function weighmentCheck(items: DeliveryItem[], netT: number, tolerancePct: number) {
  const plannedT = sumPlanned(items);
  const allowedT = round3((plannedT * tolerancePct) / 100);
  const within = Math.abs(netT - plannedT) <= allowedT + 1e-9;
  return {
    within,
    plannedT,
    allowedT,
    items: items.map((i) => ({
      ...i,
      confirmedQtyT: within ? round3((i.plannedQtyT * netT) / plannedT) : null,
    })),
  };
}

async function toleranceFor(tx: Tx, plantId: string) {
  const plant = await tx.query.plants.findFirst({ where: eq(plants.plantId, plantId) });
  if (!plant) throw notFound(`Plant ${plantId}`);
  return plant.weighTolerancePct;
}

/** Re-run the weighment check and move the delivery between PICKED and QTY_CONFIRMED. */
export async function applyWeighment(tx: Tx, delivery: Delivery, items: DeliveryItem[], netT: number | null, by: string) {
  if (netT === null || (delivery.status !== 'PICKED' && delivery.status !== 'QTY_CONFIRMED')) {
    return { status: delivery.status, items };
  }
  const check = weighmentCheck(items, netT, await toleranceFor(tx, delivery.plantId));
  const status = check.within ? ('QTY_CONFIRMED' as const) : ('PICKED' as const);
  await logEvent(tx, {
    documentType: 'OutboundDelivery',
    documentId: delivery.deliveryId,
    eventType: 'WEIGHMENT_CHECKED',
    by: 'SYSTEM',
    details: { netT, plannedT: check.plannedT, allowedDifferenceT: check.allowedT, withinTolerance: check.within },
  });
  if (status !== delivery.status) {
    await logStatusChange(tx, 'OutboundDelivery', delivery.deliveryId, delivery.status, status, by);
  }
  return { status, items: check.items };
}

// ---------- simulation side (the physical world) ----------

export async function createDelivery(
  tx: Tx,
  input: {
    deliveryId?: string;
    salesOrderId: string;
    notes?: string;
    items: Array<Omit<DeliveryItem, 'confirmedQtyT' | 'batchId'> & { batchId?: string | null }>;
  },
  by: string,
) {
  const order = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.salesOrderId, input.salesOrderId) });
  if (!order) throw notFound(`Sales order ${input.salesOrderId}`);
  if (order.status !== 'RELEASED' && order.status !== 'DELIVERY_CREATED') {
    throw invalidState(`Sales order ${order.salesOrderId} is ${order.status}; a delivery needs RELEASED.`);
  }

  const deliveryId = input.deliveryId ?? String(await nextNumber(tx, 'delivery'));
  const shipmentId = String(await nextNumber(tx, 'shipment'));
  const [delivery] = await tx
    .insert(outboundDeliveries)
    .values({
      deliveryId,
      salesOrderId: order.salesOrderId,
      customerId: order.customerId,
      plantId: order.plantId,
      shipmentId,
      status: 'CREATED',
      notes: input.notes ?? '',
      items: input.items.map((i) => ({ ...i, batchId: i.batchId ?? null, confirmedQtyT: null })),
      createdAt: new Date(),
    })
    .returning();
  await tx.insert(shipments).values({ shipmentId, deliveryId, status: 'PLANNED' });
  await logStatusChange(tx, 'OutboundDelivery', deliveryId, null, 'CREATED', by);
  await logStatusChange(tx, 'Shipment', shipmentId, null, 'PLANNED', by);

  if (order.status === 'RELEASED') {
    await tx
      .update(salesOrders)
      .set({ status: 'DELIVERY_CREATED', version: order.version + 1 })
      .where(eq(salesOrders.salesOrderId, order.salesOrderId));
    await logStatusChange(tx, 'SalesOrder', order.salesOrderId, 'RELEASED', 'DELIVERY_CREATED', by);
  }
  return delivery!;
}

export async function pickDelivery(tx: Tx, deliveryId: string, batches: Record<string, string>, by: string) {
  const d = await tx.query.outboundDeliveries.findFirst({ where: eq(outboundDeliveries.deliveryId, deliveryId) });
  if (!d) throw notFound(`Delivery ${deliveryId}`);
  if (d.status !== 'CREATED') throw invalidState(`Delivery ${deliveryId} is ${d.status}; picking needs CREATED.`);

  const items = d.items.map((i) => ({ ...i, batchId: batches[String(i.itemNo)] ?? i.batchId }));
  const missing = items.filter((i) => !i.batchId);
  if (missing.length) {
    throw new ErpError(
      409,
      'BATCH_MISSING',
      `Item ${missing[0]!.itemNo} has no batch.`,
      missing.map((i) => ({ code: 'BATCH_MISSING', target: `items[${i.itemNo}]` })),
    );
  }
  const [updated] = await tx
    .update(outboundDeliveries)
    .set({ status: 'PICKED', items, version: d.version + 1 })
    .where(eq(outboundDeliveries.deliveryId, deliveryId))
    .returning();
  await logStatusChange(tx, 'OutboundDelivery', deliveryId, 'CREATED', 'PICKED', by);
  return updated!;
}

export async function billDelivery(tx: Tx, deliveryId: string, by: string) {
  const d = await tx.query.outboundDeliveries.findFirst({ where: eq(outboundDeliveries.deliveryId, deliveryId) });
  if (!d) throw notFound(`Delivery ${deliveryId}`);
  if (d.status !== 'PGI_POSTED') throw invalidState(`Delivery ${deliveryId} is ${d.status}; billing needs PGI_POSTED.`);
  const order = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.salesOrderId, d.salesOrderId) });
  if (!order) throw notFound(`Sales order ${d.salesOrderId}`);

  // Bill the delivered share of the order's value.
  const orderedT = order.items.reduce((s, i) => s + i.quantityT, 0);
  const deliveredT = d.items.reduce((s, i) => s + (i.confirmedQtyT ?? 0), 0);
  const amount = Math.round(((order.orderValue * deliveredT) / orderedT) * 100) / 100;

  const billingDocumentId = String(await nextNumber(tx, 'billingDocument'));
  const now = new Date();
  await tx.insert(billingDocuments).values({ billingDocumentId, deliveryId, amount, currency: order.currency, createdAt: now });
  const [updated] = await tx
    .update(outboundDeliveries)
    .set({ status: 'BILLED', billedAt: now, version: d.version + 1 })
    .where(eq(outboundDeliveries.deliveryId, deliveryId))
    .returning();
  await logEvent(tx, { documentType: 'OutboundDelivery', documentId: deliveryId, eventType: 'BILLED', by, details: { billingDocumentId, amount } });
  await logStatusChange(tx, 'OutboundDelivery', deliveryId, 'PGI_POSTED', 'BILLED', by);
  await completeIfAllBilled(tx, d.salesOrderId);
  return updated!;
}

// ---------- copilot actions (run inside the action pipeline, after version and lock checks) ----------

export async function adjustQuantity(
  tx: Tx,
  d: Delivery,
  body: { itemNo: number; newQuantityT: number },
  by: string,
) {
  if (!['CREATED', 'PICKED', 'QTY_CONFIRMED'].includes(d.status)) {
    throw invalidState(`Delivery ${d.deliveryId} is ${d.status}; quantity can only change before goods issue.`);
  }
  const item = d.items.find((i) => i.itemNo === body.itemNo);
  if (!item) throw validationFailed(`Delivery ${d.deliveryId} has no item ${body.itemNo}.`);
  if (body.newQuantityT <= 0) {
    throw new ErpError(409, 'QTY_OUT_OF_RANGE', 'New quantity must be greater than zero.', [
      { code: 'QTY_OUT_OF_RANGE', target: `items[${body.itemNo}]` },
    ]);
  }

  const newQty = round3(body.newQuantityT);
  const items = d.items.map((i) => (i.itemNo === body.itemNo ? { ...i, plannedQtyT: newQty } : i));
  await logEvent(tx, {
    documentType: 'OutboundDelivery',
    documentId: d.deliveryId,
    eventType: 'QUANTITY_ADJUSTED',
    by,
    details: { itemNo: body.itemNo, fromT: item.plannedQtyT, toT: newQty },
  });

  const shipment = d.shipmentId
    ? await tx.query.shipments.findFirst({ where: eq(shipments.shipmentId, d.shipmentId) })
    : undefined;
  const result = await applyWeighment(tx, d, items, shipment?.netT ?? null, by);

  const [updated] = await tx
    .update(outboundDeliveries)
    .set({ status: result.status, items: result.items, version: d.version + 1 })
    .where(eq(outboundDeliveries.deliveryId, d.deliveryId))
    .returning();
  return { delivery: updated! };
}

function periodOf(postingDate: string) {
  const [year, month] = postingDate.split('-').map(Number);
  return { year: year!, month: month! };
}

async function checkPeriodOpen(tx: Tx, postingDate: string): Promise<ErrorDetail | null> {
  const { year, month } = periodOf(postingDate);
  const period = await tx.query.postingPeriods.findFirst({
    where: and(eq(postingPeriods.year, year), eq(postingPeriods.month, month)),
  });
  if (period?.status === 'OPEN') return null;
  return { code: 'PERIOD_CLOSED', message: `Posting period ${year}-${String(month).padStart(2, '0')} is not open.` };
}

const stockKey = (plantId: string, i: { slocId: string; materialId: string; batchId: string | null }) =>
  and(
    eq(stocks.plantId, plantId),
    eq(stocks.slocId, i.slocId),
    eq(stocks.materialId, i.materialId),
    eq(stocks.batchId, i.batchId ?? ''),
  );

/** Throw one 409 carrying the first failure as its code and all failures as details. */
function throwIfFailed(failures: ErrorDetail[]) {
  if (failures.length) {
    const first = failures[0]!;
    throw new ErpError(409, first.code, first.message ?? first.code, failures);
  }
}

export async function postGoodsIssue(
  tx: Tx,
  d: Delivery,
  body: { postingDate: string; clientReference?: string },
  by: string,
) {
  const failures: ErrorDetail[] = [];

  // 1. status
  if (d.status === 'PGI_POSTED' || d.status === 'BILLED') {
    failures.push({ code: 'ALREADY_POSTED', message: `Delivery ${d.deliveryId} is already ${d.status}.` });
  } else if (d.status !== 'QTY_CONFIRMED' && d.status !== 'REVERSED') {
    failures.push({ code: 'INVALID_STATE', message: `Delivery ${d.deliveryId} is ${d.status}; goods issue needs QTY_CONFIRMED.` });
  }

  // 2. customer stop
  const customer = await tx.query.customers.findFirst({ where: eq(customers.customerId, d.customerId) });
  if (customer?.creditStatus !== 'OK') {
    failures.push({ code: 'CUSTOMER_CREDIT_BLOCKED', message: `Customer ${d.customerId} is on credit stop.` });
  }

  // 3. posting period
  const period = await checkPeriodOpen(tx, body.postingDate);
  if (period) failures.push(period);

  // 4. batches
  for (const i of d.items.filter((i) => !i.batchId)) {
    failures.push({ code: 'BATCH_MISSING', target: `items[${i.itemNo}]`, message: `Item ${i.itemNo} has no batch.` });
  }

  // 5. stock, totalled per storage location + material + batch (two items may share a batch)
  const needed = new Map<string, { item: DeliveryItem; neededT: number }>();
  for (const i of d.items.filter((i) => i.batchId)) {
    const key = `${i.slocId}|${i.materialId}|${i.batchId}`;
    const prev = needed.get(key);
    needed.set(key, { item: prev?.item ?? i, neededT: round3((prev?.neededT ?? 0) + (i.confirmedQtyT ?? i.plannedQtyT)) });
  }
  for (const { item, neededT } of needed.values()) {
    const row = await tx.query.stocks.findFirst({ where: stockKey(d.plantId, item) });
    const haveT = row?.unrestrictedT ?? 0;
    if (haveT < neededT) {
      failures.push({
        code: 'INSUFFICIENT_STOCK',
        target: `items[${item.itemNo}]`,
        message: `Batch ${item.batchId} has ${haveT.toFixed(3)} t unrestricted; ${neededT.toFixed(3)} t needed.`,
      });
    }
  }

  throwIfFailed(failures);

  // All guards passed: take the stock out, write the 601, move the delivery on.
  const movementItems: MovementItem[] = d.items.map((i) => ({
    itemNo: i.itemNo,
    materialId: i.materialId,
    batchId: i.batchId!,
    slocId: i.slocId,
    quantityT: i.confirmedQtyT!,
  }));
  for (const m of movementItems) {
    await tx
      .update(stocks)
      .set({ unrestrictedT: sql`${stocks.unrestrictedT} - ${m.quantityT}` })
      .where(stockKey(d.plantId, m));
  }
  const now = new Date();
  const [movement] = await tx
    .insert(goodsMovements)
    .values({
      goodsMovementId: String(await nextNumber(tx, 'goodsMovement')),
      movementType: '601',
      deliveryId: d.deliveryId,
      plantId: d.plantId,
      reversesGoodsMovementId: null,
      clientReference: body.clientReference ?? null,
      postingDate: body.postingDate,
      postedAt: now,
      postedBy: by,
      items: movementItems,
    })
    .returning();
  const [delivery] = await tx
    .update(outboundDeliveries)
    .set({ status: 'PGI_POSTED', pgiPostedAt: now, version: d.version + 1 })
    .where(eq(outboundDeliveries.deliveryId, d.deliveryId))
    .returning();

  await logEvent(tx, {
    documentType: 'OutboundDelivery',
    documentId: d.deliveryId,
    eventType: 'GOODS_ISSUE_POSTED',
    by,
    details: { goodsMovementId: movement!.goodsMovementId, movementType: '601', clientReference: body.clientReference ?? null },
  });
  await logStatusChange(tx, 'OutboundDelivery', d.deliveryId, d.status, 'PGI_POSTED', by);
  return { delivery: delivery!, goodsMovement: movement! };
}

export async function reverseGoodsIssue(
  tx: Tx,
  d: Delivery,
  body: { goodsMovementId: string; postingDate: string; reason: string; clientReference?: string },
  by: string,
) {
  const failures: ErrorDetail[] = [];

  if (d.status === 'BILLED') {
    failures.push({ code: 'ALREADY_BILLED', message: `Delivery ${d.deliveryId} is billed; its goods issue cannot be reversed.` });
  } else if (d.status !== 'PGI_POSTED') {
    failures.push({ code: 'INVALID_STATE', message: `Delivery ${d.deliveryId} is ${d.status}; nothing to reverse.` });
  }

  const original = await tx.query.goodsMovements.findFirst({
    where: eq(goodsMovements.goodsMovementId, body.goodsMovementId),
  });
  if (!original || original.deliveryId !== d.deliveryId || original.movementType !== '601') {
    failures.push({
      code: 'INVALID_STATE',
      target: 'goodsMovementId',
      message: `${body.goodsMovementId} is not a goods issue (601) of delivery ${d.deliveryId}.`,
    });
  } else {
    const alreadyReversed = await tx.query.goodsMovements.findFirst({
      where: eq(goodsMovements.reversesGoodsMovementId, original.goodsMovementId),
    });
    if (alreadyReversed) {
      failures.push({
        code: 'INVALID_STATE',
        target: 'goodsMovementId',
        message: `${original.goodsMovementId} was already reversed by ${alreadyReversed.goodsMovementId}.`,
      });
    }
  }

  const period = await checkPeriodOpen(tx, body.postingDate);
  if (period) failures.push(period);

  throwIfFailed(failures);

  // Put the stock back and write the 602.
  for (const m of original!.items) {
    await tx
      .update(stocks)
      .set({ unrestrictedT: sql`${stocks.unrestrictedT} + ${m.quantityT}` })
      .where(stockKey(d.plantId, m));
  }
  const [movement] = await tx
    .insert(goodsMovements)
    .values({
      goodsMovementId: String(await nextNumber(tx, 'goodsMovement')),
      movementType: '602',
      deliveryId: d.deliveryId,
      plantId: d.plantId,
      reversesGoodsMovementId: original!.goodsMovementId,
      clientReference: body.clientReference ?? null,
      postingDate: body.postingDate,
      postedAt: new Date(),
      postedBy: by,
      items: original!.items,
    })
    .returning();
  const [delivery] = await tx
    .update(outboundDeliveries)
    .set({ status: 'REVERSED', pgiPostedAt: null, version: d.version + 1 })
    .where(eq(outboundDeliveries.deliveryId, d.deliveryId))
    .returning();

  await logEvent(tx, {
    documentType: 'OutboundDelivery',
    documentId: d.deliveryId,
    eventType: 'GOODS_ISSUE_REVERSED',
    by,
    details: { goodsMovementId: movement!.goodsMovementId, reverses: original!.goodsMovementId, reason: body.reason },
  });
  await logStatusChange(tx, 'OutboundDelivery', d.deliveryId, 'PGI_POSTED', 'REVERSED', by);
  return { delivery: delivery!, goodsMovement: movement! };
}
