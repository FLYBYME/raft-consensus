import { RaftNode } from '../src/core/RaftNode';
import { INetworkAdapter } from '../src/interfaces/INetworkAdapter';
import { IStorageAdapter } from '../src/interfaces/IStorageAdapter';
import { ILogger } from '../src/interfaces/ILogger';
import { RaftConfig } from '../src/interfaces/RaftConfig';
import { RaftState } from '../src/core/raft.types';

describe('RaftNode', () => {
    let node: RaftNode;
    let mockNetwork: jest.Mocked<INetworkAdapter>;
    let mockStorage: jest.Mocked<IStorageAdapter>;
    let mockLogger: jest.Mocked<ILogger>;
    let config: RaftConfig;

    beforeEach(() => {
        mockNetwork = {
            send: jest.fn().mockResolvedValue(undefined),
            broadcast: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            getNodeID: jest.fn().mockReturnValue('node-1')
        };

        mockStorage = {
            run: jest.fn().mockResolvedValue(undefined),
            get: jest.fn().mockResolvedValue(undefined),
            all: jest.fn().mockResolvedValue([])
        };

        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn().mockReturnThis()
        };

        config = {
            electionTimeoutMin: 100,
            electionTimeoutMax: 200,
            heartbeatInterval: 50,
            minClusterSize: 3,
            isVoter: true
        };

        node = new RaftNode(mockNetwork, mockStorage, mockLogger, config);
    });

    afterEach(async () => {
        await node.stop();
    });

    test('should initialize in FOLLOWER state', async () => {
        await node.start();
        expect(node.state).toBe(RaftState.FOLLOWER);
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('started in FOLLOWER'), expect.any(Object));
    });

    test('should load persisted state on start', async () => {
        mockStorage.get.mockResolvedValueOnce({ current_term: 5, voted_for: 'node-2' });
        await node.start();
        expect(node.currentTerm).toBe(5);
        expect(node.votedFor).toBe('node-2');
    });

    test('should create a ledger', () => {
        const ledger = node.getOrCreateLedger('test-ledger');
        expect(ledger).toBeDefined();
        expect(ledger.namespace).toBe('test-ledger');
    });

    test('should add peer', () => {
        node.addPeer('node-2');
        expect(node.getPeers()).toContain('node-2');
    });
});
