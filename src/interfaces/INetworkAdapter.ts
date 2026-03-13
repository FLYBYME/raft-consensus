export interface RaftMessage {
    topic: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any;
    senderNodeID: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meta?: any;
}

export interface INetworkAdapter {
    /**
     * Send a message to a specific peer.
     */
    send(targetNodeID: string, message: RaftMessage): Promise<void>;

    /**
     * Broadcast a message to all peers.
     */
    broadcast(message: RaftMessage): Promise<void>;

    /**
     * Register a listener for incoming messages.
     */
    on(topic: string, handler: (message: RaftMessage) => void): void;
    
    /**
     * Get the local node ID.
     */
    getNodeID(): string;
}
