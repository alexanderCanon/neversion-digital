import { describe, expect, it } from 'vitest';
import api, { validDate, validPrice } from './index';

describe('management input', () => {
  it('rejects impossible dates and fractional cents', () => {
    expect(validDate('2028-02-29')).toBe(true);
    expect(validDate('2026-02-29')).toBe(false);
    expect(validPrice(1999)).toBe(true);
    expect(validPrice(19.99)).toBe(false);
  });

  it('rejects anonymous management calls before touching D1', async () => {
    expect((await api.request('/api/dashboard')).status).toBe(401);
    expect((await api.request('/api/operators', { method: 'POST' })).status).toBe(401);
  });
});
