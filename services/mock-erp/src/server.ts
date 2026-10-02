// Start the mock ERP with the standard Kestrel Cement data loaded.
import { buildApp } from './app';
import { createDb } from './db/client';
import { readFixtures, resetErp } from './sim/fixtures';

const port = Number(process.env.ERP_PORT ?? 4001);

const { db } = await createDb();
await resetErp(db, await readFixtures(['base']));
const app = buildApp(db, { logger: true });
await app.listen({ port, host: '0.0.0.0' });
