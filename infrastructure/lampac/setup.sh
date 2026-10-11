#!/bin/sh
set -eu

cd "$(dirname "$0")"
mkdir -p data
umask 077

for name in passwd source-host-secret; do
  path="data/$name"
  if [ ! -s "$path" ]; then
    temp="$path.tmp.$$"
    openssl rand -hex 32 > "$temp"
    mv "$temp" "$path"
  fi
done
