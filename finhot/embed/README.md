# finhot-embed — 本地 bge-m3 向量服务

OpenAI 兼容的本地 embedding 服务，基于 `BAAI/bge-m3`（1024 维稠密向量，L2 归一化）。
给 finhot 的服务端富集（`rss-proxy.ts`）补向量用，**零 API token 成本**，只耗本机算力。

聚簇（`buildClusterLeaders`）需要条目带 embedding 才能按语义跨号聚合；没有向量就退化成按标签/标题分桶。

## 接口

- `GET  /health` → `{"ok":true,"model":"BAAI/bge-m3","dimension":1024}`
- `GET  /v1/models`
- `POST /v1/embeddings` → OpenAI 兼容，body `{"model":"bge-m3","input":"..."|["...","..."]}`

默认监听 `127.0.0.1:8077`。

## 安装（Mac，复用知识库 venv 或新建）

```bash
mkdir -p ~/finhot-embed && cd ~/finhot-embed
cp /path/to/repo/finhot/embed/{server.py,run.sh} .
python3 -m venv .venv
.venv/bin/pip install -r /path/to/repo/finhot/embed/requirements.txt
chmod +x run.sh
./run.sh   # 手动起一次验证
curl http://127.0.0.1:8077/health
```

> 首次运行会从 HuggingFace 拉 bge-m3（约 2GB）。若已在知识库下载过
> （`~/.cache/huggingface/hub/models--BAAI--bge-m3`）会直接复用。

## 开机常驻（LaunchAgent）

```bash
cp /path/to/repo/finhot/embed/com.finhot.embed.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.finhot.embed.plist
launchctl list | grep finhot   # 确认在跑
```

`KeepAlive=true` + `RunAtLoad=true`：开机自启、崩溃自动重启。日志在 `~/finhot-embed/server.log`。

## 接到 finhot

在启动 rss-proxy 的脚本（如 `finhot-devweb.sh`）里设置环境变量，富集时即会对
“过门槛、要上公网”的条目调用本服务补向量：

```bash
export FINHOT_EMBEDDING_BASE_URL="http://localhost:8077/v1"
export FINHOT_EMBEDDING_MODEL="bge-m3"   # 可选，默认 bge-m3
```

不设 `FINHOT_EMBEDDING_BASE_URL` 时该功能为 no-op（CI / 其他环境零影响）。
