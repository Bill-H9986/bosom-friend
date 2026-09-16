import { createPersistStore } from '@/utils/createPersistStore';
import { StoreKey } from '@/utils/StroeEnum';
// 只当类型用：必须写 import type，否则打包器会把整棵"老发布页"（含 electron 侧账号 store、
// IPC 账号轮询、图片/视频选择器）拖进产物——那套页面在路由表里已经不存在了。
import type { IVideoPageStore } from '@/views/publish/children/videoPage/useVideoPageStore';
import type {
  IPubParams,
  IVideoChooseItem,
} from '@/views/publish/children/videoPage/videoPage';
import type { IImagePageStore } from '@/views/publish/children/imagePage/useImagePageStore';
import type { IImgFile } from '@/components/Choose/ImgChoose';
import type { IImageAccountItem } from '@/views/publish/children/imagePage/imagePage.type';

export interface IPubStore {
  // 视频发布保存的数据
  videoPubSaveData: string;
  // 图文发布保存的数据
  imgTexPubtSaveData: string;
  // 视频发布是否开启填写更多参数
  moreParamsOpen: boolean;
}

const state: IPubStore = {
  imgTexPubtSaveData: '',
  videoPubSaveData: '',
  moreParamsOpen: false,
};

export const usePubStroe = createPersistStore(
  {
    ...state,
  },
  (set, _get) => {
    return {
      clear() {
        set({
          ...state,
        });
      },

      setMoreParamsOpen(moreParamsOpen: boolean) {
        set({
          moreParamsOpen,
        });
      },

      // 设置图文发布保存的数据
      setImgTextPubSaveData(data: Partial<IImagePageStore>) {
        set({
          imgTexPubtSaveData: JSON.stringify({
            images: data.images,
            commonPubParams: data.commonPubParams,
            imageAccounts: data.imageAccounts,
          }),
        });
      },
      // 获取图文发布保存的数据
      getImgTextPubSaveData():
        | {
            images?: IImgFile[];
            commonPubParams?: IPubParams;
            imageAccounts?: IImageAccountItem[];
          }
        | undefined {
        if (_get().imgTexPubtSaveData) {
          return JSON.parse(_get().imgTexPubtSaveData);
        }
      },
      // 清空图文发布保存的数据
      clearImgTextPubSave() {
        set({
          imgTexPubtSaveData: '',
        });
      },

      // 设置视频发布保存的数据
      setVideoPubSaveData(data: Partial<IVideoPageStore>) {
        if (data.videoListChoose && data.videoListChoose.length !== 0) {
          set({
            videoPubSaveData: JSON.stringify({
              videoListChoose: data.videoListChoose,
              commonPubParams: data.commonPubParams,
              operateId: data.operateId,
            }),
          });
        }
      },
      // 获取视频发布保存的数据
      getVideoPubSaveData():
        | {
            videoListChoose: IVideoChooseItem[];
            commonPubParams?: IPubParams;
            operateId?: string;
          }
        | undefined {
        if (_get().videoPubSaveData) {
          return JSON.parse(_get().videoPubSaveData);
        }
      },
      // 清空视频发布保存的数据
      clearVideoPubSaveData() {
        set({
          videoPubSaveData: '',
        });
      },
    };
  },
  {
    name: StoreKey.VideoPub,
  },
);
