#!/bin/sh
set -eu

export STORAGE_DIR="${STORAGE_DIR:-/data/storage}"
export DATA_DIR="${DATA_DIR:-/data/forecast}"
export PORT=3000
export TRUST_PROXY="${TRUST_PROXY:-loopback,uniquelocal}"
export COOKIE_SECURE="${COOKIE_SECURE:-true}"

mkdir -p "$STORAGE_DIR" "$DATA_DIR"
for file in seasonal_forecast.csv routes.csv; do
  if [ ! -e "$DATA_DIR/$file" ]; then
    cp -n "/app/data/$file" "$DATA_DIR/$file"
  fi
done

exec node --disable-warning=ExperimentalWarning /app/dist/node/server/index.js
