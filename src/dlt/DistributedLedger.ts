import { IsomorphicCrypto } from '../utils/crypto';
import { Transaction, LedgerEntry, LogConflictError } from './dlt.types';
import { IStorageAdapter } from '../interfaces/IStorageAdapter';

/**
 * DistributedLedger — generic implementation of an immutable transaction chain.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class DistributedLedger<T = any, S = any> {
    public namespace: string;
    private provider: IStorageAdapter;
    private head: string | null = null;
    private length = 0;
    private readonly GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

    /**
     * Optional custom verifier for domain-specific payload validation
     */
    public customVerifier?: (tx: Transaction<T>) => boolean | Promise<boolean>;

    constructor(namespace: string, provider: IStorageAdapter) {
        this.namespace = namespace;
        this.provider = provider;
        if (this.provider) {
            this.loadInitialState();
        }
    }

    private async loadInitialState(): Promise<void> {
        try {
            const row = await this.provider.get(
                'SELECT tx_id, [index] FROM ledger_transactions WHERE namespace = ? ORDER BY [index] DESC LIMIT 1',
                [this.namespace]
            );
            if (row) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.head = (row as any).tx_id;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.length = (row as any).index;
            }
        } catch (err) {
            // Ignore init errors if table doesn't exist yet
        }
    }

    /**
     * Append a new transaction to the local ledger.
     */
    async append(entry: LedgerEntry<T>): Promise<Transaction<T>> {
        return new Promise<Transaction<T>>((resolve, reject) => {
            this.writeQueue = this.writeQueue.then(async () => {
                try {
                    // 1. Get current state from DB to avoid staleness across instances
                    const lastRow = await this.provider.get(
                        'SELECT tx_id, [index] FROM ledger_transactions WHERE namespace = ? ORDER BY [index] DESC LIMIT 1',
                        [this.namespace]
                    );

                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const index = (lastRow ? (lastRow as any).index : 0) + 1;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const prevTxID = (lastRow ? (lastRow as any).tx_id : null) || this.GENESIS_HASH;

                    // 2. Construct transaction
                    const tx: Transaction<T> = {
                        txID: '',
                        index,
                        prevTxID,
                        term: entry.term,
                        timestamp: entry.timestamp || Date.now(),
                        nodeID: entry.nodeID || 'unknown',
                        payload: entry.payload
                    };

                    // 3. Compute Hash
                    tx.txID = await this.computeHash(tx);

                    // 4. Persist
                    await this.provider.run(
                        'INSERT INTO ledger_transactions ([index], namespace, tx_id, prev_tx_id, term, timestamp, node_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        [tx.index, this.namespace, tx.txID, tx.prevTxID, tx.term, tx.timestamp, tx.nodeID, JSON.stringify(tx.payload)]
                    );

                    this.head = tx.txID;
                    this.length = index;

                    resolve(tx);
                } catch (err) {
                    console.error(`[DLT] Append failed for ${this.namespace}:`, err);
                    reject(err);
                }
            }).catch(() => {
                // Ensure queue continues even if previous promise was rejected
            });
        });
    }

    private writeQueue: Promise<void> = Promise.resolve();

    /**
     * Append an entry that already has an index and ID (from leader).
     */
    async appendLocally(tx: Transaction<T>): Promise<void> {
        const deferred = new Promise<void>((resolve, reject) => {
            this.writeQueue = this.writeQueue.then(async () => {
                try {
                    // 1. Check if index already exists to be idempotent
                    const existing = await this.provider.get(
                        'SELECT tx_id FROM ledger_transactions WHERE namespace = ? AND [index] = ?',
                        [this.namespace, tx.index]
                    );

                    if (existing) {
                        resolve();
                        return;
                    }

                    await this.provider.run(
                        'INSERT OR IGNORE INTO ledger_transactions ([index], namespace, tx_id, prev_tx_id, term, timestamp, node_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        [tx.index, this.namespace, tx.txID, tx.prevTxID, tx.term, tx.timestamp, tx.nodeID, JSON.stringify(tx.payload)]
                    );

                    this.head = tx.txID;
                    this.length = Math.max(this.length, tx.index);
                    resolve();
                } catch (err: any) {
                    console.error(`[DLT] Ledger write failed for index ${tx.index} in ${this.namespace}:`, err.message);
                    // We resolve here to NOT break the queue, but the caller gets the rejection via the returned promise
                    reject(err);
                }
            }).catch(() => {
                // Catch-all to keep the serial queue alive
            });
        });

        return deferred;
    }

    /**
     * Reconcile local log with remote entries.
     */
    async reconcileLog(entries: Transaction<T>[], prevIndex: number, prevTerm: number): Promise<void> {
        if (prevIndex > 0) {
            const local = await this.getEntry(prevIndex);
            if (!local || local.term !== prevTerm) {
                throw new LogConflictError(`Log inconsistency at index ${prevIndex}`);
            }
        }

        for (const remote of entries) {
            const local = await this.getEntry(remote.index);
            if (local && local.term !== remote.term) {
                await this.truncateSuffix(remote.index);
                break;
            }
        }

        for (const remote of entries) {
            if (remote.index > this.length) {
                await this.appendLocally(remote);
            }
        }
    }

    async truncateSuffix(startIndex: number): Promise<void> {
        await this.provider.run('DELETE FROM ledger_transactions WHERE [index] >= ? AND namespace = ?', [startIndex, this.namespace]);
        await this.loadInitialState();
    }

    /**
     * Compact: Prune the ledger up to the given index to save space.
     * This should only be called after a snapshot of the state at this index is persisted.
     */
    async compact(upToIndex: number): Promise<void> {
        this.writeQueue = this.writeQueue.then(async () => {
            try {
                await this.provider.run(
                    'DELETE FROM ledger_transactions WHERE [index] < ? AND namespace = ?',
                    [upToIndex, this.namespace]
                );
            } catch (err) {
                console.error(`[DLT] Compact failed for ${this.namespace}:`, err);
            }
        }).catch(() => {});
        return this.writeQueue;
    }

    async getEntry(index: number): Promise<Transaction<T> | null> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = await this.provider.get('SELECT * FROM ledger_transactions WHERE [index] = ? AND namespace = ?', [index, this.namespace]) as any;
        return row ? this.mapRowToTx(row) : null;
    }

    async getEntriesFrom(index: number): Promise<Transaction<T>[]> {
        const rows = await this.provider.all('SELECT * FROM ledger_transactions WHERE [index] > ? AND namespace = ? ORDER BY [index] ASC', [index, this.namespace]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return rows.map((r: any) => this.mapRowToTx(r));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private mapRowToTx(row: any): Transaction<T> {
        let payload = row.payload;
        if (typeof payload === 'string') {
            try {
                payload = JSON.parse(payload);
            } catch (e) {
                // Not JSON, keep as string
            }
        }
        return {
            txID: row.tx_id,
            index: row.index,
            prevTxID: row.prev_tx_id || this.GENESIS_HASH,
            term: row.term,
            timestamp: row.timestamp,
            nodeID: row.node_id,
            payload
        };
    }

    private async computeHash(tx: Transaction<T>): Promise<string> {
        const data = `${tx.index}|${tx.prevTxID || this.GENESIS_HASH}|${tx.term}|${tx.timestamp}|${tx.nodeID}|${JSON.stringify(tx.payload)}`;
        return await IsomorphicCrypto.sha256(data);
    }

    async verifyChain(): Promise<boolean> {
        const entries = await this.getEntriesFrom(0);
        let prevTxID = this.GENESIS_HASH;

        for (const tx of entries) {
            if (tx.prevTxID !== prevTxID) return false;
            const expectedID = await this.computeHash(tx);
            if (tx.txID !== expectedID) return false;
            prevTxID = tx.txID;
        }
        return true;
    }

    getLength(): number { return this.length; }
    getHead(): string | null { return this.head; }

    async commit(index: number): Promise<Transaction<T>[]> {
        return this.getEntriesFrom(index);
    }
}
