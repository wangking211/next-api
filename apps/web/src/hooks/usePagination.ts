import { useCallback, useState } from 'react';
import type { TablePaginationConfig } from 'antd';

/**
 * 列表分页状态：统一 `page` / `pageSize` 的维护、分页器 props 生成与筛选重置。
 *
 * 用法（配合 usePageClamp 做越界回退）：
 * ```tsx
 * const pg = usePagination();
 * const { data } = useQuery({
 *   queryKey: ['things', pg.page, pg.pageSize, filter],
 *   queryFn: ({ signal }) => api.list(pg.page, pg.pageSize, filter, signal),
 *   placeholderData: keepPreviousData,
 * });
 * usePageClamp(pg.page, pg.setPage, data);   // 删除末页最后一条 / 筛选后本页为空 → 自动回退
 * ...
 * <Table pagination={pg.pagination(data?.total)} />
 * ```
 *
 * 筛选条件变化时调用 `pg.reset()` 回到第一页，避免停留在越界页。
 */
export function usePagination(initialPageSize = 20) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);

  /** 筛选/排序条件变化后回到第一页 */
  const reset = useCallback(() => setPage(1), []);

  /**
   * 生成 antd Table 的 pagination 配置；`extra` 用于覆盖默认项
   * （例如抽屉 `{ size: 'small', showSizeChanger: false }`、渠道页自定义 `showTotal`）。
   */
  const pagination = useCallback(
    (total = 0, extra: TablePaginationConfig = {}): TablePaginationConfig => ({
      current: page,
      pageSize,
      total,
      showSizeChanger: true,
      onChange: (nextPage: number, nextPageSize: number) => {
        setPage(nextPage);
        setPageSize(nextPageSize);
      },
      ...extra,
    }),
    [page, pageSize],
  );

  return { page, pageSize, setPage, setPageSize, reset, pagination };
}
