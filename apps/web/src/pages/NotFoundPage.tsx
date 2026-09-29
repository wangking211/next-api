import { Button, Result } from 'antd';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { LangSwitch } from '../components/LangSwitch';
import useDocumentTitle from '../hooks/useDocumentTitle';

/** 未知路径：不再静默重定向，明确告知未找到并给出返回入口 */
export default function NotFoundPage() {
  const { user } = useAuth();
  const { t } = useTranslation();
  useDocumentTitle(t('landing.notFound.title'));
  return (
    <Result
      status="404"
      title="404"
      subTitle={t('landing.notFound.subTitle')}
      extra={
        <>
          <Link to={user ? '/dashboard' : '/'}>
            <Button type="primary">
              {user ? t('landing.notFound.backToConsole') : t('landing.notFound.backHome')}
            </Button>
          </Link>
          <div style={{ marginTop: 16 }}>
            <LangSwitch />
          </div>
        </>
      }
    />
  );
}
