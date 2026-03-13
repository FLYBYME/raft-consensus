import { INetworkAdapter } from '../src/interfaces/INetworkAdapter';
import { IStorageAdapter } from '../src/interfaces/IStorageAdapter';
import { ILogger } from '../src/interfaces/ILogger';

export const createMockNetwork = (): jest.Mocked<INetworkAdapter> => ({
    send: jest.fn().mockImplementation(() => Promise.resolve()),
    broadcast: jest.fn().mockImplementation(() => Promise.resolve()),
    on: jest.fn(),
    getNodeID: jest.fn().mockReturnValue('node-1')
});

export const createMockStorage = (): jest.Mocked<IStorageAdapter> => ({
    run: jest.fn().mockImplementation(() => Promise.resolve({ changes: 1 })),
    get: jest.fn().mockImplementation(() => Promise.resolve(undefined)),
    all: jest.fn().mockImplementation(() => Promise.resolve([]))
});

export const createMockLogger = (): jest.Mocked<ILogger> => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis()
});
