import { FindManyOptions, Repository } from 'typeorm';
import { ImgTextModel } from '../../../db/models/imgText';
import { AppDataSource } from '../../../db';
import { Injectable } from '../../core/decorators';
import { getUserInfo } from '../../user/comment';
import { backPageData, type CorrectQuery } from '../../../global/table';

@Injectable()
export class ImgTextPubService {
  private imgTextRepository: Repository<ImgTextModel>;

  constructor() {
    this.imgTextRepository = AppDataSource.getRepository(ImgTextModel);
  }

  // 创建图文记录
  async createImgTextPul(imgText: ImgTextModel) {
    imgText.userId = getUserInfo().id;
    return await this.imgTextRepository.save(imgText);
  }

  // 更新数据
  async updateImgTextPul(imgTextModel: ImgTextModel) {
    return await this.imgTextRepository.update(imgTextModel.id!, imgTextModel);
  }

  // 根据发布记录ID获取图文记录列表
  async getImgTextPulListByPubRecordId(pubRecordId: number) {
    return await this.imgTextRepository.find({
      where: { pubRecordId },
    });
  }

  // 根据发布记录ID获取图文记录列表（分页展示）
  async getImgTextPulListByPubRecordIdToShow(
    pubRecordId: number,
    page: CorrectQuery,
  ) {
    const file: FindManyOptions<ImgTextModel> = {
      where: { pubRecordId: pubRecordId },
      order: { publishTime: 'DESC' },
      skip: (page.page_no - 1) * page.page_size,
      take: page.page_size,
    };
    const [list, totalCount] = await this.imgTextRepository.findAndCount(file);
    return backPageData(list, totalCount, page);
  }
}
