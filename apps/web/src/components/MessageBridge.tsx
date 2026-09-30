import { useEffect } from 'react';
import { App } from 'antd';
import { setMessageInstance } from '../api/notify';

/**
 * 把 antd `<App>` 上下文里的 message 实例交给 React 树外的 MutationCache。
 * 必须渲染在 `<AntApp>` 之后（见 main.tsx）。
 */
export default function MessageBridge() {
  const { message } = App.useApp();

  useEffect(() => {
    setMessageInstance(message);
    return () => setMessageInstance(null);
  }, [message]);

  return null;
}
