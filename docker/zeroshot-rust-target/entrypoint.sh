#!/bin/sh
set -eu

if [ -n "${ZEROSHOT_TARGET_BOOTSTRAP_KEY:-}" ]; then
  bootstrap_file=/tmp/zeroshot-target-bootstrap.key
  previous_umask=$(umask)
  umask 077
  printf '%s' "${ZEROSHOT_TARGET_BOOTSTRAP_KEY}" > "${bootstrap_file}"
  chmod 0600 "${bootstrap_file}"
  umask "${previous_umask}"
  unset ZEROSHOT_TARGET_BOOTSTRAP_KEY
  set -- "$@" --bootstrap-key-file "${bootstrap_file}"
fi

exec /usr/local/bin/zeroshot-rust "$@"
