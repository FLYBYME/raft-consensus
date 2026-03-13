import { ILogger } from '../interfaces/ILogger';
import { IRaftNode } from './IRaftNode';
import { RaftState, RequestVoteArgs, RequestVoteReply, AppendEntriesArgs, AppendEntriesReply, InstallSnapshotArgs, InstallSnapshotReply } from './raft.types';

export class RaftRPCManager {
    constructor(
        private logger: ILogger,
        private node: IRaftNode
    ) { }

    async handleRequestVote(args: RequestVoteArgs, senderID: string): Promise<RequestVoteReply> {
        this.logger.debug(`[Raft] Received RequestVote from ${senderID} for term ${args.term} (PreVote: ${args.isPreVote})`);

        // 1. If real vote and term is higher, step down
        if (!args.isPreVote && args.term > this.node.currentTerm) {
            this.logger.info(`[Raft] RequestVote term ${args.term} > current term ${this.node.currentTerm}. Stepping down.`);
            this.node.stepDown(args.term);
        }

        const reply: RequestVoteReply = { term: this.node.currentTerm, voteGranted: false };

        if (args.term < this.node.currentTerm) {
             return reply;
        }

        // 2. Log completeness check
        const localLastLogIndex = await this.node.raftLog.getLastLogIndex();
        const localLastLogTerm = await this.node.raftLog.getLastLogTerm();
        const logIsUpToDate = (args.lastLogTerm > localLastLogTerm) ||
            (args.lastLogTerm === localLastLogTerm && args.lastLogIndex >= localLastLogIndex);

        if (args.isPreVote) {
            // Pre-Vote logic: ignore current term/votedFor, just check log and term
            if (args.term >= this.node.currentTerm && logIsUpToDate) {
                reply.voteGranted = true;
            }
        } else {
             // Real Vote logic
            if ((this.node.votedFor === null || this.node.votedFor === args.candidateId) && logIsUpToDate) {
                this.logger.info(`[Raft] Granting vote to ${args.candidateId} for term ${this.node.currentTerm}`);
                reply.voteGranted = true;
                this.node.votedFor = args.candidateId;
                await this.node.persistState();
                
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const nodeAny = this.node as any;
                if (nodeAny.electionManager) nodeAny.electionManager.resetElectionTimer();

                this.node.emit('vote-granted', { candidateId: args.candidateId, term: this.node.currentTerm });
            } else {
                this.node.emit('vote-denied', { candidateId: args.candidateId, term: this.node.currentTerm, reason: logIsUpToDate ? 'Already voted' : 'Log not up to date' });
            }
        }

        return reply;
    }

    async handleAppendEntries(args: AppendEntriesArgs, senderID: string): Promise<AppendEntriesReply> {
        if (args.entries.length > 0) {
            this.logger.debug(`[Raft] Received ${args.entries.length} AppendEntries from ${senderID} (term: ${args.term})`);
        }
        if (args.term > this.node.currentTerm) {
            this.logger.info(`[Raft] AppendEntries term ${args.term} > current term ${this.node.currentTerm}. Stepping down.`);
            this.node.stepDown(args.term);
        }

        const reply: AppendEntriesReply = { term: this.node.currentTerm, success: false, matchIndex: 0 };

        if (args.term < this.node.currentTerm) {
            this.logger.debug(`[Raft] Rejecting AppendEntries from ${senderID}. Term ${args.term} < ${this.node.currentTerm}`);
            return reply;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nodeAny = this.node as any;
        if (nodeAny.electionManager) nodeAny.electionManager.resetElectionTimer();

        this.node.currentLeaderID = args.leaderId;
        if (this.node.state !== RaftState.FOLLOWER) {
            this.node.state = RaftState.FOLLOWER;
            this.node.emit('state-changed', { newState: RaftState.FOLLOWER, term: this.node.currentTerm });
        }

        // Emit ready when a leader is first recognized
        if (!this.node.isReadyEmitted && this.node.currentLeaderID) {
            this.node.isReadyEmitted = true;
            this.node.emit('ready', { leaderID: this.node.currentLeaderID, term: this.node.currentTerm });
        }

        // Log Consistency Check
        if (args.prevLogIndex > 0) {
            const localTerm = await this.node.raftLog.getTerm(args.prevLogIndex);
            if (localTerm !== args.prevLogTerm) {
                this.logger.debug(`[Raft] Log consistency check failed for ${senderID}. PrevIndex: ${args.prevLogIndex}, LocalTerm: ${localTerm}, ArgsTerm: ${args.prevLogTerm}`);
                return reply;
            }
        }

        // 3. Log conflict resolution: Delete mismatched suffix
        for (const entry of args.entries) {
            const existingTerm = await this.node.raftLog.getTerm(entry.index);
            if (existingTerm !== 0 && existingTerm !== entry.term) {
                this.logger.warn(`[Raft] Log conflict detected at index ${entry.index}. Local term ${existingTerm}, leader term ${entry.term}. Truncating log.`);
                await this.node.raftLog.truncateSuffix(entry.index);
                break;
            }
        }

        // 4. Append any new entries not already in the log
        const newEntries = [];
        for (const e of args.entries) {
            if (await this.node.raftLog.getTerm(e.index) === 0) {
                newEntries.push(e);
            }
        }
        
        if (newEntries.length > 0) {
            this.logger.debug(`[Raft] Appending ${newEntries.length} new entries to log.`);
            await this.node.raftLog.append(newEntries);
        }

        // 5. Update commit index
        if (args.leaderCommit > this.node.commitIndex) {
            const oldCommit = this.node.commitIndex;
            this.node.commitIndex = Math.min(args.leaderCommit, await this.node.raftLog.getLastLogIndex());
            if (this.node.commitIndex > oldCommit) {
                this.logger.debug(`[Raft] Commit index advanced from ${oldCommit} to ${this.node.commitIndex}`);
                await this.node.applyCommitted();
            }
        }

        reply.success = true;
        reply.matchIndex = args.prevLogIndex + args.entries.length;
        
        return reply;
    }

    /**
     * Handles InstallSnapshot RPC from leader.
     */
    async handleInstallSnapshot(args: InstallSnapshotArgs, senderID: string): Promise<InstallSnapshotReply> {
        this.logger.debug(`[Raft] Received InstallSnapshot from ${senderID} (term: ${args.term})`);

        const reply: InstallSnapshotReply = { term: this.node.currentTerm };

        if (args.term < this.node.currentTerm) {
            return reply;
        }

        if (args.term > this.node.currentTerm) {
            this.node.stepDown(args.term);
        }

        // Reset election timer and acknowledge leader
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nodeAny = this.node as any;
        if (nodeAny.electionManager) nodeAny.electionManager.resetElectionTimer();
        this.node.currentLeaderID = args.leaderId;
        if (this.node.state !== RaftState.FOLLOWER) {
            this.node.state = RaftState.FOLLOWER;
            this.node.emit('state-changed', { newState: RaftState.FOLLOWER, term: this.node.currentTerm });
        }

        // Save the snapshot to the local disk
        await this.node.raftLog.createSnapshot(args.lastIncludedIndex, args.lastIncludedTerm, args.data);

        // If existing log entries overlap with the snapshot, delete them
        await this.node.raftLog.compact(args.lastIncludedIndex);

        // Fast-forward commit index
        this.node.commitIndex = Math.max(this.node.commitIndex, args.lastIncludedIndex);
        this.node.lastApplied = Math.max(this.node.lastApplied, args.lastIncludedIndex);

        reply.term = this.node.currentTerm;
        return reply;
    }
}
