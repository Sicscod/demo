// A small stand-in for the Cloudflare D1 binding on top of node:sqlite, for tests.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function fakeD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => sqlite.prepare(sql).run(...args),
    runNow: () => sqlite.prepare(sql).run(...args),
  });
  return {
    sqlite,
    prepare: (sql) => statement(sql),
    async batch(list) {
      sqlite.exec('BEGIN');
      try {
        for (const s of list) s.runNow();
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

