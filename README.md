# raft-consensus

A standalone, framework-agnostic implementation of the Raft Consensus Algorithm in TypeScript. This library provides core primitives for leader election, log replication, and distributed state management.

## Features

- **Leader Election**: Automated candidate transitions and term management.
- **Log Replication**: Reliable log consistency across a distributed cluster.
- **Distributed Ledger (DLT)**: Built-in support for immutable transaction chains.
- **Framework Agnostic**: Decoupled from any specific networking or storage engine via interfaces.
- **Strictly Typed**: Zero `any` usage for maximum reliability.

## Installation

```bash
npm install raft-consensus
```

## Quick Start

```typescript
import { RaftNode, IRaftNode, INetworkAdapter, IStorageAdapter, ILogger } from 'raft-consensus';

// Implement the adapters
const network: INetworkAdapter = { ... };
const storage: IStorageAdapter = { ... };
const logger: ILogger = { ... };

const node = new RaftNode(network, storage, logger, {
    electionTimeoutMin: 150,
    electionTimeoutMax: 300,
    heartbeatInterval: 50,
    minClusterSize: 3
});

await node.start();

// Propose a change to the cluster
await node.propose('my-namespace', { foo: 'bar' });
```

## Core Abstractions

- `INetworkAdapter`: Interface for message passing between nodes.
- `IStorageAdapter`: Interface for persistent storage of the Raft log and state.
- `ILogger`: Standardized logging interface.

## License

MIT
