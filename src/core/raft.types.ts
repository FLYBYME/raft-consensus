export enum RaftState {
    FOLLOWER = 'FOLLOWER',
    PRE_CANDIDATE = 'PRE_CANDIDATE',
    CANDIDATE = 'CANDIDATE',
    LEADER = 'LEADER'
}

export interface LogEntry {
    term: number;
    index: number;
    namespace: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: any;
}

export interface RequestVoteArgs {
    term: number;
    candidateId: string;
    lastLogIndex: number;
    lastLogTerm: number;
    isPreVote?: boolean;
}

export interface RequestVoteReply {
    term: number;
    voteGranted: boolean;
}

export interface AppendEntriesArgs {
    term: number;
    leaderId: string;
    prevLogIndex: number;
    prevLogTerm: number;
    entries: LogEntry[];
    leaderCommit: number;
}

export interface AppendEntriesReply {
    term: number;
    success: boolean;
    matchIndex: number;
}
