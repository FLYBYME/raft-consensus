import { IStorageAdapter } from '../interfaces/IStorageAdapter';
import { LogEntry } from './raft.types';

export class RaftLog {
    constructor(private provider: IStorageAdapter) {
        this.initTables();
    }

    private initTables() {
        this.provider.run(`
            CREATE TABLE IF NOT EXISTS raft_log (
                [index] INTEGER PRIMARY KEY,
                term INTEGER NOT NULL,
                namespace TEXT NOT NULL,
                payload TEXT NOT NULL
            )
       `);

        // Phase 3: Raft Snapshotting
        this.provider.run(`
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
    public compact(lastIncludedIndex: number): void {
        this.provider.run('DELETE FROM raft_log WHERE [index] <= ?', [lastIncludedIndex]);
    }

    public append(entries: LogEntry[]): void {
        for (const entry of entries) {
            this.provider.run(
                'INSERT OR REPLACE INTO raft_log ([index], term, namespace, payload) VALUES (?, ?, ?, ?)',
                [entry.index, entry.term, entry.namespace, JSON.stringify(entry.payload)]
            );
        }
    }

    public getEntry(index: number): LogEntry | null {
        if (index === 0) return null; // Raft logs are 1-indexed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = this.provider.get('SELECT * FROM raft_log WHERE [index] = ?', [index]) as any;
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

    public truncateSuffix(fromIndex: number): void {
        this.provider.run('DELETE FROM raft_log WHERE [index] >= ?', [fromIndex]);
    }

    public getLastLogIndex(): number {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = this.provider.get('SELECT MAX([index]) as lastIndex FROM raft_log') as any;
        return row && row.lastIndex ? row.lastIndex : 0;
    }

    public getLastLogTerm(): number {
        const lastIndex = this.getLastLogIndex();
        if (lastIndex === 0) return 0;
        const entry = this.getEntry(lastIndex);
        return entry ? entry.term : 0;
    }

    public getTerm(index: number): number {
        if (index === 0) return 0;
        const entry = this.getEntry(index);
        return entry ? entry.term : 0;
    }
}
