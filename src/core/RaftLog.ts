import { IStorageAdapter } from '../interfaces/IStorageAdapter';
import { LogEntry } from './raft.types';

/**
 * RaftLog — persistent storage for Raft log entries.
 * 
 * FIX: All mutation operations are now asynchronous and must be awaited to 
 * ensure durability guarantees before responding to RPCs.
 */
export class RaftLog {
    constructor(private provider: IStorageAdapter) {
        this.initTables();
    }

    private async initTables() {
        await this.provider.run(`
            CREATE TABLE IF NOT EXISTS raft_log (
                [index] INTEGER PRIMARY KEY,
                term INTEGER NOT NULL,
                namespace TEXT NOT NULL,
                payload TEXT NOT NULL
            )
       `);

        // Phase 3: Raft Snapshotting
        await this.provider.run(`
            CREATE TABLE IF NOT EXISTS raft_snapshots (
                id INTEGER PRIMARY KEY,
                last_index INTEGER NOT NULL,
                last_term INTEGER NOT NULL,
                data BLOB NOT NULL,
                timestamp INTEGER NOT NULL
            )
       `);
    }

    /** Prune log entries up to (and including) the given index */
    public async compact(lastIncludedIndex: number): Promise<void> {
        await this.provider.run('DELETE FROM raft_log WHERE [index] <= ?', [lastIncludedIndex]);
    }

    public async append(entries: LogEntry[]): Promise<void> {
        for (const entry of entries) {
            await this.provider.run(
                'INSERT OR REPLACE INTO raft_log ([index], term, namespace, payload) VALUES (?, ?, ?, ?)',
                [entry.index, entry.term, entry.namespace, JSON.stringify(entry.payload)]
            );
        }
    }

    public async getEntry(index: number): Promise<LogEntry | null> {
        if (index === 0) return null; // Raft logs are 1-indexed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = await this.provider.get('SELECT * FROM raft_log WHERE [index] = ?', [index]) as any;
        if (!row) return null;
        let payload = row.payload;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (e) { }
        }
        return { ...row, payload };
    }

    public async getEntriesFrom(startIndex: number): Promise<LogEntry[]> {
        const rows = await this.provider.all('SELECT * FROM raft_log WHERE [index] >= ? ORDER BY [index] ASC', [startIndex]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return rows.map((r: any) => {
            let payload = r.payload;
            if (typeof payload === 'string') {
                try { payload = JSON.parse(payload); } catch (e) { }
            }
            return { ...r, payload };
        });
    }

    public async truncateSuffix(fromIndex: number): Promise<void> {
        await this.provider.run('DELETE FROM raft_log WHERE [index] >= ?', [fromIndex]);
    }

    public async getLastLogIndex(): Promise<number> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = await this.provider.get('SELECT MAX([index]) as lastIndex FROM raft_log') as any;
        return row && row.lastIndex ? row.lastIndex : 0;
    }

    public async getLastLogTerm(): Promise<number> {
        const lastIndex = await this.getLastLogIndex();
        if (lastIndex === 0) return 0;
        const entry = await this.getEntry(lastIndex);
        return entry ? entry.term : 0;
    }

    public async getTerm(index: number): Promise<number> {
        if (index === 0) return 0;
        const entry = await this.getEntry(index);
        return entry ? entry.term : 0;
    }
}
