import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '../i18n';
import { AuthProvider } from '../auth/AuthContext';
import { TOKEN_KEY } from '../api/client';
import RoleRoute from './RoleRoute';

const { meMock } = vi.hoisted(() => ({ meMock: vi.fn() }));

vi.mock('../api/endpoints', () => ({
  authApi: {
    me: meMock,
    login: vi.fn(),
    register: vi.fn(),
    logoutAll: vi.fn(),
  },
}));

const baseUser = {
  id: 'u1',
  email: 'a@b.c',
  username: 'tester',
  createdAt: '2026-01-01T00:00:00Z',
};

function renderAgentRoute() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/agent']}>
        <Routes>
          <Route element={<RoleRoute roles={['AGENT', 'ADMIN']} />}>
            <Route path="/agent" element={<div>agent-page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  localStorage.clear();
  meMock.mockReset();
});

describe('RoleRoute（/agent 直达 URL 守卫）', () => {
  it('未登录渲染 403 而非子路由', async () => {
    renderAgentRoute();
    expect(await screen.findByText('当前账号无权访问该页面。')).toBeInTheDocument();
    expect(screen.queryByText('agent-page')).toBeNull();
  });

  it('非目标角色（USER）直达 URL 同样被拦下', async () => {
    localStorage.setItem(TOKEN_KEY, 't');
    meMock.mockResolvedValue({ ...baseUser, role: 'USER' });
    renderAgentRoute();
    expect(await screen.findByText('当前账号无权访问该页面。')).toBeInTheDocument();
    expect(screen.queryByText('agent-page')).toBeNull();
  });

  it('AGENT 角色放行并渲染子路由', async () => {
    localStorage.setItem(TOKEN_KEY, 't');
    meMock.mockResolvedValue({ ...baseUser, role: 'AGENT' });
    renderAgentRoute();
    expect(await screen.findByText('agent-page')).toBeInTheDocument();
  });
});
