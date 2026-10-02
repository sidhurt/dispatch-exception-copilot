// Shipments (one truck trip) and the weighbridge. docs/SPEC.md §4.3.
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { outboundDeliveries, shipments, trucks, weighmentEvents } from '../db/schema';
import { ErpError, invalidState, notFound, validationFailed } from './errors';
import { applyWeighment } from './deliveries';
import { logEvent, logStatusChange, nextNumber, round3 } from './support';

type Shipment = typeof shipments.$inferSelect;
type ShipmentStatus = Shipment['status'];

/** Copilot action: put a truck on a planned shipment. */
export async function assignTruck(tx: Tx, s: Shipment, body: { truckId: string }, by: string) {
  if (s.status !== 'PLANNED') throw invalidState(`Shipment ${s.shipmentId} is ${s.status}; a truck can only be assigned while PLANNED.`);

  const truck = await tx.query.trucks.findFirst({ where: eq(trucks.truckId, body.truckId) });
  if (!truck) throw new ErpError(409, 'TRUCK_UNAVAILABLE', `Truck ${body.truckId} does not exist.`);
  if (truck.status !== 'AVAILABLE') throw new ErpError(409, 'TRUCK_UNAVAILABLE', `Truck ${truck.truckId} is ${truck.status}.`);

  const delivery = await tx.query.outboundDeliveries.findFirst({ where: eq(outboundDeliveries.deliveryId, s.deliveryId) });
  const loadT = round3((delivery?.items ?? []).reduce((sum, i) => sum + i.plannedQtyT, 0));
  if (truck.capacityT < loadT) {
    throw new ErpError(409, 'TRUCK_OVER_CAPACITY', `Truck ${truck.truckId} carries ${truck.capacityT} t; the delivery is ${loadT} t.`);
  }

  await tx.update(trucks).set({ status: 'ASSIGNED', version: truck.version + 1 }).where(eq(trucks.truckId, truck.truckId));
  const [shipment] = await tx
    .update(shipments)
    .set({ status: 'TRUCK_ASSIGNED', truckId: truck.truckId, version: s.version + 1 })
    .where(eq(shipments.shipmentId, s.shipmentId))
    .returning();
  await logEvent(tx, { documentType: 'Shipment', documentId: s.shipmentId, eventType: 'TRUCK_ASSIGNED', by, details: { truckId: truck.truckId } });
  await logStatusChange(tx, 'Shipment', s.shipmentId, 'PLANNED', 'TRUCK_ASSIGNED', by);
  return { shipment: shipment! };
}

export type ShipmentEvent = 'GATE_IN' | 'TARE' | 'LOADING' | 'GROSS' | 'CHECK_OUT' | 'COMPLETE';

// Which status each physical event needs, and where it leads.
const MOVES: Record<ShipmentEvent, { from: ShipmentStatus; to: ShipmentStatus }> = {
  GATE_IN: { from: 'TRUCK_ASSIGNED', to: 'GATE_IN' },
  TARE: { from: 'GATE_IN', to: 'TARE_DONE' },
  LOADING: { from: 'TARE_DONE', to: 'LOADING' },
  GROSS: { from: 'LOADING', to: 'GROSS_DONE' },
  CHECK_OUT: { from: 'GROSS_DONE', to: 'CHECKED_OUT' },
  COMPLETE: { from: 'CHECKED_OUT', to: 'COMPLETED' },
};

/** Simulation: something happened at the gate or on the weighbridge. */
export async function recordShipmentEvent(
  tx: Tx,
  shipmentId: string,
  event: { type: ShipmentEvent; weightT?: number },
  by: string,
) {
  const s = await tx.query.shipments.findFirst({ where: eq(shipments.shipmentId, shipmentId) });
  if (!s) throw notFound(`Shipment ${shipmentId}`);
  const move = MOVES[event.type];
  if (s.status !== move.from) throw invalidState(`Shipment ${shipmentId} is ${s.status}; ${event.type} needs ${move.from}.`);

  const delivery = await tx.query.outboundDeliveries.findFirst({ where: eq(outboundDeliveries.deliveryId, s.deliveryId) });
  if (!delivery) throw notFound(`Delivery ${s.deliveryId}`);
  const patch: Partial<Shipment> = { status: move.to, version: s.version + 1 };

  if (event.type === 'TARE' || event.type === 'GROSS') {
    if (event.weightT === undefined || event.weightT <= 0) throw validationFailed(`${event.type} needs a positive weightT.`);
    await tx.insert(weighmentEvents).values({
      weighmentId: String(await nextNumber(tx, 'weighment')),
      shipmentId,
      kind: event.type,
      weightT: event.weightT,
      recordedAt: new Date(),
    });
    if (event.type === 'TARE') patch.tareT = event.weightT;
    else {
      if (event.weightT <= (s.tareT ?? 0)) throw validationFailed('Gross weight must be more than tare weight.');
      patch.grossT = event.weightT;
      patch.netT = round3(event.weightT - (s.tareT ?? 0));
    }
  }
  if (event.type === 'LOADING' && delivery.status !== 'PICKED') {
    throw invalidState(`Delivery ${delivery.deliveryId} is ${delivery.status}; loading needs PICKED.`);
  }
  if (event.type === 'CHECK_OUT' && delivery.status !== 'PGI_POSTED' && delivery.status !== 'BILLED') {
    throw invalidState(`Delivery ${delivery.deliveryId} is ${delivery.status}; no truck leaves the gate without a goods issue.`);
  }
  if (event.type === 'COMPLETE' && s.truckId) {
    const truck = await tx.query.trucks.findFirst({ where: eq(trucks.truckId, s.truckId) });
    if (truck) await tx.update(trucks).set({ status: 'AVAILABLE', version: truck.version + 1 }).where(eq(trucks.truckId, truck.truckId));
  }

  const [shipment] = await tx.update(shipments).set(patch).where(eq(shipments.shipmentId, shipmentId)).returning();
  await logStatusChange(tx, 'Shipment', shipmentId, s.status, move.to, by);

  // After the gross weighment, the delivery's quantity is checked against the net weight.
  if (event.type === 'GROSS') {
    const result = await applyWeighment(tx, delivery, delivery.items, patch.netT!, by);
    await tx
      .update(outboundDeliveries)
      .set({ status: result.status, items: result.items, version: delivery.version + 1 })
      .where(eq(outboundDeliveries.deliveryId, delivery.deliveryId));
  }
  return shipment!;
}
