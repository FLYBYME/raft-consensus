import { IStorageAdapter } from '../interfaces/IStorageAdapter';
import { LogEntry } from './raft.types';

/**
 * RaftLog — persistent storage for Raft log entries and snapshots.
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

        await this.provider.run(`
            CREATE TABLE IF NOT EXISTS raft_snapshots (
                id INTEGER PRIMARY KEY,
                last_index INTEGER NOT NULL,
                last_term INTEGER NOT NULL,
                data TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            )
       `);
    }

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
        if (index === 0) return null;
        const row = await this.provider.get('SELECT * FROM raft_log WHERE [index] = ?', [index]) as Record<string, unknown>;
        if (!row) return null;
        let payload = row.payload;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (e) { }
        }
        return { ...row, payload } as unknown as LogEntry;
    }

    public async getEntriesFrom(startIndex: number): Promise<LogEntry[]> {
        const rows = await this.provider.all('SELECT * FROM raft_log WHERE [index] >= ? ORDER BY [index] ASC', [startIndex]);
        return rows.map((r: unknown) => {
            const row = r as Record<string, unknown>;
            let payload = row.payload;
            if (typeof payload === 'string') {
                try { payload = JSON.parse(payload); } catch (e) { }
            }
            return { ...row, payload } as unknown as LogEntry;
        });
    }

    public async truncateSuffix(fromIndex: number): Promise<void> {
        await this.provider.run('DELETE FROM raft_log WHERE [index] >= ?', [fromIndex]);
    }

    public async getLastLogIndex(): Promise<number> {
        const row = await this.provider.get('SELECT MAX([index]) as lastIndex FROM raft_log') as { lastIndex: number } | null;
        const lastIndex = row && row.lastIndex ? row.lastIndex : 0;
        
        if (lastIndex === 0) {
            const snapshot = await this.getLatestSnapshot();
            return snapshot ? snapshot.last_index : 0;
        }
        return lastIndex;
    }

    public async getLastLogTerm(): Promise<number> {
        const lastIndex = await this.getLastLogIndex();
        if (lastIndex === 0) return 0;
        const entry = await this.getEntry(lastIndex);
        if (entry) return entry.term;
        
        const snapshot = await this.getLatestSnapshot();
        return snapshot ? snapshot.last_term : 0;
    }

    public async getTerm(index: number): Promise<number> {
        if (index === 0) return 0;
        const entry = await this.getEntry(index);
        if (entry) return entry.term;
        
        const snapshot = await this.getLatestSnapshot();
        if (snapshot && index === snapshot.last_index) return snapshot.last_term;
        
        return 0;
    }

    /**
     * Create a snapshot of the state machine.
     */
    public async createSnapshot(lastIndex: number, lastTerm: number, data: any): Promise<void> {
        await this.provider.run(
            'INSERT INTO raft_snapshots (last_index, last_term, data, timestamp) VALUES (?, ?, ?, ?)',
            [lastIndex, lastTerm, JSON.stringify(data), Date.now()]
        );
        // Prune old log entries
        await this.compact(lastIndex);
        
        // Keep only the last 2 snapshots
        const snapshots = await this.provider.all('SELECT id FROM raft_snapshots ORDER BY last_index DESC');
        if (snapshots.length > 2) {
            const toDelete = snapshots.slice(2).map(s => (s as { id: number }).id);
            await this.provider.run(`DELETE FROM raft_snapshots WHERE id IN (${toDelete.join(',')})`);
        }
    }

    public async getLatestSnapshot(): Promise<{ last_index: number, last_term: number, data: any } | null> {
        const row = await this.provider.get('SELECT * FROM raft_snapshots ORDER BY last_index DESC LIMIT 1') as { last_index: number, last_term: number, data: string } | null;
        if (row) {
            return {
                ...row,
                data: JSON.parse(row.data)
            };
        }
        return null;
    }
}
