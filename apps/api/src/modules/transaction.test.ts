import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { retryableTransactionError } from './shared.js';
const failure = (code: string, meta: Record<string, unknown> = {}) =>
  new Prisma.PrismaClientKnownRequestError('Synthetic transaction error', {
    code,
    clientVersion: '7.10.0',
    meta,
  });
describe('PostgreSQL transaction conflict handling', () => {
  it('recognizes adapter SQLSTATE serialization/deadlock conflicts without retrying unrelated raw SQL errors', () => {
    for (const code of ['40001', '40P01']) {
      expect(
        retryableTransactionError(
          failure('P2010', { driverAdapterError: { cause: { originalCode: code } } }),
        ),
      ).toBe(true);
      expect(retryableTransactionError(failure('P2010', { code }))).toBe(true);
    }
    expect(
      retryableTransactionError(
        failure('P2010', { driverAdapterError: { cause: { originalCode: '42601' } } }),
      ),
    ).toBe(false);
    expect(
      retryableTransactionError(failure('P2010', { message: '40001 is arbitrary text' })),
    ).toBe(false);
    expect(retryableTransactionError(failure('P2034'))).toBe(true);
    expect(retryableTransactionError(failure('P2002'))).toBe(true);
    expect(retryableTransactionError(new Error('could not serialize access'))).toBe(false);
  });
});
