#!/bin/sh
set -eu

: "${SOURCE_HOST_SECRET:?SOURCE_HOST_SECRET must be set to a persistent random secret}"
: "${SOURCE_API_KEY:?SOURCE_API_KEY must be set to the private site-gateway key}"

lampac_pid=
chrome_pid=
node_pid=
cleanup() {
  for pid in "$node_pid" "$chrome_pid" "$lampac_pid"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  for pid in "$node_pid" "$chrome_pid" "$lampac_pid"; do
    [ -n "$pid" ] && wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

if [ -z "${SOURCE_PUBLIC_ORIGIN:-}" ]; then
  if [ -z "${VERCEL_URL:-}" ]; then
    echo "Set SOURCE_PUBLIC_ORIGIN to this container's HTTPS domain" >&2
    exit 1
  fi
  SOURCE_PUBLIC_ORIGIN="https://${VERCEL_URL}"
  export SOURCE_PUBLIC_ORIGIN
fi
case "$SOURCE_PUBLIC_ORIGIN" in
  https://*) ;;
  *) echo "SOURCE_PUBLIC_ORIGIN must use HTTPS" >&2; exit 1 ;;
esac

export SOURCE_ENGINE_URL="${SOURCE_ENGINE_URL:-http://127.0.0.1:9118}"
export SOURCE_ENGINE_READY_FILE="/tmp/lampac-runtime/ready"
engine_start_file="${SOURCE_ENGINE_READY_FILE}.start"
export PORT="${PORT:-9120}"
export HOST="${HOST:-0.0.0.0}"

# The application image may be mounted read-only by the runtime. Lampac reads
# init.conf and passwd from its current working directory, so seed both in /tmp.
runtime_dir="/tmp/lampac-runtime"
mkdir -p "$runtime_dir" "$runtime_dir/cache/module" "$runtime_dir/logs" "$runtime_dir/database" /tmp/chrome-profile
chmod 0700 "$runtime_dir" /tmp/chrome-profile
cp /opt/lampac/vercel.init.conf "$runtime_dir/init.conf"
cp -a /opt/lampac/module-cache/. "$runtime_dir/cache/module/"
engine_key="$(SOURCE_HOST_SECRET="$SOURCE_HOST_SECRET" /usr/local/bin/node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.env.SOURCE_HOST_SECRET).digest("hex").slice(0, 32))')"
printf '%s' "$engine_key" > "$runtime_dir/cache/aeskey"
chmod 0600 "$runtime_dir/cache/aeskey"
export SOURCE_ENGINE_KEY="$engine_key"
printf '%s' "$(printf 'lampac-root:%s' "$SOURCE_HOST_SECRET" | sha256sum | cut -c1-64)" > "$runtime_dir/passwd"
chmod 0600 "$runtime_dir/passwd"
rm -f "$SOURCE_ENGINE_READY_FILE" "$engine_start_file"

# Start the public host as soon as its durable signing keys exist. Direct media
# URLs can then stream during a cold engine/browser startup; discovery and
# resolve wait for SOURCE_ENGINE_READY_FILE in the API process.
/usr/local/bin/node /app/server.mjs &
node_pid=$!

# Media links do not need Lampac or a browser. Keep cold media-only instances
# lightweight; the first metadata request signals provider discovery and waits.
while [ ! -f "$engine_start_file" ]; do
  if ! kill -0 "$node_pid" 2>/dev/null; then
    echo "Source host exited before engine startup was requested" >&2
    exit 1
  fi
  sleep 0.25
done

export DISPLAY=:99

cd /lampac
/usr/share/dotnet/dotnet /lampac/Core.dll &
lampac_pid=$!

# Lampac's Playwright startup creates its hidden :99 virtual display when
# chromium.Headless=false. Wait for that socket before opening headed CDP Chrome.
ready=0
attempt=0
while [ "$attempt" -lt 60 ]; do
  if ! kill -0 "$node_pid" 2>/dev/null; then
    echo "Source host exited during Lampac startup" >&2
    exit 1
  fi
  if ! kill -0 "$lampac_pid" 2>/dev/null; then
    echo "Lampac exited before readiness" >&2
    exit 1
  fi
  if [ -S /tmp/.X11-unix/X99 ] \
    && curl -fsS --max-time 1 http://127.0.0.1:9118/api/chromium/ping >/dev/null; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "Lampac/Playwright did not become ready within 120 seconds" >&2
  exit 1
fi

# Headed Chrome is needed for Zetflix/VideoDB's browser challenge; bind DevTools
# to loopback only. It is never published as a Vercel port or public endpoint.
/usr/bin/chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-profile \
  --window-size=1280,800 \
  about:blank &
chrome_pid=$!

# Fail quickly on a broken browser/core install rather than accepting source
# requests that can never complete.
attempt=0
ready=0
while [ "$attempt" -lt 60 ]; do
  if ! kill -0 "$node_pid" 2>/dev/null; then
    echo "Source host exited during Chrome startup" >&2
    exit 1
  fi
  if ! kill -0 "$chrome_pid" 2>/dev/null; then
    echo "Chrome exited before readiness" >&2
    exit 1
  fi
  if curl -fsS --max-time 1 http://127.0.0.1:9222/json/version >/dev/null; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "Lampac/Chrome did not become ready within 120 seconds" >&2
  exit 1
fi

touch "$SOURCE_ENGINE_READY_FILE"
chmod 0600 "$SOURCE_ENGINE_READY_FILE"
wait "$node_pid"
