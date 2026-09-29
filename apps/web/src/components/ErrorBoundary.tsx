import { Component, type ReactNode } from 'react';
import { Button, Result } from 'antd';
import { withTranslation, type WithTranslation } from 'react-i18next';

interface Props extends WithTranslation {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/** 全局错误边界：渲染异常时避免整页白屏 */
class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('Uncaught render error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Result
          status="error"
          title={this.props.t('layout.error.title')}
          subTitle={this.props.t('layout.error.subTitle')}
          extra={
            <Button type="primary" onClick={() => window.location.reload()}>
              {this.props.t('layout.error.refresh')}
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}

export default withTranslation()(ErrorBoundary);
