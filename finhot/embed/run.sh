#!/bin/zsh
# Launches the local bge-m3 embedding server on 127.0.0.1:8077.
# Runs from this script's own directory; install location is up to you (e.g. ~/finhot-embed).
cd "$(dirname "$0")" || exit 1
exec .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8077
