import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// All mutations execute synchronously inside a SQLite transaction. Unlike an
// atomic file rename, this also protects the read/modify/write operation.
export function openTeamStore(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    db.exec('CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const get = db.prepare('SELECT value FROM state WHERE id = ?');
    const put = db.prepare('INSERT INTO state(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value');
    return {
        read(id, fallback) { const row = get.get(id); return row ? JSON.parse(row.value) : structuredClone(fallback); },
        transaction(id, fallback, update) {
            db.exec('BEGIN IMMEDIATE');
            try {
                const state = this.read(id, fallback);
                const result = update(state);
                put.run(id, JSON.stringify(state));
                db.exec('COMMIT');
                return result;
            } catch (error) { db.exec('ROLLBACK'); throw error; }
        },
        close() { db.close(); }
    };
}
