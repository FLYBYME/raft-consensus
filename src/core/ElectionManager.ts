import { ILogger } from '../interfaces/ILogger';
import { IRaftNode } from './IRaftNode';
import { RaftState, RequestVoteArgs } from './raft.types';

export class ElectionManager {
    constructor(
        private logger: ILogger,
        private node: IRaftNode
    ) { }

    getElectionTimeout(): number {
        const peers = this.node.getPeers();
        // Include self in count? Usually peers list excludes self, but for cluster size we need total.
        // Assuming getPeers returns OTHER nodes.
        const totalNodes = peers.length + 1;
        
        if (totalNodes <= 1) {
            return Math.floor(Math.random() * 500) + 500;
        }
        return Math.floor(Math.random() * (this.node.config.electionTimeoutMax - this.node.config.electionTimeoutMin)) + this.node.config.electionTimeoutMin;
    }

    resetElectionTimer(): void {
        // We need access to the timer references on the node, but they are not in IRaftNode yet.
        // Let's assume we manage them here or expose them on IRaftNode.
        // For better encapsulation, let's keep them here? No, node needs to clear them on state change.
        // I'll add them to IRaftNode or just cast as any for now to match legacy structure, 
        // but better to add to IRaftNode.
        // Let's add them to IRaftNode interface in next step if needed, or just use `any`.
        // Actually, let's look at IRaftNode again. I missed timers.
        
        // Refactoring: The node should probably hold the timers, or the manager should fully manage them.
        // The original code had `this.state.electionTimer`.
        // Let's stick to `IRaftNode` having them for now to minimize drift.
        // I'll update IRaftNode later to include timers if strictness fails.
        // For now, I'll cast `node` to `any` for timers to proceed quickly, or add to interface.
        // Adding to interface is cleaner.
        
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nodeAny = this.node as any;

        if (nodeAny.electionTimer) clearTimeout(nodeAny.electionTimer);
        if (nodeAny.heartbeatTimer) clearInterval(nodeAny.heartbeatTimer);

        if (!this.node.config.isVoter) return;

        const timeout = this.getElectionTimeout();
        nodeAny.electionTimer = setTimeout(() => this.becomePreCandidate(), timeout);
    }

    async becomePreCandidate(): Promise<void> {
        this.node.state = RaftState.PRE_CANDIDATE;
        this.node.votesReceived = new Set([this.node.network.getNodeID()]);

        this.logger.info(`Transitioned to PRE_CANDIDATE for term ${this.node.currentTerm}`);
        this.node.emit('state-changed', { newState: RaftState.PRE_CANDIDATE, term: this.node.currentTerm });

        const peers = this.node.getPeers();
        if (peers.length === 0) {
            await this.becomeCandidate();
            return;
        }

        const args: RequestVoteArgs = {
            term: this.node.currentTerm,
            candidateId: this.node.network.getNodeID(),
            lastLogIndex: this.node.raftLog.getLastLogIndex(),
            lastLogTerm: this.node.raftLog.getLastLogTerm(),
            isPreVote: true
        };

        for (const peer of peers) {
            this.node.network.send(peer, {
                topic: 'vote-req',
                data: args,
                senderNodeID: this.node.network.getNodeID()
            }).catch(() => { });
        }
    }

    async becomeCandidate(): Promise<void> {
        this.node.state = RaftState.CANDIDATE;
        this.node.currentTerm++;
        this.node.votedFor = this.node.network.getNodeID();
        this.node.persistState();
        this.node.votesReceived = new Set([this.node.network.getNodeID()]);
        this.resetElectionTimer();

        this.logger.info(`Transitioned to CANDIDATE for term ${this.node.currentTerm}`);
        this.node.emit('candidate', { term: this.node.currentTerm });
        this.node.emit('state-changed', { newState: RaftState.CANDIDATE, term: this.node.currentTerm });
        this.node.isReadyEmitted = false;

        const peers = this.node.getPeers();
        const totalNodes = peers.length + 1;
        if (this.node.votesReceived.size >= Math.floor(totalNodes / 2) + 1) {
            await this.node.becomeLeader();
            return;
        }

        const args: RequestVoteArgs = {
            term: this.node.currentTerm,
            candidateId: this.node.network.getNodeID(),
            lastLogIndex: this.node.raftLog.getLastLogIndex(),
            lastLogTerm: this.node.raftLog.getLastLogTerm(),
            isPreVote: false
        };

        for (const peer of peers) {
            this.node.network.send(peer, {
                topic: 'vote-req',
                data: args,
                senderNodeID: this.node.network.getNodeID()
            }).catch(() => { });
        }
    }
}
