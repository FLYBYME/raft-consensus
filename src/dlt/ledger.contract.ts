import { z } from 'zod';

/**
 * LedgerContract — The formal Zod contract for Distributed Ledger operations.
 */
export const LedgerContract = {
    name: 'ledger',
    actions: {
        append: {
            params: z.object({
                namespace: z.string(),
                payload: z.record(z.string(), z.unknown())
            }),
            returns: z.object({
                txID: z.string(),
                index: z.number(),
                term: z.number()
            })
        },
        getEntries: {
            params: z.object({
                namespace: z.string(),
                fromIndex: z.number().default(0)
            }),
            returns: z.array(z.object({
                txID: z.string(),
                index: z.number(),
                term: z.number(),
                payload: z.record(z.string(), z.unknown()),
                timestamp: z.number()
            }))
        }
    }
};
