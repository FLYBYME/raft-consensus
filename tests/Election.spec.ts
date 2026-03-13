import { RaftNode } from '../src/core/RaftNode';
import { RaftState } from '../src/core/raft.types';
import { createMockNetwork, createMockStorage, createMockLogger } from './test-utils';
import { RaftConfig } from '../src/interfaces/RaftConfig';

describe('Raft Election (15 Tests)', () => {
    let node: RaftNode;
    let mockNetwork: any;
    let mockStorage: any;
    let mockLogger: any;
    let config: RaftConfig;

    beforeEach(async () => {
        mockNetwork = createMockNetwork();
        mockStorage = createMockStorage();
        mockLogger = createMockLogger();
        config = {
            electionTimeoutMin: 50,
            electionTimeoutMax: 100,
            heartbeatInterval: 20,
            minClusterSize: 3,
            isVoter: true
        };
        node = new RaftNode(mockNetwork, mockStorage, mockLogger, config);
        await node.start();
    });

    afterEach(async () => {
        await node.stop();
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    test('1. Node should transition to PRE_CANDIDATE on election timeout', (done) => {
        node.on('state-changed', ({ newState }) => {
            if (newState === RaftState.PRE_CANDIDATE) {
                expect(node.state).toBe(RaftState.PRE_CANDIDATE);
                done();
            }
        });
    }, 1000);

    test('2. Pre-vote should include last log index and term', (done) => {
        node.raftLog.getLastLogIndex = jest.fn().mockReturnValue(10);
        node.raftLog.getLastLogTerm = jest.fn().mockReturnValue(2);
        node.addPeer('peer-1');
        
        mockNetwork.send.mockImplementation((target: string, msg: any) => {
            if (msg.topic === 'vote-req' && msg.data.isPreVote) {
                expect(msg.data.lastLogIndex).toBe(10);
                expect(msg.data.lastLogTerm).toBe(2);
                done();
            }
            return Promise.resolve();
        });
    }, 1000);

    test('3. Pre-candidate should become CANDIDATE after quorum of pre-votes', async () => {
        node.addPeer('peer-1');
        node.addPeer('peer-2');
        // @ts-ignore
        await node.electionManager.becomePreCandidate();
        
        // Receive pre-vote from peer-1
        // @ts-ignore
        node.handleVoteResponse({ term: 0, voteGranted: true }, 'peer-1');
        
        expect(node.state).toBe(RaftState.CANDIDATE);
        expect(node.currentTerm).toBe(1); // Term bumped on becoming candidate
    });

    test('4. Candidate should bump term and vote for self', async () => {
        // @ts-ignore
        await node.electionManager.becomeCandidate();
        expect(node.currentTerm).toBe(1);
        expect(node.votedFor).toBe('node-1');
    });

    test('5. Candidate should become LEADER after quorum of votes', async () => {
        node.addPeer('peer-1');
        node.addPeer('peer-2');
        // @ts-ignore
        await node.electionManager.becomeCandidate();
        
        // Receive vote from peer-1
        // @ts-ignore
        await node.handleVoteResponse({ term: 1, voteGranted: true }, 'peer-1');
        
        expect(node.state).toBe(RaftState.LEADER);
    });

    test('6. Node should reject vote if candidate term < current term', async () => {
        node.currentTerm = 5;
        const reply = await node.rpcManager.handleRequestVote({
            term: 4,
            candidateId: 'peer-2',
            lastLogIndex: 10,
            lastLogTerm: 5
        }, 'peer-2');
        expect(reply.voteGranted).toBe(false);
    });

    test('7. Node should reject vote if already voted for someone else', async () => {
        node.currentTerm = 1;
        node.votedFor = 'peer-1';
        const reply = await node.rpcManager.handleRequestVote({
            term: 1,
            candidateId: 'peer-2',
            lastLogIndex: 0,
            lastLogTerm: 0
        }, 'peer-2');
        expect(reply.voteGranted).toBe(false);
    });

    test('8. Node should grant vote if terms match and log is more up-to-date', async () => {
        node.currentTerm = 1;
        node.votedFor = null;
        const reply = await node.rpcManager.handleRequestVote({
            term: 1,
            candidateId: 'peer-2',
            lastLogIndex: 1,
            lastLogTerm: 1
        }, 'peer-2');
        expect(reply.voteGranted).toBe(true);
        expect(node.votedFor).toBe('peer-2');
    });

    test('9. Node should reject vote if candidate log is stale (term)', async () => {
        node.raftLog.getLastLogTerm = jest.fn().mockReturnValue(3);
        node.raftLog.getLastLogIndex = jest.fn().mockReturnValue(10);
        
        const reply = await node.rpcManager.handleRequestVote({
            term: 3,
            candidateId: 'peer-2',
            lastLogIndex: 20,
            lastLogTerm: 2 // Lower term
        }, 'peer-2');
        expect(reply.voteGranted).toBe(false);
    });

    test('10. Node should reject vote if candidate log is stale (index)', async () => {
        node.raftLog.getLastLogTerm = jest.fn().mockReturnValue(3);
        node.raftLog.getLastLogIndex = jest.fn().mockReturnValue(10);
        
        const reply = await node.rpcManager.handleRequestVote({
            term: 3,
            candidateId: 'peer-2',
            lastLogIndex: 9, // Lower index
            lastLogTerm: 3
        }, 'peer-2');
        expect(reply.voteGranted).toBe(false);
    });

    test('11. Candidate should step down if it receives higher term from peer', async () => {
        node.state = RaftState.CANDIDATE;
        node.currentTerm = 2;
        // @ts-ignore
        await node.handleVoteResponse({ term: 3, voteGranted: false }, 'peer-1');
        expect(node.state).toBe(RaftState.FOLLOWER);
        expect(node.currentTerm).toBe(3);
    });

    test('12. Candidate should step down if it receives AppendEntries from valid leader', async () => {
        node.state = RaftState.CANDIDATE;
        node.currentTerm = 2;
        await node.rpcManager.handleAppendEntries({
            term: 2,
            leaderId: 'peer-2',
            prevLogIndex: 0,
            prevLogTerm: 0,
            entries: [],
            leaderCommit: 0
        }, 'peer-2');
        expect(node.state).toBe(RaftState.FOLLOWER);
        expect(node.currentLeaderID).toBe('peer-2');
    });

    test('13. Pre-candidate should not bump term', async () => {
        node.addPeer('peer-1');
        node.currentTerm = 1;
        // @ts-ignore
        await node.electionManager.becomePreCandidate();
        expect(node.currentTerm).toBe(1);
    });

    test('14. Node should persist state after granting vote', async () => {
        await node.rpcManager.handleRequestVote({
            term: 1,
            candidateId: 'peer-2',
            lastLogIndex: 0,
            lastLogTerm: 0
        }, 'peer-2');
        expect(mockStorage.run).toHaveBeenCalledWith(expect.stringContaining('UPDATE raft_state'), expect.any(Array));
    });

    test('15. Single node cluster should become LEADER instantly', async () => {
        const singleNode = new RaftNode(mockNetwork, mockStorage, mockLogger, { ...config, minClusterSize: 1 });
        await singleNode.start();
        // @ts-ignore
        await singleNode.electionManager.becomePreCandidate();
        expect(singleNode.state).toBe(RaftState.LEADER);
    });
});
