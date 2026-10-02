// Start a real mock ERP on a random port and talk to it over HTTP, like the copilot will.
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';

export type Res = { status: number; etag: string | null; headers: Headers; body: any };

export async function startErp() {
  const { db, close } = await createDb();
  const app = buildApp(db);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, etag: res.headers.get('etag'), headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  const erp = {
    call,
    get: (path: string) => call('GET', path),
    sim: (path: string, body: unknown = {}) => call('POST', `/sim${path}`, body),
    reset: () => call('POST', '/sim/reset', { fixtures: ['base'] }),
    /** Call an action the way a well-behaved client does: read the version first, send it back. */
    async act(entity: string, action: string, body: unknown, user = 's.patel') {
      const current = await call('GET', `/odata/${entity}`);
      return call('POST', `/odata/${entity}/${action}`, body, { 'if-match': current.etag!, 'x-user': user });
    },
    stop: async () => {
      await app.close();
      await close();
    },
  };
  return erp;
}

export type Erp = Awaited<ReturnType<typeof startErp>>;

/**
 * Walk one order through the physical world up to the weighbridge.
 * With the defaults the delivery ends QTY_CONFIRMED at 30 t, ready for goods issue.
 */
export async function loadedDelivery(
  erp: Erp,
  opts: {
    customerId?: string;
    materialId?: string;
    slocId?: string;
    batchId?: string;
    plannedT?: number;
    netT?: number;
    truckId?: string;
  } = {},
) {
  const {
    customerId = 'C1001',
    materialId = 'OPC53-BAG',
    slocId = 'FG01',
    batchId = 'B2610-0141',
    plannedT = 30,
    netT = plannedT,
    truckId = 'TRK-011',
  } = opts;

  const so = await erp.sim('/salesorders', {
    customerId,
    plantId: 'KC01',
    orderValue: 3000,
    requestedDate: '2026-10-03',
    items: [{ itemNo: 10, materialId, quantityT: plannedT }],
  });
  const salesOrderId: string = so.body.salesOrderId;
  const d = await erp.sim('/deliveries', {
    salesOrderId,
    items: [{ itemNo: 10, materialId, slocId, batchId, plannedQtyT: plannedT }],
  });
  const deliveryId: string = d.body.deliveryId;
  const shipmentId: string = d.body.shipmentId;
  await erp.sim(`/deliveries/${deliveryId}/pick`);
  const assigned = await erp.act(`Shipments('${shipmentId}')`, 'AssignTruck', { truckId }, 'd.jones');
  if (assigned.status !== 200) throw new Error(`AssignTruck failed: ${JSON.stringify(assigned.body)}`);
  for (const event of [
    { type: 'GATE_IN' },
    { type: 'TARE', weightT: 14 },
    { type: 'LOADING' },
    { type: 'GROSS', weightT: 14 + netT },
  ]) {
    const r = await erp.sim(`/shipments/${shipmentId}/events`, event);
    if (r.status !== 200) throw new Error(`${event.type} failed: ${JSON.stringify(r.body)}`);
  }
  return { salesOrderId, deliveryId, shipmentId };
}
