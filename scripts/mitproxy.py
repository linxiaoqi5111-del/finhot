from mitmproxy import http
import os

def request(flow: http.HTTPFlow) -> None:
    if flow.request.pretty_host == os.getenv("FOCAL_PROXY_HOST", "focal.local"):
        flow.request.host = os.getenv("FOCAL_PROXY_TARGET_HOST", "localhost")
        flow.request.port = int(os.getenv("FOCAL_PROXY_TARGET_PORT", "2233"))