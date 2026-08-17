pub(super) const GH_SCRIPT: &str = r#"#!/bin/sh
set -eu
capture="${0}.capture"
{
  /usr/bin/printf '%s\n' '---'
  /usr/bin/printf 'token=%s\n' "${GH_TOKEN-unset}"
  /usr/bin/printf 'host=%s\n' "${GH_HOST-unset}"
  /usr/bin/printf 'home=%s\n' "${HOME-unset}"
  /usr/bin/printf 'path=%s\n' "${PATH-unset}"
  for argument in "$@"; do /usr/bin/printf 'arg=%s\n' "$argument"; done
} >> "$capture"
endpoint=$2
method=GET
previous=
for argument in "$@"; do
  if [ "$previous" = "--method" ]; then method=$argument; fi
  previous=$argument
done
case "$endpoint:$method" in
  repos/acme/project/pulls:GET)
    /usr/bin/printf '%s\n' '[]'
    ;;
  repos/acme/project/pulls:POST)
    /usr/bin/printf '%s%s%s%s\n' \
      '{"number":17,"state":"open","merged":false,"merge_commit_sha":null,"base":' \
      '{"ref":"main","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repo":{"full_name":"acme/project"}},' \
      '"head":{"ref":"zeroshot/v2-test","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",' \
      '"repo":{"full_name":"acme/project"}}}'
    ;;
  repos/acme/project/pulls/17:GET)
    /usr/bin/printf '%s%s%s%s\n' \
      '{"number":17,"state":"open","merged":false,"merge_commit_sha":null,"base":' \
      '{"ref":"main","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repo":{"full_name":"acme/project"}},' \
      '"head":{"ref":"zeroshot/v2-test","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",' \
      '"repo":{"full_name":"acme/project"}}}'
    ;;
  repos/acme/project/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs:GET)
    /usr/bin/printf '%s\n' '{"total_count":0,"check_runs":[]}'
    ;;
  repos/acme/project/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/status:GET)
    /usr/bin/printf '%s\n' '{"state":"pending","statuses":[]}'
    ;;
  repos/acme/project/pulls/17/merge:PUT)
    /usr/bin/printf '%s\n' '{"merged":true,"sha":"cccccccccccccccccccccccccccccccccccccccc"}'
    ;;
  *) exit 19 ;;
esac
"#;

pub(super) const GIT_SCRIPT: &str = r#"#!/bin/sh
set -eu
capture="${0}.capture"
{
  /usr/bin/printf '%s\n' '---'
  /usr/bin/printf 'token=%s\n' "${GH_TOKEN-unset}"
  /usr/bin/printf 'home=%s\n' "${HOME-unset}"
  /usr/bin/printf 'path=%s\n' "${PATH-unset}"
  /usr/bin/printf 'config_count=%s\n' "${GIT_CONFIG_COUNT-unset}"
  /usr/bin/printf 'config_key_1=%s\n' "${GIT_CONFIG_KEY_1-unset}"
  /usr/bin/printf 'config_value_1=%s\n' "${GIT_CONFIG_VALUE_1-unset}"
  for argument in "$@"; do /usr/bin/printf 'arg=%s\n' "$argument"; done
} >> "$capture"
"#;

pub(super) const GH_MISMATCH_SCRIPT: &str = r#"#!/bin/sh
/usr/bin/printf '%s%s%s%s\n' \
  '[{"number":17,"state":"open","merged":false,"merge_commit_sha":null,"base":' \
  '{"ref":"other","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repo":{"full_name":"acme/project"}},' \
  '"head":{"ref":"zeroshot/v2-test","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",' \
  '"repo":{"full_name":"acme/project"}}}]'
"#;
