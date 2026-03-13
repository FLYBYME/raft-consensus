import { EventEmitter } from 'eventemitter3';
import { IRaftNode } from './IRaftNode';
import { RaftState, LogEntry } from './raft.types';
import { INetworkAdapter, RaftMessage } from '../interfaces/INetworkAdapter';
import { IStorageAdapter } from '../interfaces/IStorageAdapter';
import { ILogger } from '../interfaces/ILogger';
import { RaftConfig } from '../interfaces/RaftConfig';
import { RaftLog } from './RaftLog';
import { ElectionManager } from './ElectionManager';
import { ReplicationManager } from './ReplicationManager';
import { RaftRPCManager } from './RaftRPCManager';
import { DistributedLedger } from '../dlt/DistributedLedger';

export class RaftNode extends EventEmitter implements IRaftNode {
    // Persistent State
    public currentTerm = 0;
    public votedFor: string | null = null;
    public raftLog: RaftLog;

    // Volatile State
    public state: RaftState = RaftState.FOLLOWER;
    public commitIndex = 0;
    public lastApplied = 0;
    public currentLeaderID: string | null = null;

    // Leader Volatile State
    public nextIndex: Map<string, number> = new Map();
    public matchIndex: Map<string, number> = new Map();
    public votesReceived: Set<string> = new Set();
    public isReadyEmitted = false;

    // Components
    public electionManager: ElectionManager;
    public replicationManager: ReplicationManager;
    public rpcManager: RaftRPCManager;

    // Timers
    public electionTimer?: NodeJS.Timeout;
    public heartbeatTimer?: NodeJS.Timeout;

    private ledgers: Map<string, DistributedLedger> = new Map();
    private peers: Set<string> = new Set();

    constructor(
        public network: INetworkAdapter,
        public storage: IStorageAdapter,
        public logger: ILogger,
        public config: RaftConfig
    ) {
        super();
        this.logger = logger.child({ name: 'RaftNode' });
        this.raftLog = new RaftLog(storage);
        
        this.electionManager = new ElectionManager(this.logger, this);
        this.replicationManager = new ReplicationManager(this.logger, this);
        this.rpcManager = new RaftRPCManager(this.logger, this);
    }

    async start(): Promise<void> {
        // Load persistent state
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stateRow = await this.storage.get('SELECT current_term, voted_for FROM raft_state WHERE id = 1') as any;
        if (stateRow) {
            this.currentTerm = stateRow.current_term;
            this.votedFor = stateRow.voted_for;
        } else {
             // Initialize state table if needed or just handle empty
             await this.storage.run('CREATE TABLE IF NOT EXISTS raft_state (id INTEGER PRIMARY KEY, current_term INTEGER, voted_for TEXT)');
             await this.storage.run('INSERT OR IGNORE INTO raft_state (id, current_term, voted_for) VALUES (1, 0, NULL)');
        }

        this.registerHandlers();
        
        if (this.config.isVoter === false) {
             this.logger.info('Raft started in PASSIVE mode');
             return;
        }

        this.resetElectionTimer();
        this.logger.info('Raft started in FOLLOWER state', { term: this.currentTerm });
    }

    async stop(): Promise<void> {
        if (this.electionTimer) clearTimeout(this.electionTimer);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    }

    public addPeer(nodeID: string): void {
        this.peers.add(nodeID);
    }

    public removePeer(nodeID: string): void {
        this.peers.delete(nodeID);
    }

    public getPeers(): string[] {
        return Array.from(this.peers);
    }

    public setPeers(peers: string[]): void {
        this.peers = new Set(peers);
    }

    public async persistState(): Promise<void> {
        await this.storage.run('UPDATE raft_state SET current_term = ?, voted_for = ? WHERE id = 1', [this.currentTerm, this.votedFor]);
    }

    private registerHandlers(): void {
        this.network.on('vote-req', async (msg: RaftMessage) => {
             const reply = await this.rpcManager.handleRequestVote(msg.data, msg.senderNodeID);
             this.network.send(msg.senderNodeID, {
                 topic: 'vote-res',
                 data: reply,
                 senderNodeID: this.network.getNodeID(),
                 meta: msg.meta
             });
        });

        this.network.on('vote-res', (msg: RaftMessage) => {
             this.handleVoteResponse(msg.data, msg.senderNodeID);
        });

        this.network.on('append-req', async (msg: RaftMessage) => {
             const reply = await this.rpcManager.handleAppendEntries(msg.data, msg.senderNodeID);
             this.network.send(msg.senderNodeID, {
                 topic: 'append-res',
                 data: reply,
                 senderNodeID: this.network.getNodeID(),
                 meta: msg.meta
             });
        });

        this.network.on('append-res', (msg: RaftMessage) => {
             this.replicationManager.handleAppendResponse(msg.data, msg.senderNodeID);
        });
    }

    public stepDown(term: number): void {
        const wasLeader = this.state === RaftState.LEADER;
        this.currentTerm = term;
        this.state = RaftState.FOLLOWER;
        this.votedFor = null;
        this.currentLeaderID = null;
        this.isReadyEmitted = false;
        this.persistState(); // Fire and forget or await? RAFT says we should persist before proceeding.
        
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.resetElectionTimer();
        
        this.emit('follower', { term });
        if (wasLeader) {
             this.network.broadcast({
                 topic: 'leader-stepdown',
                 data: { term, nodeID: this.network.getNodeID() },
                 senderNodeID: this.network.getNodeID()
             });
        }
        this.emit('state-changed', { newState: RaftState.FOLLOWER, term });
        this.logger.info('Stepped down to FOLLOWER', { term });
    }

    public resetElectionTimer(): void {
        this.electionManager.resetElectionTimer();
    }

    private async handleVoteResponse(reply: any, senderID: string): Promise<void> {
        if (this.state !== RaftState.CANDIDATE && this.state !== RaftState.PRE_CANDIDATE) return;
        
        if (reply.term > this.currentTerm) {
             this.stepDown(reply.term);
             return;
        }

        if (reply.voteGranted) {
             this.votesReceived.add(senderID);
             const peers = this.getPeers();
             const totalNodes = peers.length + 1;
             const quorum = Math.floor(totalNodes / 2) + 1;
             
             if (this.votesReceived.size >= quorum) {
                 if (this.state === RaftState.PRE_CANDIDATE) {
                     await this.electionManager.becomeCandidate();
                 } else {
                     await this.becomeLeader();
                 }
             }
        }
    }

    public async becomeLeader(): Promise<void> {
        this.state = RaftState.LEADER;
        if (this.electionTimer) clearTimeout(this.electionTimer);
        this.logger.warn('Elected LEADER', { term: this.currentTerm });
        
        this.emit('leader-elected', { leaderID: this.network.getNodeID(), term: this.currentTerm });
        this.network.broadcast({
            topic: 'leader-elected',
            data: { term: this.currentTerm, nodeID: this.network.getNodeID() },
            senderNodeID: this.network.getNodeID()
        });
        this.emit('state-changed', { newState: RaftState.LEADER, term: this.currentTerm });

        if (!this.isReadyEmitted) {
             this.isReadyEmitted = true;
             this.emit('ready', { leaderID: this.network.getNodeID(), term: this.currentTerm });
        }

        const lastLogIndex = await this.raftLog.getLastLogIndex();
        const peers = this.getPeers();
        for (const peer of peers) {
             this.nextIndex.set(peer, lastLogIndex + 1);
             this.matchIndex.set(peer, 0);
        }

        this.replicationManager.startHeartbeats();
        this.replicationManager.sendAppendEntriesToAll();
    }

    public async applyCommitted(): Promise<void> {
        while (this.lastApplied < this.commitIndex) {
            this.lastApplied++;
            const entry = await this.raftLog.getEntry(this.lastApplied);
            if (entry) {
                const ledger = this.ledgers.get(entry.namespace);
                if (ledger) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const tx: any = {
                        txID: (entry as any).id || (entry as any).txID || `temp-${entry.index}-${entry.term}`,
                        prevTxID: (entry as any).prevID || (entry as any).prevTxID || null,
                        index: entry.index,
                        term: entry.term,
                        timestamp: (entry as any).timestamp || Date.now(),
                        nodeID: (entry as any).nodeID || 'unknown',
                        payload: entry.payload
                    };

                    await ledger.appendLocally(tx).catch((err: Error) => {
                         this.logger.error('Failed to apply committed entry to ledger', {
                             error: err.message,
                             namespace: entry.namespace,
                             index: entry.index
                         });
                    });
                }
                // Emit commit event
                this.emit(`commit:${entry.namespace}`, { entry });
                this.emit('commit', { entry });
            }
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public async propose(namespace: string, payload: any): Promise<boolean> {
        if (this.state !== RaftState.LEADER) return false;

        const newIndex = await this.raftLog.getLastLogIndex() + 1;
        const entry: LogEntry = { term: this.currentTerm, index: newIndex, namespace, payload };

        this.logger.debug('Proposing new entry', { namespace, index: newIndex });

        await this.raftLog.append([entry]);
        this.matchIndex.set(this.network.getNodeID(), newIndex);
        
        this.replicationManager.sendAppendEntriesToAll();
        
        // If single node cluster (1 node total = 0 peers)
        if (this.getPeers().length === 0) {
             await this.replicationManager.advanceLeaderCommitIndex();
        }
        
        return true;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public getOrCreateLedger<T = any>(namespace: string): DistributedLedger<T> {
        if (!this.ledgers.has(namespace)) {
            const ledger = new DistributedLedger<T>(namespace, this.storage);
            this.ledgers.set(namespace, ledger);
        }
        return this.ledgers.get(namespace)! as DistributedLedger<T>;
    }
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public registerLedger(ledger: DistributedLedger<any>): void {
        this.ledgers.set(ledger.namespace, ledger);
    }
}
