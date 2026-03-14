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
    payload: unknown;
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

export interface InstallSnapshotArgs {
    term: number;
    leaderId: string;
    lastIncludedIndex: number;
    lastIncludedTerm: number;
    data: any; 
}

export interface InstallSnapshotReply {
    term: number;
}
