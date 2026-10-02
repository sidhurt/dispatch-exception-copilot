import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadedDelivery, startErp, type Erp } from './helpers';

let erp: Erp;
beforeAll(async () => {
  erp = await startErp();
});
afterAll(() => erp.stop());
beforeEach(async () => {
  await erp.reset();
});

const PGI = { postingDate: '2026-10-03' };
const del = (id: string) => `OutboundDeliveries('${id}')`;

describe('happy path: order to completed', () => {
  it('walks an order through weighment, goods issue, checkout and billing', async () => {
    const { salesOrderId, deliveryId, shipmentId } = await loadedDelivery(erp);

    const before = await erp.get(`/odata/${del(deliveryId)}`);
    expect(before.body.status).toBe('QTY_CONFIRMED');
    expect(before.body.items[0].confirmedQtyT).toBe(30);

    const pgi = await erp.act(del(deliveryId), 'PostGoodsIssue', PGI);
    expect(pgi.status).toBe(200);
    expect(pgi.body.delivery.status).toBe('PGI_POSTED');
    expect(pgi.body.goodsMovement).toMatchObject({ movementType: '601', postedBy: 's.patel' });
    expect(pgi.etag).toBe(pgi.body.delivery['@odata.etag']);

    const stock = await erp.get(`/odata/Stocks?$filter=batchId eq 'B2610-0141'`);
    expect(stock.body.value[0].unrestrictedT).toBe(390);

    expect((await erp.sim(`/shipments/${shipmentId}/events`, { type: 'CHECK_OUT' })).status).toBe(200);
    expect((await erp.sim(`/deliveries/${deliveryId}/bill`)).body.status).toBe('BILLED');
    expect((await erp.get(`/odata/SalesOrders('${salesOrderId}')`)).body.status).toBe('COMPLETED');

    await erp.sim(`/shipments/${shipmentId}/events`, { type: 'COMPLETE' });
    expect((await erp.get(`/odata/Trucks('TRK-011')`)).body.status).toBe('AVAILABLE');
  });

  it('refuses checkout before goods issue', async () => {
    const { shipmentId } = await loadedDelivery(erp);
    const r = await erp.sim(`/shipments/${shipmentId}/events`, { type: 'CHECK_OUT' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_STATE');
  });
});

describe('the fixed order of checks (SPEC 5.7)', () => {
  it('400 without X-User, 428 without If-Match, 404 for an unknown record', async () => {
    const { deliveryId } = await loadedDelivery(erp);
    const url = `/odata/${del(deliveryId)}/PostGoodsIssue`;

    expect((await erp.call('POST', url, PGI, { 'if-match': 'W/"1"' })).body.error.code).toBe('VALIDATION_FAILED');
    const noEtag = await erp.call('POST', url, PGI, { 'x-user': 's.patel' });
    expect([noEtag.status, noEtag.body.error.code]).toEqual([428, 'ETAG_REQUIRED']);
    const missing = await erp.call('POST', `/odata/${del('99999')}/PostGoodsIssue`, PGI, { 'x-user': 's.patel', 'if-match': 'W/"1"' });
    expect([missing.status, missing.body.error.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('412 for a stale version, checked before the lock', async () => {
    const { deliveryId } = await loadedDelivery(erp);
    await erp.sim('/locks', { documentType: 'OutboundDelivery', documentId: deliveryId, lockedBy: 'M.FERREIRA' });
    const r = await erp.call('POST', `/odata/${del(deliveryId)}/PostGoodsIssue`, PGI, { 'x-user': 's.patel', 'if-match': 'W/"1"' });
    expect([r.status, r.body.error.code]).toEqual([412, 'ETAG_MISMATCH']);
  });

  it('423 when a person holds the lock, checked before the business rules', async () => {
    const { deliveryId } = await loadedDelivery(erp);
    await erp.call('PATCH', '/sim/customers/C1001', { creditStatus: 'BLOCKED' });
    await erp.sim('/locks', { documentType: 'OutboundDelivery', documentId: deliveryId, lockedBy: 'M.FERREIRA' });
    const r = await erp.act(del(deliveryId), 'PostGoodsIssue', PGI);
    expect([r.status, r.body.error.code]).toEqual([423, 'DOCUMENT_LOCKED']);
    expect(r.body.error.details[0].lockedBy).toBe('M.FERREIRA');

    const locks = await erp.get(`/odata/${del(deliveryId)}/locks`);
    expect(locks.body.value).toHaveLength(1);
  });

  it('logs every rejected write in the document history', async () => {
    const { deliveryId } = await loadedDelivery(erp);
    await erp.call('POST', `/odata/${del(deliveryId)}/PostGoodsIssue`, PGI, { 'x-user': 's.patel', 'if-match': 'W/"1"' });
    const events = await erp.get(`/odata/${del(deliveryId)}/events?$filter=eventType eq 'WRITE_REJECTED'`);
    expect(events.body.value[0].details).toMatchObject({ action: 'PostGoodsIssue', code: 'ETAG_MISMATCH', httpStatus: 412 });
  });
});

describe('goods issue guards', () => {
  it('blocks goods issue for a customer on credit stop', async () => {
    const { deliveryId } = await loadedDelivery(erp);
    await erp.call('PATCH', '/sim/customers/C1001', { creditStatus: 'BLOCKED' });
    const r = await erp.act(del(deliveryId), 'PostGoodsIssue', PGI);
    expect([r.status, r.body.error.code]).toEqual([409, 'CUSTOMER_CREDIT_BLOCKED']);
  });

  it('blocks posting into a closed period', async () => {
    const { deliveryId } = await loadedDelivery(erp);
    const r = await erp.act(del(deliveryId), 'PostGoodsIssue', { postingDate: '2026-09-30' });
    expect(r.body.error.code).toBe('PERIOD_CLOSED');
  });

  it('blocks goods issue when the books show less stock than is on the truck', async () => {
    const { deliveryId } = await loadedDelivery(erp, { materialId: 'PPC-BULK', slocId: 'SL01', batchId: 'B2610-0151' });
    const r = await erp.act(del(deliveryId), 'PostGoodsIssue', PGI);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(r.body.error.message).toContain('18.000 t unrestricted');
  });

  it('reports every failed guard, with the first one as the code', async () => {
    const { deliveryId } = await loadedDelivery(erp, { materialId: 'PPC-BULK', slocId: 'SL01', batchId: 'B2610-0151' });
    await erp.call('PATCH', '/sim/customers/C1001', { creditStatus: 'BLOCKED' });
    const r = await erp.act(del(deliveryId), 'PostGoodsIssue', { postingDate: '2026-09-30' });
    expect(r.body.error.code).toBe('CUSTOMER_CREDIT_BLOCKED');
    expect(r.body.error.details.map((d: { code: string }) => d.code)).toEqual([
      'CUSTOMER_CREDIT_BLOCKED',
      'PERIOD_CLOSED',
      'INSUFFICIENT_STOCK',
    ]);
  });

  it('refuses a second goods issue on the same delivery', async () => {
    const { deliveryId } = await loadedDelivery(erp);
    await erp.act(del(deliveryId), 'PostGoodsIssue', PGI);
    const again = await erp.act(del(deliveryId), 'PostGoodsIssue', PGI);
    expect([again.status, again.body.error.code]).toEqual([409, 'ALREADY_POSTED']);
  });
});

describe('weighment tolerance', () => {
  it('keeps the delivery PICKED when the net weight is outside tolerance', async () => {
    const { deliveryId } = await loadedDelivery(erp, { netT: 29.62 });
    const d = await erp.get(`/odata/${del(deliveryId)}`);
    expect(d.body.status).toBe('PICKED');
    const check = await erp.get(`/odata/${del(deliveryId)}/events?$filter=eventType eq 'WEIGHMENT_CHECKED'`);
    expect(check.body.value[0].details).toMatchObject({ netT: 29.62, plannedT: 30, allowedDifferenceT: 0.15, withinTolerance: false });
  });

  it('confirms the quantity once it is adjusted to the net weight', async () => {
    const { deliveryId } = await loadedDelivery(erp, { netT: 29.62 });
    const r = await erp.act(del(deliveryId), 'AdjustQuantity', { itemNo: 10, newQuantityT: 29.62 }, 'd.jones');
    expect(r.status).toBe(200);
    expect(r.body.delivery.status).toBe('QTY_CONFIRMED');
    expect(r.body.delivery.items[0].confirmedQtyT).toBe(29.62);
  });

  it('accepts a net weight just inside tolerance', async () => {
    const { deliveryId } = await loadedDelivery(erp, { netT: 29.85 });
    expect((await erp.get(`/odata/${del(deliveryId)}`)).body.status).toBe('QTY_CONFIRMED');
  });

  it('rejects a zero quantity', async () => {
    const { deliveryId } = await loadedDelivery(erp);
    const r = await erp.act(del(deliveryId), 'AdjustQuantity', { itemNo: 10, newQuantityT: 0 }, 'd.jones');
    expect([r.status, r.body.error.code]).toEqual([409, 'QTY_OUT_OF_RANGE']);
  });
});

describe('reversal', () => {
  it('reverses a goods issue, returns the stock, and allows a fresh goods issue', async () => {
    const { deliveryId } = await loadedDelivery(erp);
    const pgi = await erp.act(del(deliveryId), 'PostGoodsIssue', PGI);
    const rev = await erp.act(del(deliveryId), 'ReverseGoodsIssue', {
      goodsMovementId: pgi.body.goodsMovement.goodsMovementId,
      postingDate: '2026-10-03',
      reason: 'Posted against the wrong truck.',
    });
    expect(rev.status).toBe(200);
    expect(rev.body.delivery.status).toBe('REVERSED');
    expect(rev.body.goodsMovement).toMatchObject({ movementType: '602', reversesGoodsMovementId: pgi.body.goodsMovement.goodsMovementId });
    expect((await erp.get(`/odata/Stocks?$filter=batchId eq 'B2610-0141'`)).body.value[0].unrestrictedT).toBe(420);

    const again = await erp.act(del(deliveryId), 'PostGoodsIssue', PGI);
    expect(again.body.delivery.status).toBe('PGI_POSTED');
  });

  it('refuses to reverse after billing', async () => {
    const { deliveryId } = await loadedDelivery(erp);
    const pgi = await erp.act(del(deliveryId), 'PostGoodsIssue', PGI);
    await erp.sim(`/deliveries/${deliveryId}/bill`);
    const rev = await erp.act(del(deliveryId), 'ReverseGoodsIssue', {
      goodsMovementId: pgi.body.goodsMovement.goodsMovementId,
      postingDate: '2026-10-03',
      reason: 'Customer refused.',
    });
    expect([rev.status, rev.body.error.code]).toEqual([409, 'ALREADY_BILLED']);
  });
});

describe('chaos', () => {
  it('timeout after commit: the write happens but the caller hears nothing', async () => {
    const { deliveryId } = await loadedDelivery(erp);
    await erp.call('PUT', '/sim/chaos', { rules: [{ kind: 'timeout_after_commit', action: 'PostGoodsIssue', times: 1 }] });

    const before = await erp.get(`/odata/${del(deliveryId)}`);
    const url = `/odata/${del(deliveryId)}/PostGoodsIssue`;
    const headers = { 'if-match': before.etag!, 'x-user': 's.patel' };
    await expect(erp.call('POST', url, PGI, headers)).rejects.toThrow();

    // It did post.
    const after = await erp.get(`/odata/${del(deliveryId)}?$expand=goodsMovements`);
    expect(after.body.status).toBe('PGI_POSTED');
    expect(after.body.goodsMovements).toHaveLength(1);

    // A blind retry with the old version is stopped by the version check...
    const blind = await erp.call('POST', url, PGI, headers);
    expect(blind.body.error.code).toBe('ETAG_MISMATCH');
    // ...and a re-read-then-retry is stopped by the status guard.
    const clever = await erp.call('POST', url, PGI, { ...headers, 'if-match': after.etag! });
    expect(clever.body.error.code).toBe('ALREADY_POSTED');
    expect((await erp.get(`/odata/${del(deliveryId)}/goodsMovements`)).body.value).toHaveLength(1);

    // The copilot can't see the chaos; a drill review can.
    const visible = await erp.get(`/odata/${del(deliveryId)}/events`);
    expect(visible.body.value.some((e: { eventType: string }) => e.eventType === 'CHAOS_INJECTED')).toBe(false);
    const all = await erp.get(`/sim/events?documentId=${deliveryId}`);
    expect(all.body.value.some((e: { eventType: string }) => e.eventType === 'CHAOS_INJECTED')).toBe(true);
  });

  it('lock conflict: refused once, then the same call succeeds', async () => {
    const { deliveryId } = await loadedDelivery(erp);
    await erp.call('PUT', '/sim/chaos', { rules: [{ kind: 'lock_conflict', action: 'PostGoodsIssue', times: 1 }] });
    const first = await erp.act(del(deliveryId), 'PostGoodsIssue', PGI);
    expect([first.status, first.body.error.details[0].lockedBy]).toEqual([423, 'SYSTEM_BATCH_JOB']);
    expect((await erp.get(`/odata/${del(deliveryId)}/locks`)).body.value).toHaveLength(0);
    const second = await erp.act(del(deliveryId), 'PostGoodsIssue', PGI);
    expect(second.status).toBe(200);
  });

  it('outage: every /odata call gets 503 for the window, then service returns', async () => {
    await erp.call('PUT', '/sim/chaos', { rules: [{ kind: 'outage', startAfterRequests: 1, durationSeconds: 0.3 }] });
    expect((await erp.get(`/odata/Plants`)).status).toBe(200);
    const down = await erp.get(`/odata/Plants`);
    expect([down.status, down.body.error.code, down.headers.get('retry-after')]).toEqual([503, 'SERVICE_UNAVAILABLE', '1']);
    expect((await erp.get('/health')).status).toBe(200); // /sim and /health are not part of the ERP's API
    await new Promise((r) => setTimeout(r, 350));
    expect((await erp.get(`/odata/Plants`)).status).toBe(200);
  });

  it('rejects a malformed chaos rule', async () => {
    const r = await erp.call('PUT', '/sim/chaos', { rules: [{ kind: 'timeout_after_commit', action: 'Explode', times: 1 }] });
    expect(r.status).toBe(400);
  });
});

describe('credit', () => {
  const order = (customerId: string, orderValue: number) =>
    erp.sim('/salesorders', {
      customerId,
      plantId: 'KC01',
      orderValue,
      requestedDate: '2026-10-03',
      items: [{ itemNo: 10, materialId: 'OPC53-BAG', quantityT: 30 }],
    });

  it('blocks an order that would push exposure over the limit, until finance releases it', async () => {
    const so = await order('C1002', 10000); // 492,000 + 10,000 > 500,000
    expect(so.body.status).toBe('CREDIT_BLOCKED');
    const items = [{ itemNo: 10, materialId: 'OPC53-BAG', slocId: 'FG01', plannedQtyT: 30 }];
    expect((await erp.sim('/deliveries', { salesOrderId: so.body.salesOrderId, items })).status).toBe(409);

    const req = await erp.act(`SalesOrders('${so.body.salesOrderId}')`, 'RequestCreditRelease', { reason: 'Payment promised Friday.' });
    expect(req.body).toEqual({ requestId: 'CRR-0001', status: 'REQUESTED' });
    expect((await erp.get(`/odata/SalesOrders('${so.body.salesOrderId}')`)).body.status).toBe('CREDIT_BLOCKED');

    await erp.sim(`/salesorders/${so.body.salesOrderId}/release-credit`);
    expect((await erp.sim('/deliveries', { salesOrderId: so.body.salesOrderId, items })).status).toBe(200);
  });

  it('blocks every new order for a customer on credit stop', async () => {
    expect((await order('C1003', 100)).body.status).toBe('CREDIT_BLOCKED');
  });

  it('refuses a credit-release request when nothing is blocked', async () => {
    const so = await order('C1001', 1000);
    const r = await erp.act(`SalesOrders('${so.body.salesOrderId}')`, 'RequestCreditRelease', { reason: 'Just in case.' });
    expect([r.status, r.body.error.code]).toEqual([409, 'INVALID_STATE']);
  });
});

describe('trucks', () => {
  it('refuses a truck that is too small or out of service', async () => {
    const so = await erp.sim('/salesorders', {
      customerId: 'C1001', plantId: 'KC01', orderValue: 3000, requestedDate: '2026-10-03',
      items: [{ itemNo: 10, materialId: 'OPC53-BAG', quantityT: 30 }],
    });
    const d = await erp.sim('/deliveries', {
      salesOrderId: so.body.salesOrderId,
      items: [{ itemNo: 10, materialId: 'OPC53-BAG', slocId: 'FG01', batchId: 'B2610-0141', plannedQtyT: 30 }],
    });
    const shipment = `Shipments('${d.body.shipmentId}')`;
    expect((await erp.act(shipment, 'AssignTruck', { truckId: 'TRK-015' })).body.error.code).toBe('TRUCK_OVER_CAPACITY');
    expect((await erp.act(shipment, 'AssignTruck', { truckId: 'TRK-016' })).body.error.code).toBe('TRUCK_UNAVAILABLE');
  });
});

describe('OData reads', () => {
  it('supports $filter, $select and keeps the ETag', async () => {
    const r = await erp.get(`/odata/Trucks?$filter=status eq 'AVAILABLE' and capacityT eq 32&$select=truckId`);
    expect(r.body.value).toEqual([{ '@odata.etag': 'W/"1"', truckId: 'TRK-011' }]);
  });

  it('supports $expand and navigation', async () => {
    const { salesOrderId, deliveryId } = await loadedDelivery(erp);
    const d = await erp.get(`/odata/${del(deliveryId)}?$expand=shipment,customer`);
    expect(d.body.shipment.status).toBe('GROSS_DONE');
    expect(d.body.customer.name).toBe('Harbourline Builders');
    const list = await erp.get(`/odata/SalesOrders('${salesOrderId}')/deliveries`);
    expect(list.body.value.map((x: { deliveryId: string }) => x.deliveryId)).toEqual([deliveryId]);
    const weighments = await erp.get(`/odata/Shipments('${d.body.shipmentId}')/weighments`);
    expect(weighments.body.value.map((w: { kind: string }) => w.kind)).toEqual(['TARE', 'GROSS']);
  });

  it('reads a record with a two-part key', async () => {
    const r = await erp.get('/odata/PostingPeriods(year=2026,month=9)');
    expect(r.body.status).toBe('CLOSED');
  });

  it('answers bad queries with clear errors', async () => {
    expect((await erp.get(`/odata/Trucks?$filter=colour eq 'red'`)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await erp.get('/odata/Spaceships')).status).toBe(404);
    expect((await erp.get(`/odata/${del('99999')}`)).status).toBe(404);
  });
});

describe('fixtures', () => {
  it('starts new document numbers above whatever the fixture loaded', async () => {
    const base = JSON.parse(readFileSync(new URL('../fixtures/base.json', import.meta.url), 'utf8'));
    const state = {
      ...base,
      salesOrders: [
        { salesOrderId: '10000900', customerId: 'C1001', plantId: 'KC01', status: 'RELEASED', orderValue: 1000,
          currency: 'USD', requestedDate: '2026-10-03', items: [{ itemNo: 10, materialId: 'OPC53-BAG', quantityT: 10 }],
          createdAt: '2026-10-03T08:00:00Z' },
      ],
    };
    expect((await erp.call('POST', '/sim/reset', { state })).status).toBe(200);
    const next = await erp.sim('/salesorders', {
      customerId: 'C1001', plantId: 'KC01', orderValue: 1000, requestedDate: '2026-10-03',
      items: [{ itemNo: 10, materialId: 'OPC53-BAG', quantityT: 10 }],
    });
    expect(next.body.salesOrderId).toBe('10000901');
  });
});
