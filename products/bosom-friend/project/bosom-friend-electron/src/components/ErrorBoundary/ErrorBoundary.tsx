import React, { useState, useEffect } from 'react';
import styles from './errorBoundary.module.scss';
import { Button } from 'antd';
import { useNavigate } from 'react-router-dom';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

const ErrorBoundary: React.FC<ErrorBoundaryProps> = ({ children }) => {
  const [hasError, setHasError] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const navigate = useNavigate();

  const handleError = (error: unknown) => {
    // window 的 error 事件里 event.error 可能为 null（跨域脚本、资源类错误等），
    // 直接读 .stack 会让错误处理自身抛 TypeError，既掩盖原始错误又在页面上留下未捕获异常。
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error ?? '未知错误');
    setErrorMsg(message);
    setHasError(true);
  };

  useEffect(() => {
    const errorListener = (event: ErrorEvent) => {
      handleError(event.error);
    };

    window.addEventListener('error', errorListener);

    return () => {
      window.removeEventListener('error', errorListener);
    };
  }, []);

  if (hasError) {
    // 您可以自定义回退UI
    return (
      <div className={styles.errorBoundary}>
        <code>{errorMsg}</code>
        <h1>对不起，系统出现了错误</h1>
        <Button
          type="primary"
          onClick={() => {
            console.log(errorMsg);
            console.log('错误上报');
            navigate('/login');
          }}
        >
          上报错误
        </Button>
      </div>
    );
  }

  return <>{children}</>;
};

export default ErrorBoundary;
