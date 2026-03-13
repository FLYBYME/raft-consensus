import { INetworkAdapter } from '../src/interfaces/INetworkAdapter';
import { IStorageAdapter } from '../src/interfaces/IStorageAdapter';
import { ILogger } from '../src/interfaces/ILogger';

export const createMockNetwork = (): jest.Mocked<INetworkAdapter> => ({
    send: jest.fn().mockImplementation(() => Promise.resolve()),
    broadcast: jest.fn().mockImplementation(() => Promise.resolve()),
    on: jest.fn(),
    getNodeID: jest.fn().mockReturnValue('node-1')
});

export const createMockStorage = (): jest.Mocked<IStorageAdapter> => {
    let logs: any[] = [];
    let snapshots: any[] = [];
    let ledgers: any[] = [];
    let snapId = 1;

    return {
        run: jest.fn().mockImplementation(async (sql: string, params: any[] = []) => {
            if (sql.includes('INSERT OR REPLACE INTO raft_log')) {
                const idx = params[0];
                logs = logs.filter(l => l.index !== idx);
                logs.push({ index: params[0], term: params[1], namespace: params[2], payload: params[3] });
            } else if (sql.includes('DELETE FROM raft_log WHERE [index] >= ?')) {
                logs = logs.filter(l => l.index < params[0]);
            } else if (sql.includes('DELETE FROM raft_log WHERE [index] <= ?')) {
                logs = logs.filter(l => l.index > params[0]);
            } else if (sql.includes('INSERT INTO raft_snapshots')) {
                snapshots.push({ id: snapId++, last_index: params[0], last_term: params[1], data: params[2], timestamp: params[3] });
            } else if (sql.includes('INSERT INTO ledger_transactions') || sql.includes('INSERT OR IGNORE INTO ledger_transactions')) {
                ledgers.push({
                    index: params[0], namespace: params[1], tx_id: params[2],
                    prev_tx_id: params[3], term: params[4], timestamp: params[5],
                    node_id: params[6], payload: params[7]
                });
            } else if (sql.includes('DELETE FROM ledger_transactions WHERE [index] >= ?')) {
                ledgers = ledgers.filter(l => !(l.index >= params[0] && l.namespace === params[1]));
            } else if (sql.includes('DELETE FROM ledger_transactions WHERE [index] < ?')) {
                ledgers = ledgers.filter(l => !(l.index < params[0] && l.namespace === params[1]));
            }
            return { changes: 1 };
        }),
        get: jest.fn().mockImplementation(async (sql: string, params: any[] = []) => {
            if (sql.includes('SELECT MAX([index]) as lastIndex FROM raft_log')) {
                const max = logs.reduce((m, l) => Math.max(m, l.index), 0);
                return { lastIndex: max };
            }
            if (sql.includes('SELECT * FROM raft_log WHERE [index] = ?')) {
                return logs.find(l => l.index === params[0]);
            }
            if (sql.includes('SELECT * FROM raft_snapshots ORDER BY last_index DESC LIMIT 1')) {
                const sorted = [...snapshots].sort((a,b) => b.last_index - a.last_index);
                return sorted[0];
            }
            if (sql.includes('SELECT tx_id, [index] FROM ledger_transactions WHERE namespace = ? ORDER BY [index] DESC LIMIT 1')) {
                const nsLedgers = ledgers.filter(l => l.namespace === params[0]).sort((a,b) => b.index - a.index);
                return nsLedgers[0];
            }
            if (sql.includes('SELECT tx_id FROM ledger_transactions WHERE namespace = ? AND [index] = ?')) {
                return ledgers.find(l => l.namespace === params[0] && l.index === params[1]);
            }
            if (sql.includes('SELECT * FROM ledger_transactions WHERE [index] = ? AND namespace = ?')) {
                return ledgers.find(l => l.index === params[0] && l.namespace === params[1]);
            }
            return undefined;
        }),
        all: jest.fn().mockImplementation(async (sql: string, params: any[] = []) => {
            if (sql.includes('SELECT * FROM raft_log WHERE [index] >= ? ORDER BY [index] ASC')) {
                return logs.filter(l => l.index >= params[0]).sort((a,b) => a.index - b.index);
            }
            if (sql.includes('SELECT id FROM raft_snapshots')) {
                return snapshots.sort((a,b) => b.last_index - a.last_index).map(s => ({id: s.id}));
            }
            if (sql.includes('SELECT * FROM ledger_transactions WHERE [index] > ? AND namespace = ? ORDER BY [index] ASC')) {
                return ledgers.filter(l => l.index > params[0] && l.namespace === params[1]).sort((a,b) => a.index - b.index);
            }
            return [];
        })
    };
};

export const createMockLogger = (): jest.Mocked<ILogger> => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis()
});
