import { ILogger } from '../interfaces/ILogger';
import { IRaftNode } from './IRaftNode';
import { RaftState, RequestVoteArgs, RequestVoteReply, AppendEntriesArgs, AppendEntriesReply } from './raft.types';

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
        const localLastLogIndex = this.node.raftLog.getLastLogIndex();
        const localLastLogTerm = this.node.raftLog.getLastLogTerm();
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
                this.node.persistState();
                
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
            this.logger.info(`[Raft] Recognized leader ${args.leaderId} for term ${this.node.currentTerm}. Switching to FOLLOWER.`);
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
            const localTerm = this.node.raftLog.getTerm(args.prevLogIndex);
            // If localTerm is 0, it means entry doesn't exist (index out of bounds), so mismatch.
            // If localTerm != args.prevLogTerm, mismatch.
            if (localTerm !== args.prevLogTerm) {
                this.logger.debug(`[Raft] Log consistency check failed for ${senderID}. PrevIndex: ${args.prevLogIndex}, LocalTerm: ${localTerm}, ArgsTerm: ${args.prevLogTerm}`);
                return reply;
            }
        }

        // 3. Log conflict resolution: Delete mismatched suffix
        // We iterate through entries provided by leader. If we have an entry at that index but term differs, we truncate from there.
        for (const entry of args.entries) {
            const existingTerm = this.node.raftLog.getTerm(entry.index);
            if (existingTerm !== 0 && existingTerm !== entry.term) {
                this.logger.warn(`[Raft] Log conflict detected at index ${entry.index}. Local term ${existingTerm}, leader term ${entry.term}. Truncating log.`);
                this.node.raftLog.truncateSuffix(entry.index);
                break;
            }
        }

        // 4. Append any new entries not already in the log
        // If we didn't truncate, we might still have entries that match. We only append what we don't have.
        // Or if we truncated, we append everything from that point.
        // Simple logic: filter entries where getTerm(index) == 0 (meaning they don't exist).
        // Since we already handled conflicts, existing entries MUST match terms.
        const newEntries = args.entries.filter(e => this.node.raftLog.getTerm(e.index) === 0);
        if (newEntries.length > 0) {
            this.logger.debug(`[Raft] Appending ${newEntries.length} new entries to log.`);
            this.node.raftLog.append(newEntries);
        }

        // 5. Update commit index
        if (args.leaderCommit > this.node.commitIndex) {
            const oldCommit = this.node.commitIndex;
            // Leader commit might be higher than our last log index if we are catching up.
            // Commit index is min(leaderCommit, index of last new entry).
            // Actually, Raft paper says: min(leaderCommit, index of last new entry) is for *request*.
            // The standard is min(leaderCommit, lastLogIndex).
            this.node.commitIndex = Math.min(args.leaderCommit, this.node.raftLog.getLastLogIndex());
            if (this.node.commitIndex > oldCommit) {
                this.logger.debug(`[Raft] Commit index advanced from ${oldCommit} to ${this.node.commitIndex}`);
                await this.node.applyCommitted();
            }
        }

        reply.success = true;
        // Optimization: return the last index we have, so leader can update nextIndex efficiently?
        // Standard Raft just returns success.
        // Original code: reply.matchIndex = args.prevLogIndex + args.entries.length;
        reply.matchIndex = args.prevLogIndex + args.entries.length;
        
        return reply;
    }
}
