/**
 * IStorageResult - Standard result for write operations.
 */
export interface IStorageResult {
    lastInsertId?: number | string;
    changes: number;
}
