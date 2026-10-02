// The ERP's database. PGlite is a real Postgres that runs inside this Node process,
// so the ERP needs no Docker. Its data lives in memory and resets on restart.
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function createDb() {
  const client = new PGlite();
  const db = drizzle({ client, schema, casing: 'snake_case' });
  await migrate(db, { migrationsFolder });
  return { db, close: () => client.close() };
}

export type Db = Awaited<ReturnType<typeof createDb>>['db'];
// Inside db.transaction(async (tx) => ...). Domain functions take Tx so that
// a check and the write it guards always happen in the same transaction.
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
