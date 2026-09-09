import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// 根级错误边界：任一组件渲染抛错时不至于整窗白屏（含数据库门禁的提示 UI），
// 给用户一个"重试"入口而不是无解释的空白窗口。
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[error-boundary] 渲染错误', error.message, info.componentStack || '');
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: 'grid',
          placeItems: 'center',
          minHeight: '100vh',
          gap: 12,
          padding: 24,
          background: '#f8fafd',
          color: '#243047',
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center',
        }}
        >
          <strong style={{ fontSize: 18 }}>界面出现了一个错误</strong>
          <span style={{ maxWidth: 560, wordBreak: 'break-all', color: '#66707f' }}>
            {this.state.error.message || '未知错误'}
          </span>
          <button
            type="button"
            className="primary-action"
            style={{ padding: '8px 24px', cursor: 'pointer' }}
            onClick={this.handleRetry}
          >
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
