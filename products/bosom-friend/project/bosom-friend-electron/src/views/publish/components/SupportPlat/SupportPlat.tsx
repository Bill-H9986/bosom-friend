import { ForwardedRef, forwardRef, memo } from 'react';
import { PubType } from '../../../../../commont/publish/PublishEnum';
import styles from './supportPlat.module.scss';
import { AccountPlatInfoMap } from '../../../account/comment';
import { Tooltip } from 'antd';

export interface ISupportPlatRef {}

export interface ISupportPlatProps {
  pubType: PubType;
  style?: React.CSSProperties;
}

const SupportPlat = memo(
  forwardRef(
    (
      { pubType, style }: ISupportPlatProps,
      ref: ForwardedRef<ISupportPlatRef>,
    ) => {
      return (
        <div
          className={`${styles.supportPlat} ${pubType !== PubType.VIDEO && styles.supportPlatBg}`}
          style={style}
        >
          <div className="supportPlatBg-title">支持平台</div>
          <div className="supportPlat-tip">
            <p className="supportPlat-tip--line" />
            <p className="supportPlat-tip-text">支持以下平台（点击可打开创作者后台）</p>
            <p className="supportPlat-tip--line" />
          </div>
          <ul className="supportPlat-con">
            {Array.from(AccountPlatInfoMap).map(([k, v]) => {
              if (!v.pubTypes.has(pubType)) return null;
              return (
                <li key={v.name}>
                  <Tooltip title={`${v.name} · 创作者后台`} placement="top">
                    <button
                      type="button"
                      className="supportPlat-capsule"
                      onClick={() => {
                        if (v.url) window.open(v.url, '_blank');
                      }}
                    >
                      <img src={v.icon} alt={v.name} />
                      <span>{v.name}</span>
                    </button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </div>
      );
    },
  ),
);
SupportPlat.displayName = 'SupportPlat';

export default SupportPlat;
