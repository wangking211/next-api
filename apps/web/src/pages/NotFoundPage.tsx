import { Button, Result } from 'antd';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import useDocumentTitle from '../hooks/useDocumentTitle';

/** 未知路径：不再静默重定向，明确告知未找到并给出返回入口 */
export default function NotFoundPage() {
  const { user } = useAuth();
  useDocumentTitle('页面不存在');
  return (
    <Result
      status="404"
      title="404"
      subTitle="你访问的页面不存在或已被移动。"
      extra={
        <Link to={user ? '/dashboard' : '/'}>
          <Button type="primary">{user ? '返回控制台' : '返回首页'}</Button>
        </Link>
      }
    />
  );
}
