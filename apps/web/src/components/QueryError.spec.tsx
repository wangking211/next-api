import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import QueryError from './QueryError';

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('QueryError', () => {
  it('show=false 时不渲染任何内容（查询正常时不打扰用户）', () => {
    const { container } = render(<QueryError show={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('show=true 时给出标题与说明文案', async () => {
    render(<QueryError show />);
    expect(await screen.findByText('数据加载失败')).toBeInTheDocument();
    expect(screen.getByText('部分统计可能无法显示，请重试。')).toBeInTheDocument();
  });

  it('点击重试触发回调', async () => {
    let called = 0;
    render(<QueryError show onRetry={() => (called += 1)} />);
    // antd 会在相邻汉字之间插入空格（"重 试"），按正则匹配
    await userEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    expect(called).toBe(1);
  });

  it('不传 onRetry 时不显示按钮', () => {
    render(<QueryError show />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('自定义标题覆盖默认标题', () => {
    render(<QueryError show title="自定义标题" />);
    expect(screen.getByText('自定义标题')).toBeInTheDocument();
    expect(screen.queryByText('数据加载失败')).toBeNull();
  });

  it('文案随界面语言切换', async () => {
    await i18n.changeLanguage('en');
    render(<QueryError show />);
    expect(screen.getByText('Failed to load data')).toBeInTheDocument();
  });
});
