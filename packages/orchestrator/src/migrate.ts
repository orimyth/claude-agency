import mysql, { Pool, RowDataPacket } from 'mysql2/promise';
import type { AgencyConfig } from './types.js';

// Import migrations statically — each exports { id, description, up }
import * as migration001 from './migrations/migration-001-task-states.js';
import * as migration002 from './migrations/migration-002-new-tables.js';

interface Migration {
  id: string;
  description: string;
  up: string;
}

const migrations: Migration[] = [
  migration001,
  migration002,
];

/**
 * Run all pending database migrations.
 *
 * - Creates the _migrations tracking table if it doesn't exist
 * - Checks which migrations have already been applied
 * - Applies pending migrations in order, each within a transaction
 * - Logs progress to console
 */
export async function runMigrations(config: AgencyConfig['mysql']): Promise<void> {
  const pool: Pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 2,
    connectTimeout: 10_000,
    multipleStatements: true,
  });

  try {
    // Ensure _migrations table exists (idempotent)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id VARCHAR(10) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Get already-applied migration IDs
    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM _migrations ORDER BY id');
    const applied = new Set(rows.map(r => r.id));

    const pending = migrations.filter(m => !applied.has(m.id));

    if (pending.length === 0) {
      console.log('[migrate] All migrations already applied.');
      return;
    }

    console.log(`[migrate] ${pending.length} pending migration(s) to apply.`);

    for (const migration of pending) {
      console.log(`[migrate] Applying ${migration.id}: ${migration.description}...`);

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // Split by semicolons and execute each statement individually.
        // multipleStatements is enabled on the pool, but using individual
        // statements gives better error reporting.
        const statements = migration.up
          .split(';')
          .map(s => s.trim())
          .filter(s => s.length > 0 && !s.startsWith('--'));

        for (const stmt of statements) {
          try {
            await conn.query(stmt);
          } catch (err: any) {
            // Tolerate "column already exists" or "table already exists" errors
            // so migrations are re-runnable (idempotent).
            const code = err?.code ?? '';
            const errno = err?.errno ?? 0;
            if (
              code === 'ER_DUP_FIELDNAME' ||     // Column already exists
              code === 'ER_TABLE_EXISTS_ERROR' || // Table already exists
              errno === 1060 ||                   // Duplicate column name
              errno === 1050                      // Table already exists
            ) {
              console.log(`[migrate]   (skipped, already exists): ${stmt.substring(0, 80)}...`);
            } else {
              throw err;
            }
          }
        }

        // Record migration as applied
        await conn.query('INSERT INTO _migrations (id) VALUES (?)', [migration.id]);
        await conn.commit();
        console.log(`[migrate] Applied ${migration.id} successfully.`);
      } catch (err) {
        await conn.rollback();
        console.error(`[migrate] Failed to apply migration ${migration.id}:`, err);
        throw err;
      } finally {
        conn.release();
      }
    }

    console.log('[migrate] All migrations applied successfully.');
  } finally {
    await pool.end();
  }
}
