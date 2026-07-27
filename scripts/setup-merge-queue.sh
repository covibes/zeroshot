#!/bin/bash

set -euo pipefail

REPO="the-open-engine/zeroshot"
MAIN_RULESET_NAME="Protect main trunk"
TAG_RULESET_NAME="Make release tags immutable"

if ! gh auth status &>/dev/null; then
  echo "ERROR: Authenticate GitHub CLI with: gh auth login"
  exit 1
fi

if [[ "$(gh api "repos/$REPO" --jq '.permissions.admin')" != "true" ]]; then
  echo "ERROR: Repository admin access is required"
  exit 1
fi

upsert_ruleset() {
  local name="$1"
  local payload="$2"
  local id
  id="$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id" | head -1)"
  if [[ -n "$id" ]]; then
    gh api --method PUT "repos/$REPO/rulesets/$id" --input "$payload" >/dev/null
  else
    gh api --method POST "repos/$REPO/rulesets" --input "$payload" >/dev/null
  fi
}

main_payload="$(mktemp)"
tag_payload="$(mktemp)"
trap 'rm -f "$main_payload" "$tag_payload"' EXIT

cat > "$main_payload" <<'JSON'
{
  "name": "Protect main trunk",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "required_linear_history"},
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "required_reviewers": [],
        "require_code_owner_review": false,
        "dismissal_restriction": {
          "enabled": false,
          "allowed_actors": []
        },
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          {"context": "required", "integration_id": 15368},
          {"context": "semantic", "integration_id": 15368}
        ]
      }
    },
    {
      "type": "merge_queue",
      "parameters": {
        "check_response_timeout_minutes": 30,
        "grouping_strategy": "ALLGREEN",
        "max_entries_to_build": 5,
        "max_entries_to_merge": 5,
        "merge_method": "SQUASH",
        "min_entries_to_merge": 1,
        "min_entries_to_merge_wait_minutes": 1
      }
    }
  ],
  "bypass_actors": []
}
JSON

cat > "$tag_payload" <<'JSON'
{
  "name": "Make release tags immutable",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/tags/v*"],
      "exclude": []
    }
  },
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"}
  ],
  "bypass_actors": []
}
JSON

upsert_ruleset "$MAIN_RULESET_NAME" "$main_payload"
upsert_ruleset "$TAG_RULESET_NAME" "$tag_payload"

gh api --method PATCH "repos/$REPO" --input - <<'JSON' >/dev/null
{
  "allow_squash_merge": true,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "squash_merge_commit_title": "PR_TITLE",
  "squash_merge_commit_message": "PR_BODY",
  "delete_branch_on_merge": true,
  "allow_auto_merge": true
}
JSON

gh api --method PUT "repos/$REPO/environments/release" --input - <<'JSON' >/dev/null
{
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
JSON

if ! gh api "repos/$REPO/environments/release/deployment-branch-policies" \
  --jq '.branch_policies[] | select(.name == "main") | .id' | grep -q .; then
  gh api --method POST "repos/$REPO/environments/release/deployment-branch-policies" \
    -f name=main -f type=branch >/dev/null
fi

gh variable set RELEASE_AUTOMATION_ENABLED --repo "$REPO" --body false

if gh api "repos/$REPO/branches/main/protection" >/dev/null 2>&1; then
  gh api --method DELETE "repos/$REPO/branches/main/protection"
fi

while IFS= read -r ruleset_id; do
  [[ -n "$ruleset_id" ]] && gh api --method DELETE "repos/$REPO/rulesets/$ruleset_id"
done < <(
  gh api "repos/$REPO/rulesets" \
    --jq '.[] | select(.name == "dev-merge-queue" or .name == "main-merge-queue") | .id'
)

echo "Configured protected main trunk, merge queue, immutable release tags, and disabled release automation."
