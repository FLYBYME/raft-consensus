import { DistributedLedger } from '../src/dlt/DistributedLedger';
import { createMockStorage } from './test-utils';
import { Transaction } from '../src/dlt/dlt.types';

describe('Distributed Ledger (10 Tests)', () => {
    let ledger: DistributedLedger;
    let mockStorage: any;

    beforeEach(async () => {
        mockStorage = createMockStorage();
        ledger = new DistributedLedger('test-ns', mockStorage);
        // Wait for loadInitialState to complete if needed, 
        // but since we mock storage to return immediately it's fine.
    });

    test('1. Ledger should initialize and load state', async () => {
        mockStorage.get.mockResolvedValueOnce({ tx_id: 'hash1', index: 5 });
        const newLedger = new DistributedLedger('test-ns', mockStorage);
        // @ts-ignore - access private for test
        await newLedger.loadInitialState();
        expect(newLedger.getHead()).toBe('hash1');
        expect(newLedger.getLength()).toBe(5);
    });

    test('2. Appending should compute hash and call storage', async () => {
        // mockStorage.get for lastRow
        mockStorage.get.mockResolvedValueOnce(null);
        const tx = await ledger.append({ term: 1, payload: { data: 'hello' } });
        expect(tx.txID).toBeDefined();
        expect(tx.index).toBe(1);
        expect(mockStorage.run).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO ledger_transactions'), expect.any(Array));
    });

    test('3. AppendLocally should be idempotent', async () => {
        mockStorage.get.mockResolvedValueOnce({ tx_id: 'hash1' }); // Entry exists
        const tx: Transaction = { txID: 'hash1', index: 1, prevTxID: null, term: 1, timestamp: Date.now(), nodeID: 'n1', payload: {} };
        await ledger.appendLocally(tx);
        expect(mockStorage.run).not.toHaveBeenCalledWith(expect.stringContaining('INSERT'), expect.any(Array));
    });

    test('4. verifyChain should return true for valid chain', async () => {
        mockStorage.get.mockResolvedValue(null); // for append
        const tx1 = await ledger.append({ term: 1, payload: 'p1' });
        
        mockStorage.get.mockResolvedValue({ tx_id: tx1.txID, index: 1 }); // for next append
        const tx2 = await ledger.append({ term: 1, payload: 'p2' });
        
        mockStorage.all.mockResolvedValue([
            { ...tx1, tx_id: tx1.txID, prev_tx_id: tx1.prevTxID, node_id: tx1.nodeID },
            { ...tx2, tx_id: tx2.txID, prev_tx_id: tx2.prevTxID, node_id: tx2.nodeID }
        ]);
        
        const isValid = await ledger.verifyChain();
        expect(isValid).toBe(true);
    });

    test('5. verifyChain should return false if hash mismatch', async () => {
        mockStorage.get.mockResolvedValue(null);
        const tx1 = await ledger.append({ term: 1, payload: 'p1' });
        mockStorage.all.mockResolvedValue([
            { ...tx1, tx_id: 'tampered', prev_tx_id: tx1.prevTxID, node_id: tx1.nodeID }
        ]);
        const isValid = await ledger.verifyChain();
        expect(isValid).toBe(false);
    });

    test('6. reconcileLog should truncate on conflict', async () => {
        ledger.getEntry = jest.fn().mockResolvedValue({ term: 1 });
        ledger.truncateSuffix = jest.fn().mockResolvedValue(undefined);
        
        const remoteEntries: Transaction[] = [{ index: 5, term: 2, txID: 'h', prevTxID: 'p', timestamp: 0, nodeID: 'n', payload: {} }];
        await ledger.reconcileLog(remoteEntries, 4, 1);
        
        expect(ledger.truncateSuffix).toHaveBeenCalledWith(5);
    });

    test('7. reconcileLog should throw on base inconsistency', async () => {
        ledger.getEntry = jest.fn().mockResolvedValue(null); // Missing base
        await expect(ledger.reconcileLog([], 5, 1)).rejects.toThrow('Log inconsistency');
    });

    test('8. compact should prune old entries', async () => {
        await ledger.compact(100);
        expect(mockStorage.run).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM ledger_transactions WHERE [index] < ?'), [100, 'test-ns']);
    });

    test('9. getEntriesFrom should map rows correctly', async () => {
        mockStorage.all.mockResolvedValue([{ index: 1, payload: '{"a":1}', tx_id: 'h1', prev_tx_id: null, term: 1, timestamp: 0, node_id: 'n1' }]);
        const entries = await ledger.getEntriesFrom(0);
        expect(entries[0].payload).toEqual({ a: 1 });
    });

    test('10. customVerifier should be defined', async () => {
        expect(ledger.customVerifier).toBeUndefined();
        ledger.customVerifier = jest.fn().mockReturnValue(true);
        expect(ledger.customVerifier).toBeDefined();
    });
});
