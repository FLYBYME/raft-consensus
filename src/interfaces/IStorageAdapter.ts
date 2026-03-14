import { IStorageResult } from './storage.types';

export interface IStorageAdapter {
    run(sql: string, params?: unknown[]): Promise<IStorageResult> | IStorageResult;
    get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined> | T | undefined;
    all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> | T[];
}
