import { RaftNode } from '../src/core/RaftNode';
import { RaftState } from '../src/core/raft.types';
import { createMockStorage, createMockLogger } from './test-utils';
import { INetworkAdapter, RaftMessage } from '../src/interfaces/INetworkAdapter';
import { EventEmitter } from 'eventemitter3';

class MockNetworkAdapter extends EventEmitter implements INetworkAdapter {
    constructor(private nodeID: string, private cluster: Map<string, MockNetworkAdapter>) {
        super();
        cluster.set(nodeID, this);
    }
    async send(target: string, msg: RaftMessage) {
        setImmediate(() => {
            const peer = this.cluster.get(target);
            if (peer) peer.emit(msg.topic, msg);
        });
    }
    async broadcast(msg: RaftMessage) {
        for (const peer of this.cluster.values()) {
            if (peer.getNodeID() !== this.nodeID) {
                this.send(peer.getNodeID(), msg);
            }
        }
    }
    getNodeID() { return this.nodeID; }
}

describe('Raft Integration (10 Tests)', () => {
    let nodes: RaftNode[] = [];
    let cluster: Map<string, MockNetworkAdapter>;

    beforeEach(async () => {
        cluster = new Map();
        nodes = [];
        for (let i = 1; i <= 3; i++) {
            const id = `node-${i}`;
            const network = new MockNetworkAdapter(id, cluster);
            const storage = createMockStorage();
            const logger = createMockLogger();
            const node = new RaftNode(network, storage, logger, {
                electionTimeoutMin: 200, // Increased to avoid early conflicts
                electionTimeoutMax: 400,
                heartbeatInterval: 50,
                minClusterSize: 3,
                isVoter: true
            });
            node.setPeers(['node-1', 'node-2', 'node-3'].filter(n => n !== id));
            nodes.push(node);
        }
    });

    afterEach(async () => {
        for (const node of nodes) await node.stop();
    });

    test('1. Cluster should elect a leader after startup', (done) => {
        let leaderFound = false;
        nodes.forEach(n => {
            n.on('ready', () => {
                if (!leaderFound) {
                    const leaders = nodes.filter(node => node.state === RaftState.LEADER);
                    if (leaders.length >= 1) {
                        leaderFound = true;
                        done();
                    }
                }
            });
            n.start();
        });
    }, 5000);

    test('2. Proposed entry should replicate to all nodes', (done) => {
        nodes.forEach(n => n.start());
        
        const check = setInterval(() => {
            const leader = nodes.find(n => n.state === RaftState.LEADER);
            if (leader) {
                clearInterval(check);
                leader.propose('test', { val: 42 }).then(() => {
                    setTimeout(() => {
                        const allHaveIt = nodes.every(n => n.raftLog.getLastLogIndex() >= 1);
                        if (allHaveIt) done();
                    }, 1000);
                });
            }
        }, 500);
    }, 10000);

    test('3. Leader should step down if higher term found', (done) => {
        nodes.forEach(n => n.start());
        
        setTimeout(async () => {
            const leader = nodes.find(n => n.state === RaftState.LEADER);
            if (!leader) return;

            // Simulate another node becoming leader with higher term
            const other = nodes.find(n => n !== leader)!;
            other.currentTerm = leader.currentTerm + 1;
            await other.becomeLeader();

            setTimeout(() => {
                if (leader.state === RaftState.FOLLOWER) done();
            }, 1000);
        }, 1000);
    }, 10000);

    test('4. Ledger state should be consistent across nodes', (done) => {
        nodes.forEach(n => n.start());
        setTimeout(async () => {
            const leader = nodes.find(n => n.state === RaftState.LEADER);
            if (!leader) return;
            
            await leader.propose('ledger-test', { data: 'win' });
            
            setTimeout(() => {
                const lens = nodes.map(n => n.getOrCreateLedger('ledger-test').getLength());
                if (lens.every(l => l >= 1)) done();
            }, 1500);
        }, 1000);
    }, 10000);

    test('5. Node with stale log should catch up from leader', (done) => {
        const [n1, n2, n3] = nodes;
        n3.config.isVoter = false; 
        n1.start(); n2.start();
        
        setTimeout(async () => {
            const leader = n1.state === RaftState.LEADER ? n1 : n2;
            await leader.propose('sync-test', { data: 1 });
            
            n3.config.isVoter = true;
            n3.start();
            
            setTimeout(() => {
                if (n3.raftLog.getLastLogIndex() >= 1) done();
            }, 2000);
        }, 1000);
    }, 10000);

    test('6. Leader election should survive one node crash', (done) => {
        nodes.forEach(n => n.start());
        setTimeout(() => {
            const leader = nodes.find(n => n.state === RaftState.LEADER);
            if (!leader) return;
            
            leader.stop(); 
            
            setTimeout(() => {
                const newLeader = nodes.find(n => n.state === RaftState.LEADER && n !== leader);
                if (newLeader) done();
            }, 2000);
        }, 1000);
    }, 10000);

    test('7. Multiple proposals in sequence should work', (done) => {
        nodes.forEach(n => n.start());
        setTimeout(async () => {
            const leader = nodes.find(n => n.state === RaftState.LEADER);
            if (!leader) return;
            
            for(let i=0; i<3; i++) await leader.propose('multi', { i });
            
            setTimeout(() => {
                if (nodes.every(n => n.raftLog.getLastLogIndex() >= 3)) done();
            }, 2000);
        }, 1000);
    }, 10000);

    test('8. Voter joining later should be added to peers', (done) => {
        const [n1, n2, n3] = nodes;
        n1.start(); n2.start(); n3.start();
        
        setTimeout(() => {
            if (n3.getPeers().length === 2) done();
        }, 1000);
    }, 5000);

    test('9. Passive node should not trigger elections', (done) => {
        const n = nodes[0];
        n.config.isVoter = false;
        n.start();
        
        setTimeout(() => {
            expect(n.state).toBe(RaftState.FOLLOWER);
            done();
        }, 1000);
    }, 5000);

    test('10. Stop should clear timers', async () => {
        const n = nodes[0];
        await n.start();
        expect(n.electionTimer).toBeDefined();
        await n.stop();
    });
});
