// GET /odata/... for reads, POST /odata/<Set>('<id>')/<Action> for the five actions.
import { and, eq, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app';
import { notFound, validationFailed } from '../domain/errors';
import { runAction } from './actions';
import { columnsOf, etagOf, isSetName, serialize, setDef, type NavDef, type SetName } from './entitySets';
import { parseFilter, parseKey, parseList, parsePath, parseSkip, parseTop } from './query';

type Row = Record<string, unknown>;
type Query = Partial<Record<'$filter' | '$select' | '$expand' | '$top' | '$skip', string>>;

export function registerOData(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  async function readRows(set: SetName, extra: (SQL | undefined)[], query: Query = {}): Promise<Row[]> {
    const def = setDef(set);
    const columns = columnsOf(set);
    const where = and(...extra, def.hidden?.(), query.$filter ? parseFilter(query.$filter, columns) : undefined);
    return (await db
      .select()
      .from(def.table)
      .where(where)
      .orderBy(...def.keys.map((k) => columns[k]!))
      .limit(parseTop(query.$top))
      .offset(parseSkip(query.$skip))) as Row[];
  }

  async function follow(row: Row, nav: NavDef, query: Query = {}) {
    const target = columnsOf(nav.target);
    const conditions = [
      eq(target[nav.to]!, row[nav.from] as string),
      ...Object.entries(nav.where ?? {}).map(([k, v]) => eq(target[k]!, v)),
    ];
    const rows = await readRows(nav.target, conditions, query);
    return nav.many ? rows : (rows[0] ?? null);
  }

  /** Apply $select and $expand to rows of one set. */
  async function shape(set: SetName, rows: Row[], query: Query) {
    const navs = setDef(set).nav ?? {};
    const select = parseList(query.$select, Object.keys(columnsOf(set)), '$select');
    const expand = parseList(query.$expand, Object.keys(navs), '$expand') ?? [];
    return Promise.all(
      rows.map(async (row) => {
        const out: Row = serialize(row);
        if (select) {
          for (const k of Object.keys(out)) if (k !== '@odata.etag' && !select.includes(k)) delete out[k];
        }
        for (const name of expand) {
          const related = await follow(row, navs[name]!);
          out[name] = Array.isArray(related) ? related.map(serialize) : related && serialize(related);
        }
        return out;
      }),
    );
  }

  async function findOne(set: SetName, rawKey: string) {
    const def = setDef(set);
    const columns = columnsOf(set);
    const key = parseKey(rawKey, def.keys);
    const [row] = await readRows(set, Object.entries(key).map(([k, v]) => eq(columns[k]!, v)));
    if (!row) throw notFound(`${set}(${rawKey})`);
    return row;
  }

  app.get('/odata/*', async (req, reply) => {
    const path = parsePath((req.params as { '*': string })['*']);
    if (!path || !isSetName(path.set)) throw notFound(`Entity set in "${req.url}"`);
    const { set, key, segment } = path as typeof path & { set: SetName };
    const query = req.query as Query;

    // /Set
    if (key === undefined) {
      if (segment) throw validationFailed('Navigation needs a key, e.g. OutboundDeliveries(\'80012\')/goodsMovements.');
      return { value: await shape(set, await readRows(set, [], query), query) };
    }

    const row = await findOne(set, key);

    // /Set('id')
    if (!segment) {
      const [out] = await shape(set, [row], query);
      if (typeof row.version === 'number') reply.header('ETag', etagOf(row.version));
      return out;
    }

    // /Set('id')/nav
    const nav = setDef(set).nav?.[segment];
    if (!nav) throw notFound(`Navigation "${segment}" on ${set}`);
    const related = await follow(row, nav, query);
    if (Array.isArray(related)) return { value: await shape(nav.target, related, query) };
    if (!related) throw notFound(`${segment} of ${set}(${key})`);
    const [out] = await shape(nav.target, [related], query);
    return out;
  });

  app.post('/odata/*', async (req, reply) => {
    const path = parsePath((req.params as { '*': string })['*']);
    if (!path || !isSetName(path.set) || path.key === undefined || !path.segment) {
      throw notFound(`Action in "${req.url}". Actions look like POST /odata/OutboundDeliveries('80012')/PostGoodsIssue`);
    }
    return runAction(ctx, path.set, path.key, path.segment, req, reply);
  });
}
