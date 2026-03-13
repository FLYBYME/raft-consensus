export interface AlgorithmIdentifier {
    name: string;
    [key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CryptoKey = any; // Fallback

export interface CryptoKeyPair {
    publicKey: CryptoKey;
    privateKey: CryptoKey;
}

/**
 * IsomorphicCrypto — wrapper for SubtleCrypto (WebCrypto)
 */
export class IsomorphicCrypto {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static crypto: any = (typeof globalThis !== 'undefined' && globalThis.crypto)
        ? globalThis.crypto
        : (typeof require !== 'undefined' ? require('node:crypto').webcrypto : null);

    /** Generate a random ID string */
    static randomID(len = 16): string {
        const bytes = new Uint8Array(len / 2);
        if (this.crypto) {
            this.crypto.getRandomValues(bytes);
        } else {
            for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        }
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    private static toBase64(buf: ArrayBuffer): string {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i] as number);
        }
        return globalThis.btoa(binary);
    }

    private static fromBase64(b64: string): Uint8Array {
        const binary = globalThis.atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    static async generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
        if (!this.crypto) throw new Error('Crypto not available');
        const keyPair = (await this.crypto.subtle.generateKey(
            { name: 'Ed25519' } as AlgorithmIdentifier,
            true,
            ['sign', 'verify']
        )) as CryptoKeyPair;

        const pubKeyBuf = await this.crypto.subtle.exportKey('spki', keyPair.publicKey);
        const privKeyBuf = await this.crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

        return {
            publicKey: this.toBase64(pubKeyBuf),
            privateKey: this.toBase64(privKeyBuf)
        };
    }

    static async sign(payload: string | Uint8Array, privateKeyB64: string): Promise<string> {
        if (!this.crypto) throw new Error('Crypto not available');
        const privKeyBuf = this.fromBase64(privateKeyB64);
        const key = await this.crypto.subtle.importKey(
            'pkcs8',
            privKeyBuf,
            { name: 'Ed25519' } as AlgorithmIdentifier,
            false,
            ['sign']
        );

        const data = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
        const signature = await this.crypto.subtle.sign(
            { name: 'Ed25519' } as AlgorithmIdentifier,
            key,
            data
        );

        return this.toBase64(signature);
    }

    static async verify(payload: string | Uint8Array, signatureB64: string, publicKeyB64: string): Promise<boolean> {
        if (!this.crypto) throw new Error('Crypto not available');
        const pubKeyBuf = this.fromBase64(publicKeyB64);
        const key = await this.crypto.subtle.importKey(
            'spki',
            pubKeyBuf,
            { name: 'Ed25519' } as AlgorithmIdentifier,
            false,
            ['verify']
        );

        const data = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
        const signature = this.fromBase64(signatureB64);

        return await this.crypto.subtle.verify(
            { name: 'Ed25519' } as AlgorithmIdentifier,
            key,
            signature,
            data
        );
    }

    static async sha256(data: string | Uint8Array): Promise<string> {
        if (!this.crypto) throw new Error('Crypto not available');
        const msgUint8 = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        const hashBuffer = await this.crypto.subtle.digest('SHA-256', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
}
