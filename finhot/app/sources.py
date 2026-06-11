"""快讯采集器：每个源返回统一格式的条目列表。

条目格式: {"id", "source", "title", "content", "url", "ts"}
新增数据源只需写一个返回该格式的函数并加入 SOURCES。
"""
import hashlib
import re
import time

import requests

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
TIMEOUT = 15


def _get(url, **kwargs):
    headers = {"User-Agent": UA, **kwargs.pop("headers", {})}
    return requests.get(url, headers=headers, timeout=TIMEOUT, **kwargs)


def _strip_html(text):
    return re.sub(r"<[^>]+>", "", text or "").strip()


def _mkid(source, raw):
    return source + ":" + hashlib.md5(str(raw).encode()).hexdigest()[:16]


def fetch_sina(pages=3):
    """新浪财经 7x24 直播"""
    out = []
    for page in range(1, pages + 1):
        r = _get(
            "https://zhibo.sina.com.cn/api/zhibo/feed",
            params={"page": page, "page_size": 100, "zhibo_id": 152},
        )
        feed = r.json()["result"]["data"]["feed"]["list"]
        for it in feed:
            ts = int(time.mktime(time.strptime(it["create_time"], "%Y-%m-%d %H:%M:%S")))
            out.append({
                "id": _mkid("sina", it["id"]),
                "source": "新浪财经7x24",
                "title": "",
                "content": _strip_html(it.get("rich_text", "")),
                "url": "https://finance.sina.com.cn/7x24/",
                "ts": ts,
            })
    return out


def fetch_eastmoney(pages=3):
    """东方财富 7x24 快讯"""
    out = []
    sort_end = ""
    for _ in range(pages):
        r = _get(
            "https://np-listapi.eastmoney.com/comm/web/getFastNewsList",
            params={
                "client": "web", "biz": "web_724", "fastColumn": "102",
                "sortEnd": sort_end, "pageSize": 50,
                "req_trace": int(time.time() * 1000),
            },
        )
        data = r.json()["data"]
        sort_end = data.get("sortEnd", "")
        for it in data.get("fastNewsList", []):
            t = it.get("showTime", "")
            ts = int(time.mktime(time.strptime(t, "%Y-%m-%d %H:%M:%S"))) if t else int(time.time())
            out.append({
                "id": _mkid("em", it["code"]),
                "source": "东方财富快讯",
                "title": _strip_html(it.get("title", "")),
                "content": _strip_html(it.get("summary", "")),
                "url": f"https://finance.eastmoney.com/a/{it['code']}.html",
                "ts": ts,
            })
        if not sort_end:
            break
    return out


def fetch_wallstreetcn(limit=100):
    """华尔街见闻 实时快讯"""
    r = _get(
        "https://api-one.wallstcn.com/apiv1/content/lives",
        params={"channel": "global-channel", "limit": limit},
    )
    out = []
    for it in r.json()["data"]["items"]:
        out.append({
            "id": _mkid("wscn", it["id"]),
            "source": "华尔街见闻",
            "title": _strip_html(it.get("title", "")),
            "content": _strip_html(it.get("content_text") or it.get("content", "")),
            "url": it.get("uri", "https://wallstreetcn.com/live/global"),
            "ts": int(it["display_time"]),
        })
    return out


def fetch_10jqka(pages=3):
    """同花顺 股票快讯"""
    out = []
    for page in range(1, pages + 1):
        r = _get(
            "https://news.10jqka.com.cn/tapp/news/push/stock/",
            params={"page": page, "tag": "", "track": "website", "pagesize": 50},
        )
        for it in r.json()["data"]["list"]:
            out.append({
                "id": _mkid("ths", it["id"]),
                "source": "同花顺快讯",
                "title": _strip_html(it.get("title", "")),
                "content": _strip_html(it.get("digest", "")),
                "url": it.get("url", "https://news.10jqka.com.cn/realtimenews.html"),
                "ts": int(it.get("rtime") or it.get("ctime") or time.time()),
            })
    return out


def fetch_gelonghui(limit=100):
    """格隆汇 实时快讯"""
    r = _get(
        "https://www.gelonghui.com/api/live-channels/all/lives",
        params={"limit": limit},
    )
    out = []
    for it in r.json()["result"]:
        out.append({
            "id": _mkid("glh", it["id"]),
            "source": "格隆汇",
            "title": _strip_html(it.get("title", "")),
            "content": _strip_html(it.get("content", "")),
            "url": f"https://www.gelonghui.com/live/{it['id']}",
            "ts": int(it["createTime"]),
        })
    return out


def fetch_cls(pages=3, rn=30):
    """财联社 电报（接口需签名：sign = md5(sha1(按键排序的查询串))）"""
    out = []
    last_time = int(time.time())
    for _ in range(pages):
        params = {
            "app": "CailianpressWeb",
            "category": "",
            "last_time": str(last_time),
            "os": "web",
            "refresh_type": "1",
            "rn": str(rn),
            "sv": "8.4.6",
        }
        s = "&".join(f"{k}={params[k]}" for k in sorted(params))
        params["sign"] = hashlib.md5(hashlib.sha1(s.encode()).hexdigest().encode()).hexdigest()
        r = _get(
            "https://www.cls.cn/v1/roll/get_roll_list",
            params=params,
            headers={"Referer": "https://www.cls.cn/telegraph"},
        )
        rows = (r.json().get("data") or {}).get("roll_data", [])
        if not rows:
            break
        for it in rows:
            ts = int(it.get("ctime") or time.time())
            out.append({
                "id": _mkid("cls", it["id"]),
                "source": "财联社",
                "title": _strip_html(it.get("title", "")),
                "content": _strip_html(it.get("content", "")),
                "url": f"https://www.cls.cn/detail/{it['id']}",
                "ts": ts,
            })
            last_time = min(last_time, ts)
    return out


SOURCES = {
    "sina": fetch_sina,
    "eastmoney": fetch_eastmoney,
    "wallstreetcn": fetch_wallstreetcn,
    "10jqka": fetch_10jqka,
    "gelonghui": fetch_gelonghui,
    "cls": fetch_cls,
}


def fetch_all():
    items, errors = [], {}
    for name, fn in SOURCES.items():
        try:
            items.extend(fn())
        except Exception as e:  # noqa: BLE001 - 单源失败不影响其他源
            errors[name] = str(e)
    return items, errors
