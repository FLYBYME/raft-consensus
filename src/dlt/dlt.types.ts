// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Transaction<T = any> {
    txID: string;
    prevTxID: string | null;
    term: number;
    index: number;
    timestamp: number;
    nodeID: string;
    payload: T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface LedgerEntry<T = any> {
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
