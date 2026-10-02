// Sales orders and credit. docs/SPEC.md §4.1.
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  creditReleaseRequests,
  customers,
  outboundDeliveries,
  salesOrders,
  type SalesOrderItem,
} from '../db/schema';
import { invalidState, notFound } from './errors';
import { logEvent, logStatusChange, nextNumber } from './support';

type SalesOrder = typeof salesOrders.$inferSelect;
type Customer = typeof customers.$inferSelect;

/** The automatic check when an order is created. Returns the reason it fails, or null. */
export function creditCheck(customer: Customer, orderValue: number): string | null {
  if (customer.creditStatus === 'BLOCKED') return 'Customer is on credit stop.';
  if (customer.creditExposure + orderValue > customer.creditLimit) {
    return `Exposure ${customer.creditExposure} + order ${orderValue} exceeds limit ${customer.creditLimit}.`;
  }
  return null;
}

export async function createSalesOrder(
  tx: Tx,
  input: {
    salesOrderId?: string;
    customerId: string;
    plantId: string;
    orderValue: number;
    currency?: string;
    requestedDate: string;
    items: SalesOrderItem[];
  },
  by: string,
) {
  const customer = await tx.query.customers.findFirst({ where: eq(customers.customerId, input.customerId) });
  if (!customer) throw notFound(`Customer ${input.customerId}`);

  const salesOrderId = input.salesOrderId ?? String(await nextNumber(tx, 'salesOrder'));
  const blockReason = creditCheck(customer, input.orderValue);
  const status = blockReason ? 'CREDIT_BLOCKED' : 'RELEASED';

  const [order] = await tx
    .insert(salesOrders)
    .values({
      salesOrderId,
      customerId: input.customerId,
      plantId: input.plantId,
      status,
      orderValue: input.orderValue,
      currency: input.currency ?? customer.currency,
      requestedDate: input.requestedDate,
      items: input.items,
      createdAt: new Date(),
    })
    .returning();

  await logStatusChange(tx, 'SalesOrder', salesOrderId, null, 'CREATED', by);
  await logEvent(tx, {
    documentType: 'SalesOrder',
    documentId: salesOrderId,
    eventType: 'CREDIT_CHECK',
    by: 'SYSTEM',
    details: { passed: !blockReason, reason: blockReason },
  });
  await logStatusChange(tx, 'SalesOrder', salesOrderId, 'CREATED', status, 'SYSTEM');
  return order!;
}

/** Finance releases one blocked order. Does not lift a customer stop. */
export async function releaseCredit(tx: Tx, salesOrderId: string, by: string) {
  const order = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.salesOrderId, salesOrderId) });
  if (!order) throw notFound(`Sales order ${salesOrderId}`);
  if (order.status !== 'CREDIT_BLOCKED') throw invalidState(`Sales order ${salesOrderId} is ${order.status}, not CREDIT_BLOCKED.`);

  const [updated] = await tx
    .update(salesOrders)
    .set({ status: 'RELEASED', version: order.version + 1 })
    .where(eq(salesOrders.salesOrderId, salesOrderId))
    .returning();
  await logStatusChange(tx, 'SalesOrder', salesOrderId, 'CREDIT_BLOCKED', 'RELEASED', by);
  return updated!;
}

/** Copilot action: ask finance to release credit. It records a request; it never releases anything. */
export async function requestCreditRelease(tx: Tx, order: SalesOrder, body: { reason: string }, by: string) {
  const customer = await tx.query.customers.findFirst({ where: eq(customers.customerId, order.customerId) });
  if (order.status !== 'CREDIT_BLOCKED' && customer?.creditStatus !== 'BLOCKED') {
    throw invalidState(`Nothing to release: order ${order.salesOrderId} is ${order.status} and the customer is not on credit stop.`);
  }

  const requestId = `CRR-${String(await nextNumber(tx, 'creditRelease')).padStart(4, '0')}`;
  await tx.insert(creditReleaseRequests).values({
    requestId,
    salesOrderId: order.salesOrderId,
    reason: body.reason,
    requestedBy: by,
    status: 'REQUESTED',
    createdAt: new Date(),
  });
  await logEvent(tx, {
    documentType: 'SalesOrder',
    documentId: order.salesOrderId,
    eventType: 'CREDIT_RELEASE_REQUESTED',
    by,
    details: { requestId, reason: body.reason },
  });
  return { requestId, status: 'REQUESTED' as const };
}

/** An order is COMPLETED once every one of its deliveries is billed. */
export async function completeIfAllBilled(tx: Tx, salesOrderId: string) {
  const deliveries = await tx.query.outboundDeliveries.findMany({
    where: eq(outboundDeliveries.salesOrderId, salesOrderId),
  });
  if (deliveries.length === 0 || deliveries.some((d) => d.status !== 'BILLED')) return;

  const order = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.salesOrderId, salesOrderId) });
  if (!order || order.status === 'COMPLETED') return;
  await tx
    .update(salesOrders)
    .set({ status: 'COMPLETED', version: order.version + 1 })
    .where(eq(salesOrders.salesOrderId, salesOrderId));
  await logStatusChange(tx, 'SalesOrder', salesOrderId, order.status, 'COMPLETED', 'SYSTEM');
}
