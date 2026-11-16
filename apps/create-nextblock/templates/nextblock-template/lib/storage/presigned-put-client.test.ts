import { describe, expect, it } from 'vitest';

import { presignedPutFetchHeaders } from './presigned-put-client';

const png = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'image/png' });

describe('presignedPutFetchHeaders', () => {
  it('sends the signed headers except Content-Length, which the browser sets from the body', () => {
    expect(presignedPutFetchHeaders({ 'Content-Type': 'image/png', 'Content-Length': '4' }, png(4))).toEqual({
      'Content-Type': 'image/png',
    });
  });

  it('refuses a file of another size than the one the URL was signed for', () => {
    expect(() => presignedPutFetchHeaders({ 'Content-Type': 'image/png', 'Content-Length': '4' }, png(5))).toThrow(
      /different file size/,
    );
    expect(() => presignedPutFetchHeaders({ 'Content-Type': 'image/png', 'Content-Length': '4' }, png(3))).toThrow(
      /different file size/,
    );
  });

  it('reads Content-Length in any case', () => {
    expect(presignedPutFetchHeaders({ 'content-length': '4', 'Content-Type': 'image/png' }, png(4))).toEqual({
      'Content-Type': 'image/png',
    });
    expect(() => presignedPutFetchHeaders({ 'CONTENT-LENGTH': '9' }, png(4))).toThrow(/different file size/);
  });

  it('sends the signed type, not the one the file reports', () => {
    const file = new Blob([new Uint8Array(4)], { type: 'image/x-png' });
    expect(presignedPutFetchHeaders({ 'Content-Type': 'image/png', 'Content-Length': '4' }, file)).toEqual({
      'Content-Type': 'image/png',
    });
  });

  it("falls back to the file's type when the route names no headers", () => {
    expect(presignedPutFetchHeaders(undefined, png(4))).toEqual({ 'Content-Type': 'image/png' });
    expect(presignedPutFetchHeaders(undefined, new Blob([new Uint8Array(4)]))).toEqual({});
  });
});
