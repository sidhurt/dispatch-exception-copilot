// The small slice of OData query syntax v1 supports: $filter (eq, ne, and), $select,
// $expand (one level), $top, $skip, plus keys like ('80012') and (year=2026,month=10).
import { and, eq, isNotNull, isNull, ne, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { validationFailed } from '../domain/errors';

type Value = string | number | boolean | null;

const VALUE = String.raw`'(?:[^']|'')*'|-?\d+(?:\.\d+)?|true|false|null`;

function parseValue(raw: string): Value {
  if (raw.startsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  return Number(raw);
}

/** "status eq 'PICKED' and plantId eq 'KC01'" → a WHERE condition. */
export function parseFilter(filter: string, columns: Record<string, PgColumn>): SQL | undefined {
  const clause = new RegExp(String.raw`^\s*(\w+)\s+(eq|ne)\s+(${VALUE})\s*(?:\band\b|$)`, 'i');
  const conditions: SQL[] = [];
  let rest = filter.trim();
  while (rest.length) {
    const m = clause.exec(rest);
    if (!m) throw validationFailed(`Can't read $filter near: "${rest}". Supported: field eq|ne value, joined with "and".`);
    const [whole, field, op, raw] = m as unknown as [string, string, string, string];
    const column = columns[field];
    if (!column) throw validationFailed(`$filter: unknown field "${field}".`);
    const value = parseValue(raw);
    const isEq = op.toLowerCase() === 'eq';
    conditions.push(value === null ? (isEq ? isNull(column) : isNotNull(column)) : isEq ? eq(column, value) : ne(column, value));
    rest = rest.slice(whole.length).trim();
  }
  return and(...conditions);
}

export function parseList(param: string | undefined, allowed: string[], option: string): string[] | undefined {
  if (!param) return undefined;
  const names = param.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !allowed.includes(n));
  if (unknown.length) throw validationFailed(`${option}: unknown ${unknown.length > 1 ? 'names' : 'name'} ${unknown.join(', ')}.`);
  return names;
}

export function parseTop(param: string | undefined, max = 200): number {
  if (param === undefined) return max;
  const n = Number(param);
  if (!Number.isInteger(n) || n < 0) throw validationFailed('$top must be a whole number.');
  return Math.min(n, max);
}

export function parseSkip(param: string | undefined): number {
  if (param === undefined) return 0;
  const n = Number(param);
  if (!Number.isInteger(n) || n < 0) throw validationFailed('$skip must be a whole number.');
  return n;
}

/** "('80012')" → { [onlyKey]: '80012' };  "(year=2026,month=10)" → { year: 2026, month: 10 }. */
export function parseKey(raw: string, keys: string[]): Record<string, Value> {
  const single = new RegExp(`^(${VALUE})$`).exec(raw.trim());
  if (single && keys.length === 1) return { [keys[0]!]: parseValue(single[1]!) };

  const out: Record<string, Value> = {};
  for (const part of raw.split(',')) {
    const m = new RegExp(String.raw`^\s*(\w+)\s*=\s*(${VALUE})\s*$`).exec(part);
    if (!m || !keys.includes(m[1]!)) throw validationFailed(`Bad key "(${raw})". Expected ${keys.join(', ')}.`);
    out[m[1]!] = parseValue(m[2]!);
  }
  if (keys.some((k) => !(k in out))) throw validationFailed(`Key needs all of: ${keys.join(', ')}. Or use $filter.`);
  return out;
}

/** Split "/OutboundDeliveries('80012')/goodsMovements" into its parts. */
export function parsePath(path: string) {
  const m = /^\/?([A-Za-z]+)(?:\((.*)\))?(?:\/([A-Za-z]+))?\/?$/.exec(path);
  if (!m) return null;
  return { set: m[1]!, key: m[2], segment: m[3] };
}
