import { useEffect } from 'react';

interface PageLike {
  items?: unknown[];
}

/**
 * 分页越界修正：当删除最后一条 / 筛选后当前页无数据时，自动回退一页，
 * 避免停留在空白表格。
 */
export function usePageClamp(
  page: number,
  setPage: (page: number) => void,
  data?: PageLike,
) {
  useEffect(() => {
    if (page > 1 && data && Array.isArray(data.items) && data.items.length === 0) {
      setPage(page - 1);
    }
  }, [data, page, setPage]);
}
