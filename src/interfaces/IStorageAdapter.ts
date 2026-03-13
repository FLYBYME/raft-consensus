export interface IStorageAdapter {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run(sql: string, params?: any[]): Promise<any> | any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(sql: string, params?: any[]): Promise<any> | any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    all(sql: string, params?: any[]): Promise<any[]> | any[];
}
