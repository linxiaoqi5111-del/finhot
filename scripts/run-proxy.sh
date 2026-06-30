#!/bin/bash
# Route local HTTP(S) traffic through mitmproxy for FinHot dev
# (focal.local -> localhost:2233 via scripts/mitproxy.py).
#
# SAFETY:
# - The system proxy is ALWAYS restored on exit (trap EXIT + INT/TERM), so a
#   crash or Ctrl-C never leaves the machine stuck pointing at a dead local
#   port (which could later route traffic through whatever binds that port).
# - Upstream TLS verification stays ON by default. Only disable it (for a
#   self-signed local target) with:
#       MITM_SSL_INSECURE=1 bash scripts/run-proxy.sh
set -u

PROXY_HOST="127.0.0.1"
PROXY_PORT="8080"

# Optional: limit to specific space-separated network services, e.g.
#   PROXY_SERVICES="Wi-Fi" bash scripts/run-proxy.sh
# Default (empty) = all enabled services.
PROXY_SERVICES="${PROXY_SERVICES:-}"

# Disable upstream TLS verification for ALL upstreams (DANGEROUS). Default off.
MITM_SSL_INSECURE="${MITM_SSL_INSECURE:-0}"

services() {
  if [ -n "$PROXY_SERVICES" ]; then
    printf '%s\n' $PROXY_SERVICES
  else
    # Skip the header line and disabled services (prefixed with '*').
    networksetup -listallnetworkservices | tail -n +2 | grep -v '^\*'
  fi
}

enable_proxy() {
  echo "Enabling proxy on $PROXY_HOST:$PROXY_PORT..."
  services | while IFS= read -r svc; do
    [ -z "$svc" ] && continue
    networksetup -setwebproxy "$svc" "$PROXY_HOST" "$PROXY_PORT"
    networksetup -setsecurewebproxy "$svc" "$PROXY_HOST" "$PROXY_PORT"
    networksetup -setwebproxystate "$svc" on
    networksetup -setsecurewebproxystate "$svc" on
  done
  echo "Proxy enabled."
}

disable_proxy() {
  echo "Disabling proxy..."
  services | while IFS= read -r svc; do
    [ -z "$svc" ] && continue
    networksetup -setwebproxystate "$svc" off
    networksetup -setsecurewebproxystate "$svc" off
  done
  echo "Proxy disabled."
}

# Always restore proxy state, however we exit (normal, error, Ctrl-C, kill).
trap disable_proxy EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

enable_proxy

ssl_flag=""
echo "=================================================================="
echo " WARNING: system proxy is ACTIVE — local HTTPS is being intercepted."
if [ "$MITM_SSL_INSECURE" = "1" ]; then
  ssl_flag="--ssl-insecure"
  echo " WARNING: MITM_SSL_INSECURE=1 — upstream TLS verification DISABLED."
else
  echo "          Upstream TLS verification ON (MITM_SSL_INSECURE=1 to disable)."
fi
echo "          Proxy auto-restores when this script exits."
echo "=================================================================="

echo "Starting mitmproxy..."
mitmproxy -s scripts/mitproxy.py ${ssl_flag}
