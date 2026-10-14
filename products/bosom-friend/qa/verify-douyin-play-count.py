# -*- coding: utf-8 -*-
"""抖音真实播放量采集验收：解析、占位 0 处理与 id 精度。

为什么需要这条：作品列表接口的 statistics.play_count 恒为 0 占位（实测同一批作品里
点赞 37、分享 55，播放量不可能是 0），创作者中心页面自己在「播放」一栏显示的都是「-」。
真实播放量只在 /janus/douyin/creator/data/overview/item_contribution_top 里。
这条把三段容易出错的地方钉死：

  1. 响应用 response.text() 取原文，19 位 aweme_id 不能被 double 精度抹掉低位；
  2. 只有 status_code=0 才认，其他状态一律按未采集处理；
  3. 列表接口的占位 0 不得写进 viewCount。

用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/verify-douyin-play-count.py
退出码：0 = 全绿；1 = 存在失败。
"""
import json
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent / "engine"
sys.path.insert(0, str(ENGINE))

import worker  # noqa: E402

RESULTS = []


def check(ok, ident, detail):
    RESULTS.append((bool(ok), ident, detail))
    print(("PASS " if ok else "FAIL ") + ident + " | " + detail)


# 真实抓包原文（2026-09-13 用账号 acc-ejn65i8l 的登录态实测）。
REAL_PAYLOAD = (
    '{"date_range":{"end_date":"20260912","start_date":"20260906"},"dimension":1,'
    '"english_metric_name":"play_cnt","items":[{"item_id":7682660673825869119,'
    '"metric_value":5,"publish_time":"","title":""}],"metric_name":"\u64ad\u653e\u91cf",'
    '"status_code":0,"status_msg":"","value_type":1}'
)

parsed = worker._parse_douyin_play_counts(REAL_PAYLOAD)
check(
    list(parsed.keys()) == ["7682660673825869119"],
    "exact-item-id",
    "19 位 aweme_id 逐位保留：" + json.dumps(list(parsed.keys())),
)
check(parsed.get("7682660673825869119") == 5, "real-play-value", "真实播放量写入：" + str(parsed.get("7682660673825869119")))

# 同一份原文经 JavaScript 值回传会被四舍五入成 7682660673825869000；这条锁死「不许走那条路」。
check("7682660673825869000" not in parsed, "no-float-rounded-id", "没有出现被 double 精度抹平后的 id")

check(worker._parse_douyin_play_counts('{"status_code":5,"status_msg":"\u53c2\u6570\u4e0d\u5408\u6cd5","items":[]}') == {},
      "reject-nonzero-status", "status_code=5（参数不合法）按未采集处理")
check(worker._parse_douyin_play_counts("not json") == {}, "reject-garbage", "非 JSON 原文按未采集处理")
check(worker._parse_douyin_play_counts(None) == {}, "reject-none", "拿不到响应体时按未采集处理")
check(worker._parse_douyin_play_counts('{"status_code":0,"items":[{"item_id":0,"metric_value":9},{"item_id":1,"metric_value":null}]}') == {},
      "reject-empty-id", "缺 id 或缺指标值的条目丢弃")

# 列表接口给的 play_count=0 是占位，不得写进 viewCount；非 0 才是真值。
placeholder = worker._normalize_douyin_work(
    {"aweme_id": "7590012672851119410", "desc": "占位零", "statistics": {"play_count": 0, "digg_count": 1}},
    "7590012672851119410",
)
check("viewCount" not in placeholder, "drop-placeholder-zero", "play_count=0 不写 viewCount，实际 keys=" + json.dumps(sorted(placeholder.keys())))
check(placeholder.get("likeCount") == 1, "keep-real-like", "同一响应里真实的点赞数照常写入：" + str(placeholder.get("likeCount")))

real = worker._normalize_douyin_work(
    {"aweme_id": "7590012672851119410", "desc": "真值", "statistics": {"play_count": 13016}},
    "7590012672851119410",
)
check(real.get("viewCount") == 13016, "keep-real-play", "非 0 播放量照常写入：" + str(real.get("viewCount")))

failed = [item for item in RESULTS if not item[0]]
print("")
print("抖音真实播放量验收：" + str(len(RESULTS) - len(failed)) + "/" + str(len(RESULTS)) + " 通过"
      + ("，失败：" + ", ".join(item[1] for item in failed) if failed else ""))
sys.exit(1 if failed else 0)
