import type { ProgressInfo } from 'electron-updater';
import { useCallback, useEffect, useState } from 'react';
import Modal from '@/components/update/Modal';
import Progress from '@/components/update/Progress';
import './update.css';
import { Button } from 'antd';

interface VersionInfo {
  update?: boolean;
  version?: string;
  newVersion?: string;
  /** 是否强制更新（服务端策略下发，不可跳过） */
  force?: boolean;
  notes?: string;
}

interface ErrorType {
  message: string;
  error?: Error;
}

type UpdateStage = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';

const Update = ({ hideButton = false }: { hideButton?: boolean }) => {
  const [stage, setStage] = useState<UpdateStage>('idle');
  const [versionInfo, setVersionInfo] = useState<VersionInfo>();
  const [updateError, setUpdateError] = useState<ErrorType>();
  const [progressInfo, setProgressInfo] = useState<Partial<ProgressInfo>>();
  const [modalOpen, setModalOpen] = useState<boolean>(false);

  const checkUpdate = async () => {
    setStage('checking');
    setProgressInfo({ percent: 0 });
    setUpdateError(undefined);
    try {
      const result = await window.ipcRenderer.invoke('zhiyin:update:check');
      if (result?.reason === 'dev') {
        setStage('error');
        setUpdateError({ message: '开发模式下不支持在线升级，打包安装后可用' });
        setModalOpen(true);
        return;
      }
      if (result?.message) {
        setStage('error');
        setUpdateError({ message: result.message });
        setModalOpen(true);
      }
    } catch (e) {
      setStage('error');
      setUpdateError({ message: (e as Error).message });
      setModalOpen(true);
    } finally {
      setStage('idle');
    }
  };

  const onUpdateCanAvailable = useCallback(
    (_event: Electron.IpcRendererEvent, arg: VersionInfo) => {
      setVersionInfo(arg);
      setUpdateError(undefined);
      if (arg?.update) {
        if (arg.force) {
          setStage('available');
          setModalOpen(true);
          // 强制更新：自动开始下载
          void window.ipcRenderer.invoke('start-download');
        } else {
          // 非强制更新：后台静默下载，不打断用户；下载完成后由 onUpdateDownloaded 提示
          setStage('downloading');
          setModalOpen(false);
        }
      }
    },
    [],
  );

  const onUpdateError = useCallback(
    (_event: Electron.IpcRendererEvent, arg: ErrorType) => {
      setStage('error');
      setUpdateError(arg);
      setModalOpen(true);
    },
    [],
  );

  const onDownloadProgress = useCallback(
    (_event: Electron.IpcRendererEvent, arg: ProgressInfo) => {
      setStage('downloading');
      setProgressInfo(arg);
    },
    [],
  );

  const onUpdateDownloaded = useCallback(() => {
    setStage('downloaded');
    setProgressInfo({ percent: 100 });
    // 下载完成后才询问用户是否立即安装
    setModalOpen(true);
  }, []);

  useEffect(() => {
    window.ipcRenderer.on('update-can-available', onUpdateCanAvailable);
    window.ipcRenderer.on('update-error', onUpdateError);
    window.ipcRenderer.on('download-progress', onDownloadProgress);
    window.ipcRenderer.on('update-downloaded', onUpdateDownloaded);
    return () => {
      window.ipcRenderer.off('update-can-available', onUpdateCanAvailable);
      window.ipcRenderer.off('update-error', onUpdateError);
      window.ipcRenderer.off('download-progress', onDownloadProgress);
      window.ipcRenderer.off('update-downloaded', onUpdateDownloaded);
    };
  }, [onUpdateCanAvailable, onUpdateError, onDownloadProgress, onUpdateDownloaded]);

  const force = !!versionInfo?.force;

  const renderBody = () => {
    if (stage === 'error') {
      return (
        <div className="update-body">
          <p className="update-title">升级出现异常</p>
          <p className="update-desc">{updateError?.message || '未知错误'}</p>
        </div>
      );
    }
    if (stage === 'available' || stage === 'downloading') {
      return (
        <div className="update-body">
          <p className="update-title">
            {force ? '检测到必须更新的新版本' : '发现新版本'}
          </p>
          <p className="update-desc">
            v{versionInfo?.version} → v{versionInfo?.newVersion}
            {force && <span className="update-force">（本次为强制更新）</span>}
          </p>
          {versionInfo?.notes && (
            <div className="update-notes">{versionInfo.notes}</div>
          )}
          <div className="update__progress">
            <div className="progress__title">
              {stage === 'downloading'
                ? `下载中 ${Math.floor(progressInfo?.percent || 0)}%`
                : force
                  ? '正在准备下载…'
                  : '点击「立即更新」开始下载'}
            </div>
            <div className="progress__bar">
              <Progress percent={progressInfo?.percent} />
            </div>
          </div>
        </div>
      );
    }
    if (stage === 'downloaded') {
      return (
        <div className="update-body">
          <p className="update-title">新版本下载完成</p>
          <p className="update-desc">
            安装后将自动重启，建议先保存当前工作。
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <>
      <Modal
        open={modalOpen}
        cancelText={force ? undefined : '稍后再说'}
        okText={
          stage === 'downloaded'
            ? '现在安装'
            : stage === 'available' && !force
              ? '立即更新'
              : undefined
        }
        onCancel={() => {
          // 强制更新不可关闭
          if (!force) setModalOpen(false);
        }}
        onOk={() => {
          if (stage === 'downloaded') {
            void window.ipcRenderer.invoke('quit-and-install');
          } else if (stage === 'available') {
            void window.ipcRenderer.invoke('start-download');
          }
        }}
      >
        {renderBody()}
      </Modal>
      {!hideButton && (
        <Button
          disabled={stage === 'checking'}
          onClick={checkUpdate}
          type="text"
          className="w-full text-left !p-0 !bg-transparent hover:!bg-transparent !border-none"
          style={{ marginLeft: '-10px' }}
        >
          {stage === 'checking' ? '检查中…' : '检查更新'}
        </Button>
      )}
    </>
  );
};

export default Update;
