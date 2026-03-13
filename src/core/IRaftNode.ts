import { RaftState } from './raft.types';
import { RaftLog } from './RaftLog';
import { INetworkAdapter } from '../interfaces/INetworkAdapter';
import { RaftConfig } from '../interfaces/RaftConfig';
import { ILogger } from '../interfaces/ILogger';

export interface IRaftNode {
    state: RaftState;
    currentTerm: number;
    votedFor: string | null;
    commitIndex: number;
    lastApplied: number;
    currentLeaderID: string | null;
    
    raftLog: RaftLog;
    network: INetworkAdapter;
    config: RaftConfig;
    logger: ILogger;

    // Volatile Leader State
    nextIndex: Map<string, number>;
    matchIndex: Map<string, number>;
    votesReceived: Set<string>;
    isReadyEmitted: boolean;

    getPeers(): string[];
    persistState(): void;
    stepDown(term: number): void;
    becomeLeader(): Promise<void>;
    applyCommitted(): Promise<void>;
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emit(event: string, ...args: any[]): boolean;
}
