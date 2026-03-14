export interface Transaction<T = unknown> {
    txID: string;
    prevTxID: string | null;
    term: number;
    index: number;
    timestamp: number;
    nodeID: string;
    payload: T;
}

export interface LedgerEntry<T = unknown> {
    term: number;
    timestamp?: number;
    nodeID?: string;
    payload: T;
}

export class LogConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LogConflictError';
    }
}
