"""博主监控源：抓取 watchlist.json 中配置的微博/雪球/公众号博主内容。

列表为空时整体跳过。条目格式与 sources.py 一致，统一进入热词分析。

接入说明：
- 微博：m.weibo.cn 容器 API（uid -> containerid=107603{uid}）需游客 cookie；失效时自动走 genvisitor2
  接口重新生成并保存，也可手动指定（环境变量 WEIBO_COOKIE 或 finhot/data/weibo_cookie.txt，已 gitignore）
- 雪球：匿名通路先访问 /about 拿 xq_a_token；遇阿里云 WAF 滑块验证（数据中心 IP 常见）时报错跳过，
  可用环境变量 XUEQIU_COOKIE 或 finhot/data/xueqiu_cookie.txt 填入自己浏览器里的 cookie
- 公众号：无公开 API，走 Wechat2RSS 公益库（wechat2rss.xlab.app，填公众号名自动查覆盖）；不在库里的
  可填 RSS 直链（自建 Wechat2RSS/RSSHub 的 feed 地址）
- rss：通用 RSS 源（媒体官网 feed 等），填 {"name": 源名, "url": feed 地址}
- X(Twitter)：经 Nitter/RSSHub 免费通路抓 RSS，多实例自动切换，公共实例不稳定时跳过
"""
import email.utils
import json
import os
import re
import time
import xml.etree.ElementTree as ET

import requests

from .sources import UA, TIMEOUT, _mkid, _strip_html
from .x_grok import load_grok_items  # native X supplement via agent tools

WATCHLIST_PATH = os.path.join(os.path.dirname(__file__), "..", "watchlist.json")
WEIBO_COOKIE_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "weibo_cookie.txt")
XUEQIU_COOKIE_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "xueqiu_cookie.txt")
WEIBO_SLEEP = float(os.environ.get("WEIBO_SLEEP", "8"))  # 单号间隔秒数，防频控


_weibo_ck = {"value": None}


def _weibo_cookie():
    if _weibo_ck["value"] is not None:
        return _weibo_ck["value"]
    ck = os.environ.get("WEIBO_COOKIE", "").strip()
    if not ck:
        try:
            with open(WEIBO_COOKIE_PATH, encoding="utf-8") as f:
                ck = f.read().strip()
        except FileNotFoundError:
            ck = ""
    _weibo_ck["value"] = ck
    return ck


def _renew_weibo_cookie():
    """重新生成游客 cookie（相当于新开一个无痕游客）并保存。"""
    r = requests.post(
        "https://visitor.passport.weibo.cn/visitor/genvisitor2",
        data={"cb": "visitor_gray_callback", "tid": "", "from": "weibo"},
        headers={"User-Agent": UA},
        timeout=TIMEOUT,
    )
    m = re.search(r"visitor_gray_callback\((.*)\)", r.text, re.S)
    d = json.loads(m.group(1))["data"]
    ck = f"SUB={d['sub']}; SUBP={d['subp']}"
    _weibo_ck["value"] = ck
    try:
        os.makedirs(os.path.dirname(WEIBO_COOKIE_PATH), exist_ok=True)
        with open(WEIBO_COOKIE_PATH, "w", encoding="utf-8") as f:
            f.write(ck)
    except OSError:
        pass
    return ck


def load_watchlist():
    try:
        with open(WATCHLIST_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return {k: data.get(k, []) for k in ("weibo", "xueqiu", "wechat", "x", "rss")}
    except FileNotFoundError:
        return {"weibo": [], "xueqiu": [], "wechat": [], "x": [], "rss": []}


def _weibo_api(uid, cookie):
    r = requests.get(
        "https://m.weibo.cn/api/container/getIndex",
        params={"type": "uid", "value": uid, "containerid": f"107603{uid}"},
        headers={"User-Agent": UA, "Referer": f"https://m.weibo.cn/u/{uid}", "Cookie": cookie},
        timeout=TIMEOUT,
    )
    try:
        return r.json()
    except ValueError:
        return {"ok": -1}


class WeiboRateLimited(RuntimeError):
    """ok=-100：IP 级频控，本轮应停止继续请求微博接口。"""


def fetch_weibo_user(uid):
    data = _weibo_api(uid, _weibo_cookie())
    if data.get("ok") != 1:
        data = _weibo_api(uid, _renew_weibo_cookie())
    if data.get("ok") == -100:
        raise WeiboRateLimited("weibo api ok=-100 (IP 频控，跳过本轮剩余微博)")
    if data.get("ok") != 1:
        raise RuntimeError(f"weibo api ok={data.get('ok')} (游客 cookie 自动续期后仍失败)")
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


def _xueqiu_cookie():
    ck = os.environ.get("XUEQIU_COOKIE", "").strip()
    if not ck:
        try:
            with open(XUEQIU_COOKIE_PATH, encoding="utf-8") as f:
                ck = f.read().strip()
        except FileNotFoundError:
            ck = ""
    return ck


def fetch_xueqiu_user(user_id):
    s = requests.Session()
    s.headers["User-Agent"] = UA
    ck = _xueqiu_cookie()
    if ck:
        s.headers["Cookie"] = ck
    else:
        s.get("https://xueqiu.com/about", timeout=TIMEOUT)  # 领 xq_a_token 匿名令牌
    r = s.get(
        "https://xueqiu.com/v4/statuses/user_timeline.json",
        params={"user_id": user_id, "page": 1, "count": 20},
        headers={"Referer": f"https://xueqiu.com/u/{user_id}"},
        timeout=TIMEOUT,
    )
    if b"aliyun_waf" in r.content[:1000] or b"renderData" in r.content[:200]:
        raise RuntimeError("雪球 WAF 滑块拦截（机房 IP 常见），可配置 XUEQIU_COOKIE 或 data/xueqiu_cookie.txt")
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


def _parse_pubdate(pub):
    """兼容 RFC822 和 '2026-06-11 19:00:00 +0800' 等变体。

    缺失或解析失败时返回 0（"无可信时间"哨兵），交由 timefix 锚定 first_seen，
    不再无脑当成入库当下时间而污染突发归日。
    """
    if not pub:
        return 0
    try:
        return int(email.utils.parsedate_to_datetime(pub).timestamp())
    except Exception:  # noqa: BLE001
        pass
    try:
        return int(time.mktime(time.strptime(" ".join(pub.split()), "%Y-%m-%d %H:%M:%S %z")))
    except Exception:  # noqa: BLE001
        return 0


def fetch_rss(url, source_name):
    """通用 RSS 抓取，返回统一格式条目。"""
    r = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT)
    if r.status_code != 200 or (b"<rss" not in r.content[:500] and b"<feed" not in r.content[:500] and b"<?xml" not in r.content[:200]):
        raise RuntimeError(f"{url} -> HTTP {r.status_code} 非 RSS")
    text = r.content.decode(r.apparent_encoding or "utf-8", "ignore")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)  # XML 1.0 非法控制字符
    try:
        root = ET.fromstring(text.encode("utf-8"))
    except ET.ParseError:
        text = re.sub(r"&(?!#?\w+;)", "&amp;", text)  # 未转义的裸 &
        root = ET.fromstring(text.encode("utf-8"))
    out = []
    for it in root.iter("item"):
        link = (it.findtext("link") or "").strip()
        ts = _parse_pubdate(it.findtext("pubDate"))
        out.append({
            "id": _mkid("rss", link or it.findtext("guid") or it.findtext("title") or ""),
            "source": source_name,
            "title": _strip_html(it.findtext("title") or ""),
            "content": _strip_html(it.findtext("description") or "")[:2000],
            "url": link,
            "ts": ts,
        })
    return out


_w2r_map = {"value": None}


def _wechat2rss_map():
    """Wechat2RSS 公益库的 公众号名 -> feed 地址 映射（运行期拉取并缓存）。"""
    if _w2r_map["value"] is not None:
        return _w2r_map["value"]
    r = requests.get("https://wechat2rss.xlab.app/list/all.html", headers={"User-Agent": UA}, timeout=TIMEOUT)
    mapping = {}
    for url, name in re.findall(r'href="(https://wechat2rss\.xlab\.app/feed/[a-f0-9]+\.xml)"[^>]*>([^<]+)</a>', r.text):
        mapping[name.strip()] = url
    _w2r_map["value"] = mapping
    return mapping


def fetch_wechat_account(name):
    # dict entry: {"name": "公众号名", "url": "http://localhost:8090/feed/xxx.xml"}
    if isinstance(name, dict):
        url = name.get("url", "")
        display = name.get("name", url.rsplit("/", 1)[-1])
        return fetch_rss(url, f"公众号@{display}")
    if name.startswith("http"):
        return fetch_rss(name, f"公众号@{name.rsplit('/', 1)[-1]}")
    url = _wechat2rss_map().get(name)
    if not url:
        raise RuntimeError(f"Wechat2RSS 公益库未收录「{name}」，可改填自建 feed 直链")
    items = fetch_rss(url, f"公众号@{name}")
    return items


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
                ts = int(email.utils.parsedate_to_datetime(pub).timestamp()) if pub else 0
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
    weibo_uids = wl["weibo"]
    for i, uid in enumerate(weibo_uids):
        try:
            items.extend(fetch_weibo_user(uid))
        except WeiboRateLimited as e:
            # 熔断：频控时不再硬打（越打封越久），本轮剩余博主下轮再抓
            errors["weibo:_rate_limited"] = f"{e} (剩余 {len(weibo_uids) - i - 1} 个本轮跳过)"
            break
        except Exception as e:  # noqa: BLE001
            errors[f"weibo:{uid}"] = str(e)
        time.sleep(WEIBO_SLEEP)  # 频控保护：拉长单号间隔
    for uid in wl["xueqiu"]:
        try:
            items.extend(fetch_xueqiu_user(uid))
        except Exception as e:  # noqa: BLE001
            errors[f"xueqiu:{uid}"] = str(e)
    for name in wl["wechat"]:
        try:
            items.extend(fetch_wechat_account(name))
        except Exception as e:  # noqa: BLE001
            key = name.get("name", name.get("url", "")) if isinstance(name, dict) else name
            errors[f"wechat:{key}"] = str(e)
    for user in wl["x"]:
        try:
            items.extend(fetch_x_user(user))
        except Exception as e:  # noqa: BLE001
            errors[f"x:{user}"] = str(e)
    for entry in wl.get("rss", []):
        name, url = entry.get("name", entry.get("url", "")), entry.get("url", "")
        try:
            items.extend(fetch_rss(url, name))
        except Exception as e:  # noqa: BLE001
            errors[f"rss:{name}"] = str(e)

    # === Native X supplement (preferred for reliability) ===
    # Populated by asking the agent to use built-in X tools (x_keyword_search etc.)
    # and saving the normalized items to data/x_grok.json
    # Falls back to (or augments) the RSS/Nitter path for "x" users.
    try:
        native_items = load_grok_items()
        if native_items:
            items.extend(native_items)
            # optional: mark how many
    except Exception as e:  # noqa: BLE001
        errors["x:native"] = str(e)

    return items, errors
