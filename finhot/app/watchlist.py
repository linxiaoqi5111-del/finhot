"""博主监控源：抓取 watchlist.json 中配置的微博/雪球/公众号博主内容。

列表为空时整体跳过。条目格式与 sources.py 一致，统一进入热词分析。

接入说明：
- 微博：m.weibo.cn 容器 API（uid -> containerid=107603{uid}），现需游客 cookie：用浏览器无痕模式打开
  m.weibo.cn 后复制 Cookie，存入环境变量 WEIBO_COOKIE 或 finhot/data/weibo_cookie.txt（已 gitignore）
- 雪球：需要先访问主页拿 cookie（有 WAF，失败时自动跳过该博主）
- 公众号：无公开 API，通过搜狗微信搜索抓最新文章，频控严格，仅尽力而为
- X(Twitter)：经 Nitter/RSSHub 免费通路抓 RSS，多实例自动切换，公共实例不稳定时跳过
"""
import email.utils
import json
import os
import time
import xml.etree.ElementTree as ET

import requests

from .sources import UA, TIMEOUT, _mkid, _strip_html

WATCHLIST_PATH = os.path.join(os.path.dirname(__file__), "..", "watchlist.json")
WEIBO_COOKIE_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "weibo_cookie.txt")


def _weibo_cookie():
    ck = os.environ.get("WEIBO_COOKIE", "").strip()
    if ck:
        return ck
    try:
        with open(WEIBO_COOKIE_PATH, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def load_watchlist():
    try:
        with open(WATCHLIST_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return {k: data.get(k, []) for k in ("weibo", "xueqiu", "wechat", "x")}
    except FileNotFoundError:
        return {"weibo": [], "xueqiu": [], "wechat": [], "x": []}


def fetch_weibo_user(uid):
    r = requests.get(
        "https://m.weibo.cn/api/container/getIndex",
        params={"type": "uid", "value": uid, "containerid": f"107603{uid}"},
        headers={"User-Agent": UA, "Referer": f"https://m.weibo.cn/u/{uid}", "Cookie": _weibo_cookie()},
        timeout=TIMEOUT,
    )
    data = r.json()
    if data.get("ok") != 1:
        raise RuntimeError(f"weibo api ok={data.get('ok')} (游客 cookie 失效或频控，见 WEIBO_COOKIE 说明)")
    out = []
    for card in data.get("data", {}).get("cards", []):
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


# 公共 Nitter 实例经常失效，按顺序尝试；RSSHub 公共实例作兜底
X_RSS_ENDPOINTS = [
    "https://xcancel.com/{user}/rss",
    "https://nitter.net/{user}/rss",
    "https://nitter.privacyredirect.com/{user}/rss",
    "https://nitter.tiekoetter.com/{user}/rss",
    "https://rsshub.app/twitter/user/{user}",
]


def fetch_x_user(user):
    user = user.lstrip("@")
    last_err = None
    for tpl in X_RSS_ENDPOINTS:
        try:
            # rss.xcancel.com 只放行白名单内的 RSS 阅读器 UA（如 FreshRSS/TT-RSS）
            r = requests.get(
                tpl.format(user=user),
                headers={"User-Agent": "FreshRSS/1.24.0 (Linux; https://freshrss.org)"},
                timeout=TIMEOUT,
            )
            if r.status_code != 200 or b"<rss" not in r.content[:200]:
                last_err = f"{tpl.format(user=user)} -> HTTP {r.status_code}"
                continue
            root = ET.fromstring(r.content)
            out = []
            for it in root.iter("item"):
                link = (it.findtext("link") or "").strip()
                # 链接统一改回 x.com（Nitter 实例域名 + #m 锚点 -> 原推链接）
                if "/status/" in link:
                    link = "https://x.com/" + link.split("://", 1)[-1].split("/", 1)[-1].split("#", 1)[0]
                pub = it.findtext("pubDate")
                ts = int(email.utils.parsedate_to_datetime(pub).timestamp()) if pub else int(time.time())
                out.append({
                    "id": _mkid("x", link or it.findtext("guid") or ""),
                    "source": f"X@{user}",
                    "title": "",
                    "content": _strip_html(it.findtext("description") or it.findtext("title") or ""),
                    "url": link,
                    "ts": ts,
                })
            if out:
                return out
            last_err = f"{tpl.format(user=user)} -> empty feed"
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
    raise RuntimeError(f"all X endpoints failed: {last_err}")


def fetch_watchlist():
    wl = load_watchlist()
    items, errors = [], {}
    for uid in wl["weibo"]:
        try:
            items.extend(fetch_weibo_user(uid))
        except Exception as e:  # noqa: BLE001
            errors[f"weibo:{uid}"] = str(e)
        time.sleep(1)  # 频控保护
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
    for user in wl["x"]:
        try:
            items.extend(fetch_x_user(user))
        except Exception as e:  # noqa: BLE001
            errors[f"x:{user}"] = str(e)
    return items, errors
