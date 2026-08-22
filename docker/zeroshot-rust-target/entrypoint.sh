#!/bin/sh
set -eu

if [ -n "${ZEROSHOT_TARGET_BOOTSTRAP_KEY:-}" ]; then
  previous_umask=$(umask)
  umask 077
  bootstrap_file=$(mktemp /tmp/zeroshot-target-bootstrap.XXXXXX)
  trap 'rm -f "${bootstrap_file}"' EXIT HUP INT TERM
  printf '%s' "${ZEROSHOT_TARGET_BOOTSTRAP_KEY}" > "${bootstrap_file}"
  chmod 0600 "${bootstrap_file}"
  umask "${previous_umask}"
  unset ZEROSHOT_TARGET_BOOTSTRAP_KEY
  set -- "$@" --bootstrap-key-file "${bootstrap_file}"
fi

exec /usr/local/bin/zeroshot-rust "$@"
