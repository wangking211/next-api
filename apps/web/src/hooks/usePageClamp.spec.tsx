import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePageClamp } from './usePageClamp';

function clamp(page: number, data?: { items?: unknown[] }) {
  const called: number[] = [];
  const setPage = (p: number) => called.push(p);
  renderHook(() => usePageClamp(page, setPage, data));
  return called;
}

describe('usePageClamp', () => {
  it('当前页有数据时不回退', () => {
    expect(clamp(3, { items: ['a', 'b'] })).toEqual([]);
  });

  it('末页被删空 / 筛选后本页无数据 → 回退一页', () => {
    expect(clamp(3, { items: [] })).toEqual([2]);
  });

  it('第 1 页无数据不回退（没有上一页）', () => {
    expect(clamp(1, { items: [] })).toEqual([]);
  });

  it('请求中（data 未返回）不回退，避免误判为空', () => {
    expect(clamp(3, undefined)).toEqual([]);
    expect(clamp(3, {})).toEqual([]);
  });
});
