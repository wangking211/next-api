import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePagination } from './usePagination';

describe('usePagination', () => {
  it('初始为第 1 页与指定每页条数', () => {
    const { result } = renderHook(() => usePagination(10));
    expect(result.current.page).toBe(1);
    expect(result.current.pageSize).toBe(10);
  });

  it('pagination() 生成 antd Table 需要的字段', () => {
    const { result } = renderHook(() => usePagination(20));
    const p = result.current.pagination(55);
    expect(p.current).toBe(1);
    expect(p.pageSize).toBe(20);
    expect(p.total).toBe(55);
    expect(p.showSizeChanger).toBe(true);
    expect(typeof p.onChange).toBe('function');
  });

  it('分页器回调更新页码与每页条数', () => {
    const { result } = renderHook(() => usePagination(20));
    const p = result.current.pagination(55);
    act(() => {
      p.onChange?.(3, 50);
    });
    expect(result.current.page).toBe(3);
    expect(result.current.pageSize).toBe(50);
    // 重新生成的配置反映新页码（Table 靠它高亮当前页）
    expect(result.current.pagination(55).current).toBe(3);
  });

  it('extra 覆盖默认项（抽屉常用 size=small / 关闭 sizechanger）', () => {
    const { result } = renderHook(() => usePagination());
    const p = result.current.pagination(10, { size: 'small', showSizeChanger: false });
    expect(p.size).toBe('small');
    expect(p.showSizeChanger).toBe(false);
    expect(p.total).toBe(10);
  });

  it('total 缺省按 0 处理', () => {
    const { result } = renderHook(() => usePagination());
    expect(result.current.pagination().total).toBe(0);
  });

  it('reset() 回到第一页（筛选条件变化时用）', () => {
    const { result } = renderHook(() => usePagination(20));
    act(() => {
      result.current.pagination(55).onChange?.(4, 20);
    });
    expect(result.current.page).toBe(4);
    act(() => {
      result.current.reset();
    });
    expect(result.current.page).toBe(1);
    // 每页条数不因 reset 变化
    expect(result.current.pageSize).toBe(20);
  });
});
