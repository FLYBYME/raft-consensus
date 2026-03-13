import { ILogger } from '../interfaces/ILogger';
import { IRaftNode } from './IRaftNode';
import { RaftState, AppendEntriesArgs, AppendEntriesReply, InstallSnapshotArgs, InstallSnapshotReply } from './raft.types';

export class ReplicationManager {
    constructor(
        private logger: ILogger,
        private node: IRaftNode
    ) { }

    startHeartbeats(): void {
        this.logger.debug(`[Raft] Starting heartbeats (interval: ${this.node.config.heartbeatInterval}ms)`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nodeAny = this.node as any;
        if (nodeAny.heartbeatTimer) clearInterval(nodeAny.heartbeatTimer);
        nodeAny.heartbeatTimer = setInterval(() => this.sendAppendEntriesToAll(), this.node.config.heartbeatInterval);
    }

    sendAppendEntriesToAll(): void {
        if (this.node.state !== RaftState.LEADER) return;
        const peers = this.node.getPeers();
        for (const peer of peers) {
            this.sendAppendEntriesToPeer(peer);
        }
    }

    async sendAppendEntriesToPeer(peerID: string): Promise<void> {
        const nextIdx = this.node.nextIndex.get(peerID) || 1;
        const snapshot = await this.node.raftLog.getLatestSnapshot();

        // If the follower needs logs that we've already compacted, send the snapshot
        if (snapshot && nextIdx <= snapshot.last_index) {
            this.logger.info(`[Raft] Follower ${peerID} is too far behind. Sending InstallSnapshot.`);
            const args: InstallSnapshotArgs = {
                term: this.node.currentTerm,
                leaderId: this.node.network.getNodeID(),
                lastIncludedIndex: snapshot.last_index,
                lastIncludedTerm: snapshot.last_term,
                data: snapshot.data
            };

            this.node.network.send(peerID, {
                topic: 'snapshot-req',
                data: args,
                senderNodeID: this.node.network.getNodeID()
            }).catch(() => { });
            return;
        }

        const prevLogIndex = nextIdx - 1;
        const prevLogTerm = await this.node.raftLog.getTerm(prevLogIndex);
        const entries = await this.node.raftLog.getEntriesFrom(nextIdx);

        const args: AppendEntriesArgs = {
            term: this.node.currentTerm,
            leaderId: this.node.network.getNodeID(),
            prevLogIndex,
            prevLogTerm,
            entries,
            leaderCommit: this.node.commitIndex
        };

        if (entries.length > 0) {
            this.logger.debug(`[Raft] Sending ${entries.length} log entries to ${peerID} (prevIndex: ${prevLogIndex})`);
        }
        
        this.node.network.send(peerID, {
            topic: 'append-req',
            data: args,
            senderNodeID: this.node.network.getNodeID()
        }).catch(() => { });
    }

    handleAppendResponse(reply: AppendEntriesReply, senderID: string): void {
        if (this.node.state !== RaftState.LEADER) return;

        if (reply.term > this.node.currentTerm) {
            this.logger.info(`[Raft] AppendResponse term ${reply.term} > current term ${this.node.currentTerm}. Stepping down.`);
            this.node.stepDown(reply.term);
            return;
        }

        if (reply.success) {
            this.node.matchIndex.set(senderID, reply.matchIndex);
            this.node.nextIndex.set(senderID, reply.matchIndex + 1);
            this.advanceLeaderCommitIndex();
        } else {
            const currentNext = this.node.nextIndex.get(senderID) || 1;
            this.logger.debug(`[Raft] Log inconsistency for ${senderID}. Decrementing nextIndex to ${Math.max(1, currentNext - 1)}`);
            this.node.nextIndex.set(senderID, Math.max(1, currentNext - 1));
            this.sendAppendEntriesToPeer(senderID);
        }
    }

    /**
     * Handles response to InstallSnapshot RPC.
     */
    handleInstallSnapshotResponse(reply: InstallSnapshotReply, senderID: string): void {
        if (this.node.state !== RaftState.LEADER) return;

        if (reply.term > this.node.currentTerm) {
            this.node.stepDown(reply.term);
            return;
        }

        // Now that they have the snapshot, update their nextIndex to start *after* it
        this.node.raftLog.getLatestSnapshot().then(snapshot => {
            if (snapshot) {
                this.node.matchIndex.set(senderID, snapshot.last_index);
                this.node.nextIndex.set(senderID, snapshot.last_index + 1);
                this.sendAppendEntriesToPeer(senderID); // Resume normal log replication
            }
        });
    }

    async advanceLeaderCommitIndex(): Promise<void> {
        const matchIndices = Array.from(this.node.matchIndex.values()) as number[];
        matchIndices.push(await this.node.raftLog.getLastLogIndex());
        matchIndices.sort((a: number, b: number) => b - a);

        const totalNodes = this.node.getPeers().length + 1;
        const quorumIndex = Math.floor(totalNodes / 2);
        
        const majorityMatchIndex = matchIndices[quorumIndex];

        if (majorityMatchIndex === undefined) return;

        if (majorityMatchIndex > this.node.commitIndex && await this.node.raftLog.getTerm(majorityMatchIndex) === this.node.currentTerm) {
            this.node.commitIndex = majorityMatchIndex;
            const entry = await this.node.raftLog.getEntry(this.node.commitIndex);
            await this.node.applyCommitted();
            this.node.network.broadcast({
                topic: 'commit',
                data: {
                    index: this.node.commitIndex,
                    term: this.node.currentTerm,
                    namespace: entry?.namespace
                },
                senderNodeID: this.node.network.getNodeID()
            });
        }
    }
}
