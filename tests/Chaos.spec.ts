import { RaftNode } from '../src/core/RaftNode';
import { RaftState } from '../src/core/raft.types';
import { createMockStorage, createMockLogger } from './test-utils';
import { INetworkAdapter, RaftMessage } from '../src/interfaces/INetworkAdapter';
import { EventEmitter } from 'eventemitter3';

/**
 * Enhanced MockNetworkAdapter with Chaos Testing capabilities.
 */
class MockNetworkAdapter extends EventEmitter implements INetworkAdapter {
    private blockedPeers = new Set<string>();

    constructor(private nodeID: string, private cluster: Map<string, MockNetworkAdapter>) {
        super();
        cluster.set(nodeID, this);
    }

    /** Simulate a network partition */
    block(peerID: string) { this.blockedPeers.add(peerID); }
    unblock(peerID: string) { this.blockedPeers.delete(peerID); }
    clearBlocks() { this.blockedPeers.clear(); }

    async send(target: string, msg: RaftMessage) {
        if (this.blockedPeers.has(target)) return; // Drop packet
        
        setImmediate(() => {
            const peer = this.cluster.get(target);
            if (peer) {
                // Check if target has blocked us back (bidirectional partition)
                if (peer.isBlocked(this.nodeID)) return;
                peer.emit(msg.topic, msg);
            }
        });
    }

    async broadcast(msg: RaftMessage) {
        for (const peerID of this.cluster.keys()) {
            if (peerID !== this.nodeID) {
                await this.send(peerID, msg);
            }
        }
    }

    isBlocked(peerID: string): boolean { return this.blockedPeers.has(peerID); }
    getNodeID() { return this.nodeID; }
}

describe('Raft Chaos & Partition Testing', () => {
    let nodes: RaftNode[] = [];
    let cluster: Map<string, MockNetworkAdapter>;
    let adapters: MockNetworkAdapter[] = [];

    beforeEach(async () => {
        cluster = new Map();
        nodes = [];
        adapters = [];
        for (let i = 1; i <= 5; i++) {
            const id = `node-${i}`;
            const network = new MockNetworkAdapter(id, cluster);
            const storage = createMockStorage();
            const logger = createMockLogger();
            const node = new RaftNode(network, storage, logger, {
                electionTimeoutMin: 200,
                electionTimeoutMax: 400,
                heartbeatInterval: 50,
                minClusterSize: 3,
                isVoter: true
            });
            node.setPeers(['node-1', 'node-2', 'node-3', 'node-4', 'node-5'].filter(n => n !== id));
            nodes.push(node);
            adapters.push(network);
        }
    });

    afterEach(async () => {
        for (const node of nodes) await node.stop();
    });

    test('Cluster should recover from a majority/minority partition (Split Brain)', (done) => {
        // 1. Start all nodes and wait for a leader
        nodes.forEach(n => n.start());

        setTimeout(async () => {
            const originalLeader = nodes.find(n => n.state === RaftState.LEADER);
            expect(originalLeader).toBeDefined();

            // 2. Create partition: Group A (3 nodes), Group B (2 nodes including original leader)
            // Block all communication between Group A and Group B
            const origId = originalLeader!.network.getNodeID();
            const others = nodes.map(n => n.network.getNodeID()).filter(id => id !== origId);
            const groupB = [origId, others[0]];
            const groupA = [others[1], others[2], others[3]];

            adapters.forEach(a => {
                if (groupA.includes(a.getNodeID())) {
                    groupB.forEach(bID => a.block(bID));
                } else {
                    groupA.forEach(aID => a.block(aID));
                }
            });

            // 3. Wait for new election in the majority partition if leader was in minority
            setTimeout(async () => {
                const leaderA = nodes.filter(n => groupA.includes(n.network.getNodeID()) && n.state === RaftState.LEADER);
                const leaderB = nodes.filter(n => groupB.includes(n.network.getNodeID()) && n.state === RaftState.LEADER);

                expect(leaderA.length).toBe(1); // Group A should have a new leader (quorum of 3)
                expect(leaderB.length).toBe(1); // Group B retains the isolated old leader

                // 4. Propose data in the majority partition
                const activeLeader = leaderA[0];
                await activeLeader.propose('chaos', { val: 'quorum-data' });

                // 5. Heal the partition
                adapters.forEach(a => a.clearBlocks());

                // 6. Verify convergence
                setTimeout(async () => {
                    let allHaveData = true;
                    for (const n of nodes) {
                        const lastIndex = await n.raftLog.getLastLogIndex();
                        if (lastIndex < 1) allHaveData = false;
                    }
                    
                    const allTermsMatch = nodes.every(n => n.currentTerm >= activeLeader.currentTerm);
                    
                    if (allHaveData && allTermsMatch) {
                        done();
                    } else {
                        // Final retry
                        setTimeout(async () => {
                            let finalCheck = true;
                            for (const n of nodes) {
                                if (await n.raftLog.getLastLogIndex() < 1) finalCheck = false;
                            }
                            if (finalCheck) done();
                            else throw new Error('Data did not propagate after healing');
                        }, 2000);
                    }
                }, 2000);
            }, 1000);
        }, 1000);
    }, 15000);
});
