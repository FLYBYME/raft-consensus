export interface RaftConfig {
    electionTimeoutMin: number;
    electionTimeoutMax: number;
    heartbeatInterval: number;
    minClusterSize: number;
    /**
     * Optional: If true, this node participates in consensus.
     * Default: true
     */
    isVoter?: boolean; 
}
