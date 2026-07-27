#!/bin/bash
# Setup GitHub merge queue and branch protection for zeroshot
# Run once after creating the repo or to update settings

set -e

REPO="the-open-engine/zeroshot"

echo "╔═══════════════════════════════════════════════════════════════════╗"
echo "║  Setting up merge queue for $REPO                         ║"
echo "╚═══════════════════════════════════════════════════════════════════╝"
echo ""

# Check gh is authenticated
if ! gh auth status &>/dev/null; then
  echo "❌ ERROR: Not authenticated with GitHub CLI"
  echo "   Run: gh auth login"
  exit 1
fi

# Check we have admin access
if ! gh api "repos/$REPO" --jq '.permissions.admin' | grep -q true; then
  echo "❌ ERROR: You need admin access to $REPO"
  exit 1
fi

echo "✓ Authenticated with admin access"
echo ""

# ============================================================================
# Configure 'main' branch protection (single trunk)
# ============================================================================

echo "→ Configuring 'main' branch protection..."

gh api --method PUT "repos/$REPO/branches/main/protection" \
  --input - <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["check", "install-matrix (ubuntu-latest, 20)", "install-matrix (macos-latest, 20)"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": true,
  "required_conversation_resolution": false
}
EOF

echo "✓ 'main' branch protection configured"

# Enable merge queue for main branch
echo "→ Enabling merge queue for 'main' branch..."

# Note: Merge queue requires GitHub Enterprise or public repos with Actions
# Using the ruleset API which supports merge queue
RULESET_NAME="main-merge-queue"
RULESET_ID="$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$RULESET_NAME\") | .id" | head -1)"
if [[ -n "$RULESET_ID" ]]; then
  RULESET_METHOD="PUT"
  RULESET_ENDPOINT="repos/$REPO/rulesets/$RULESET_ID"
else
  RULESET_METHOD="POST"
  RULESET_ENDPOINT="repos/$REPO/rulesets"
fi

gh api --method "$RULESET_METHOD" "$RULESET_ENDPOINT" \
  --input - <<EOF
{
  "name": "$RULESET_NAME",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "rules": [
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
  ]
}
EOF

echo "✓ Merge queue enabled for 'main'"

# ============================================================================
# Configure repository settings
# ============================================================================

echo "→ Configuring repository settings..."

gh api --method PATCH "repos/$REPO" \
  --input - <<EOF
{
  "allow_squash_merge": true,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "squash_merge_commit_title": "PR_TITLE",
  "squash_merge_commit_message": "PR_BODY",
  "delete_branch_on_merge": true,
  "allow_auto_merge": true
}
EOF

echo "✓ Repository settings configured"

# ============================================================================
# Summary
# ============================================================================

echo ""
echo "╔═══════════════════════════════════════════════════════════════════╗"
echo "║  ✓ Merge queue setup complete!                                    ║"
echo "╚═══════════════════════════════════════════════════════════════════╝"
echo ""
echo "Workflow:"
echo "  feature-branch (local)"
echo "  ↓"
echo "  pre-push hook → lint + typecheck (~5s)"
echo "  ↓"
echo "  push to origin/feature-branch"
echo "  ↓"
echo "  gh pr create --base main"
echo "  ↓"
echo "  CI runs tests on PR branch"
echo "  ↓"
echo "  gh pr merge --auto --squash → enters merge queue"
echo "  ↓"
echo "  Queue rebases PR on latest main + runs CI again"
echo "  ↓"
echo "  Merge to main (only if CI passes on rebased code)"
echo ""
echo "Release workflow:"
echo "  Conventional PR title selects patch/minor/major"
echo "  → merge to main → CI passes → semantic-release publishes"
echo ""
