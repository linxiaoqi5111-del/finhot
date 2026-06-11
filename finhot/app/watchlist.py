"""博主监控源：抓取 watchlist.json 中配置的微博/雪球/公众号博主内容。

列表为空时整体跳过。条目格式与 sources.py 一致，统一进入热词分析。

接入说明：
- 微博：m.weibo.cn 的容器 API 免登录可用，但有频控；uid -> containerid=107603{uid}
- 雪球：需要先访问主页拿 cookie（有 WAF，失败时自动跳过该博主）
- 公众号：无公开 API，通过搜狗微信搜索抓最新文章，频控严格，仅尽力而为
"""
import json
import os
import time

import requests

from .sources import UA, TIMEOUT, _mkid, _strip_html

WATCHLIST_PATH = os.path.join(os.path.dirname(__file__), "..", "watchlist.json")


def load_watchlist():
    try:
        with open(WATCHLIST_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return {k: data.get(k, []) for k in ("weibo", "xueqiu", "wechat")}
    except FileNotFoundError:
        return {"weibo": [], "xueqiu": [], "wechat": []}


def fetch_weibo_user(uid):
    r = requests.get(
        "https://m.weibo.cn/api/container/getIndex",
        params={"type": "uid", "value": uid, "containerid": f"107603{uid}"},
        headers={"User-Agent": UA, "Referer": f"https://m.weibo.cn/u/{uid}"},
        timeout=TIMEOUT,
    )
    out = []
    for card in r.json().get("data", {}).get("cards", []):
        blog = card.get("mblog")
        if not blog:
            continue
        ts = int(time.mktime(time.strptime(blog["created_at"], "%a %b %d %H:%M:%S %z %Y")))
        out.append({
            "id": _mkid("wb", blog["id"]),
            "source": f"微博@{blog.get('user', {}).get('screen_name', uid)}",
            "title": "",
            "content": _strip_html(blog.get("text", "")),
            "url": f"https://m.weibo.cn/detail/{blog['id']}",
            "ts": ts,
        })
    return out


def fetch_xueqiu_user(user_id):
    s = requests.Session()
    s.headers["User-Agent"] = UA
    s.get("https://xueqiu.com/", timeout=TIMEOUT)
    r = s.get(
        "https://xueqiu.com/v4/statuses/user_timeline.json",
        params={"user_id": user_id, "page": 1, "count": 20},
        timeout=TIMEOUT,
    )
    out = []
    for st in r.json().get("statuses", []):
        out.append({
            "id": _mkid("xq", st["id"]),
            "source": f"雪球@{st.get('user', {}).get('screen_name', user_id)}",
            "title": _strip_html(st.get("title", "")),
            "content": _strip_html(st.get("description") or st.get("text", "")),
            "url": f"https://xueqiu.com{st.get('target', '')}",
            "ts": int(st["created_at"] / 1000),
        })
    return out


def fetch_wechat_account(name):
    # 公众号无公开 API；搜狗微信搜索频控严格，预留接口，建议接入 RSSHub 等代理后启用
    raise NotImplementedError("公众号抓取需配置代理渠道（如 RSSHub: /wechat/...）")


def fetch_watchlist():
    wl = load_watchlist()
    items, errors = [], {}
    for uid in wl["weibo"]:
        try:
            items.extend(fetch_weibo_user(uid))
        except Exception as e:  # noqa: BLE001
            errors[f"weibo:{uid}"] = str(e)
    for uid in wl["xueqiu"]:
        try:
            items.extend(fetch_xueqiu_user(uid))
        except Exception as e:  # noqa: BLE001
            errors[f"xueqiu:{uid}"] = str(e)
    for name in wl["wechat"]:
        try:
            items.extend(fetch_wechat_account(name))
        except Exception as e:  # noqa: BLE001
            errors[f"wechat:{name}"] = str(e)
    return items, errors
