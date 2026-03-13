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
        const totalNodes = peers.length + 1;
        
        if (totalNodes <= 1) {
            return Math.floor(Math.random() * 500) + 500;
        }
        return Math.floor(Math.random() * (this.node.config.electionTimeoutMax - this.node.config.electionTimeoutMin)) + this.node.config.electionTimeoutMin;
    }

    resetElectionTimer(): void {
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
            lastLogIndex: await this.node.raftLog.getLastLogIndex(),
            lastLogTerm: await this.node.raftLog.getLastLogTerm(),
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
        await this.node.persistState();
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
            lastLogIndex: await this.node.raftLog.getLastLogIndex(),
            lastLogTerm: await this.node.raftLog.getLastLogTerm(),
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
