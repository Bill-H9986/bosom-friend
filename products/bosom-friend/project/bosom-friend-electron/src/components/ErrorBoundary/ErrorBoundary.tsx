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

  const handleError = (error: unknown, target?: EventTarget | null) => {
    // window 的 error 事件里 event.error 可能为 null（跨域脚本、资源类错误等），
    // 直接读 .stack 会让错误处理自身抛 TypeError，既掩盖原始错误又在页面上留下未捕获异常。
    let message =
      error instanceof Error ? (error.stack ?? error.message) : String(error ?? '');
    // 资源加载失败（<script>/<link>/<img> 404）时 event.error 为 null，只写"未知错误"
    // 等于把可查的证据丢掉：远程现场只看到一句无从下手的文案。这里补上真正的失败地址。
    if (message === '' && target !== null && target !== undefined && 'src' in target) {
      const el = target as unknown as { src?: string; href?: string; tagName?: string };
      const url = el.src ?? el.href ?? '';
      message = '资源加载失败：' + (el.tagName ?? '资源') + ' ' + url;
    }
    setErrorMsg(message === '' ? '未知错误' : message);
    setHasError(true);
  };

  useEffect(() => {
    const errorListener = (event: ErrorEvent) => {
      handleError(event.error, event.target);
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
