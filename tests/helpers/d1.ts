import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/** Runs Worker SQL against SQLite, including real conditional UPDATE semantics. */
export class SQLiteD1 {
  readonly database = new DatabaseSync(':memory:');

  prepare(sql: string): SQLiteStatement {
    return new SQLiteStatement(this.database, sql);
  }

  async batch(statements: SQLiteStatement[]) {
    this.database.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  withSession(_constraint?: string): SQLiteD1 { return this; }

  close() { this.database.close(); }
}

export class SQLiteStatement {
  private values: SQLInputValue[] = [];

  constructor(private database: DatabaseSync, private sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values as SQLInputValue[];
    return this;
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const result = this.database.prepare(this.sql).get(...this.values);
    return (column ? result?.[column] : result) as T | null ?? null;
  }

  async all<T = Record<string, unknown>>() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.values) as T[], meta: { changes: 0 } };
  }

  async run<T = Record<string, unknown>>() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, results: [] as T[], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

export function createTestDatabase(): SQLiteD1 {
  const db = new SQLiteD1();
  db.database.exec(readFileSync(new URL('../../migrations/0001_rooms.sql', import.meta.url), 'utf8'));
  return db;
}
