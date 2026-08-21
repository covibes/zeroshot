#!/bin/sh
set -eu

if [ -n "${ZEROSHOT_TARGET_BOOTSTRAP_KEY:-}" ]; then
  bootstrap_directory=/run/zeroshot-target
  bootstrap_file=${bootstrap_directory}/bootstrap.key
  umask 077
  install -d -m 0700 "${bootstrap_directory}"
  printf '%s' "${ZEROSHOT_TARGET_BOOTSTRAP_KEY}" > "${bootstrap_file}"
  chmod 0600 "${bootstrap_file}"
  unset ZEROSHOT_TARGET_BOOTSTRAP_KEY
  set -- "$@" --bootstrap-key-file "${bootstrap_file}"
fi

exec /usr/local/bin/zeroshot-rust "$@"
