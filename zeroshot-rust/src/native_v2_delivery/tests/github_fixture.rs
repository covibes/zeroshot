use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use async_trait::async_trait;
use openengine_cluster_testkit::assertions::AssertValue;

use super::*;

#[derive(Clone, Copy)]
pub(super) enum Script {
    NoCi,
    CiFailed,
    Conflict,
    ConflictAtMerge,
    RegistrationRace,
    MultipleRegistrationWaves,
    DeferredMerge,
    ProtectedBranch,
    ReviewSyncRace,
    CiFailsThenMerges,
    NeverConfirmsMerge,
    CredentialExpires,
}

pub(super) struct FakeGitHub {
    remote: PathBuf,
    script: Script,
    pub(super) pushed: AtomicBool,
    merge_requested: AtomicBool,
    pub(super) merge_requests: AtomicUsize,
    pub(super) inspections: AtomicUsize,
    pub(super) reviews: Mutex<Vec<GitHubReviewRequest>>,
    pub(super) review_sync_attempts: AtomicUsize,
}

impl FakeGitHub {
    pub(super) fn new(remote: PathBuf, script: Script) -> Self {
        Self {
            remote,
            script,
            pushed: AtomicBool::new(false),
            merge_requested: AtomicBool::new(false),
            merge_requests: AtomicUsize::new(0),
            inspections: AtomicUsize::new(0),
            reviews: Mutex::new(Vec::new()),
            review_sync_attempts: AtomicUsize::new(0),
        }
    }

    fn review_state(&self, inspection: usize) -> GitHubReviewState {
        match self.script {
            Script::NoCi | Script::CredentialExpires | Script::ReviewSyncRace => self.no_ci_state(),
            Script::RegistrationRace => self.registration_race_state(inspection),
            Script::MultipleRegistrationWaves => self.multiple_registration_waves_state(inspection),
            Script::CiFailsThenMerges => self.ci_repair_state(inspection),
            _ => self.static_review_state(),
        }
    }

    fn static_review_state(&self) -> GitHubReviewState {
        match self.script {
            Script::CiFailed => open_review(failed_checks()),
            Script::Conflict => GitHubReviewState::Conflict,
            Script::ConflictAtMerge => open_review(GitHubChecks::NotRequired),
            Script::DeferredMerge => self.no_ci_state(),
            Script::ProtectedBranch | Script::NeverConfirmsMerge => {
                open_review(GitHubChecks::Passed)
            }
            _ => open_review(GitHubChecks::Pending),
        }
    }

    fn no_ci_state(&self) -> GitHubReviewState {
        if self.merge_requested.load(Ordering::SeqCst) {
            merged_review()
        } else {
            open_review(GitHubChecks::NotRequired)
        }
    }

    fn ci_repair_state(&self, inspection: usize) -> GitHubReviewState {
        if inspection == 1 {
            return open_review(failed_checks());
        }
        if self.merge_requested.load(Ordering::SeqCst) {
            merged_review()
        } else {
            open_review(GitHubChecks::Passed)
        }
    }

    fn registration_race_state(&self, inspection: usize) -> GitHubReviewState {
        if self.merge_requested.load(Ordering::SeqCst) {
            merged_review()
        } else if inspection == 1 {
            open_review(GitHubChecks::NotRequired)
        } else {
            open_review(GitHubChecks::Passed)
        }
    }

    fn multiple_registration_waves_state(&self, inspection: usize) -> GitHubReviewState {
        if self.merge_requested.load(Ordering::SeqCst) {
            merged_review()
        } else if matches!(inspection, 2 | 4) {
            open_review(GitHubChecks::Pending)
        } else {
            open_review(GitHubChecks::Passed)
        }
    }

    fn merge_is_pending(&self) -> bool {
        let requests = self.merge_requests.load(Ordering::SeqCst);
        match self.script {
            Script::ProtectedBranch => true,
            Script::DeferredMerge => requests <= 4,
            Script::RegistrationRace => requests == 1,
            Script::MultipleRegistrationWaves => requests <= 2,
            _ => false,
        }
    }
}

fn merged_review() -> GitHubReviewState {
    GitHubReviewState::Merged {
        merge_revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
    }
}

fn open_review(checks: GitHubChecks) -> GitHubReviewState {
    GitHubReviewState::Open { checks }
}

fn failed_checks() -> GitHubChecks {
    GitHubChecks::Failed {
        diagnostic: "Required CI checks failed:\n- hidden policy concluded failure".to_owned(),
    }
}

#[async_trait]
impl GitHubDeliveryAuthority for FakeGitHub {
    async fn push_branch(
        &self,
        request: &GitHubPushRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<(), GitHubAuthorityError> {
        assert_eq!(credential.expose(), "test-token");
        let status = tokio::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&request.workspace)
            .arg("push")
            .arg(&self.remote)
            .arg(format!("HEAD:refs/heads/{}", request.head_branch))
            .status()
            .await
            .assert_value();
        if !status.success() {
            return Err(GitHubAuthorityError::Rejected);
        }
        self.pushed.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn open_or_update_review(
        &self,
        request: &GitHubReviewRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubReviewReceipt, GitHubAuthorityError> {
        assert_eq!(credential.expose(), "test-token");
        assert!(self.pushed.load(Ordering::SeqCst));
        let attempt = self.review_sync_attempts.fetch_add(1, Ordering::SeqCst) + 1;
        if matches!(self.script, Script::ReviewSyncRace) && attempt == 1 {
            return Err(GitHubAuthorityError::Rejected);
        }
        self.reviews
            .lock()
            .assert_value_with("review request lock")
            .push(request.clone());
        Ok(GitHubReviewReceipt {
            review_id: "17".to_owned(),
            repository: request.target.repository.clone(),
            target_branch: request.target.target_branch.clone(),
            head_branch: request.head_branch.clone(),
            head_revision: request.head_revision.clone(),
        })
    }

    async fn inspect_review(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubReviewObservation, GitHubAuthorityError> {
        let inspection = self.inspections.fetch_add(1, Ordering::SeqCst) + 1;
        if matches!(self.script, Script::CredentialExpires) && credential.expose() == "test-token" {
            return Err(GitHubAuthorityError::Rejected);
        }
        let expected = if matches!(self.script, Script::CredentialExpires) {
            "refreshed-token"
        } else {
            "test-token"
        };
        assert_eq!(credential.expose(), expected);
        let state = self.review_state(inspection);
        Ok(review.observation(state))
    }

    async fn request_merge(
        &self,
        _review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubMergeRequestOutcome, GitHubAuthorityError> {
        let expected = if matches!(self.script, Script::CredentialExpires) {
            "refreshed-token"
        } else {
            "test-token"
        };
        assert_eq!(credential.expose(), expected);
        self.merge_requests.fetch_add(1, Ordering::SeqCst);
        if matches!(self.script, Script::ConflictAtMerge) {
            return Ok(GitHubMergeRequestOutcome::Conflict);
        }
        if self.merge_is_pending() {
            return Ok(GitHubMergeRequestOutcome::Pending);
        }
        self.merge_requested.store(true, Ordering::SeqCst);
        Ok(GitHubMergeRequestOutcome::Accepted)
    }
}

pub(super) fn write_executable(directory: &Path, name: &str, contents: &str) -> PathBuf {
    let path = directory.join(name);
    fs::write(&path, contents).assert_value();
    let mut permissions = fs::metadata(&path).assert_value().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&path, permissions).assert_value();
    path
}

pub(super) fn argument_lines(capture: &str) -> String {
    capture
        .lines()
        .filter(|line| line.starts_with("arg="))
        .collect::<Vec<_>>()
        .join("\n")
}

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
  repos/acme/project/pulls/17:PATCH)
    /usr/bin/printf '%s%s%s%s%s\n' \
      '{"number":17,"body":"Created by Zeroshot v2.\\n\\nCloses #208","state":"open",' \
      '"merged":false,"merge_commit_sha":null,"base":' \
      '{"ref":"main","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repo":{"full_name":"acme/project"}},' \
      '"head":{"ref":"zeroshot/v2-test","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",' \
      '"repo":{"full_name":"acme/project"}}}'
    ;;
  repos/acme/project/issues/208:GET)
    /usr/bin/printf '%s\n' '{"comments":0}'
    ;;
  repos/acme/project/issues/208/comments:GET)
    /usr/bin/printf '%s\n' '[]'
    ;;
  repos/acme/project/issues/208/comments:POST)
    /usr/bin/printf '%s\n' '{"id":71}'
    ;;
  graphql:GET)
    /usr/bin/printf '%s%s%s%s%s%s\n' \
      '[{"data":{"repository":{"nameWithOwner":"acme/project","mergeCommitAllowed":true,' \
      '"squashMergeAllowed":true,"rebaseMergeAllowed":true,"pullRequest":{' \
      '"number":17,"state":"OPEN","merged":false,"mergeCommit":null,' \
      '"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","isDraft":false,' \
      '"isInMergeQueue":false,"isMergeQueueEnabled":false,"baseRefName":"main",' \
      '"headRefName":"zeroshot/v2-test",' \
      '"headRefOid":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","commits":{"nodes":[{' \
      '"commit":{"statusCheckRollup":null}}]}}}}}]'
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
  merge:GET)
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

#[test]
fn hosted_delivery_polling_has_no_work_duration_limit() {
    assert!(DeliveryPollPolicy::default().has_next(usize::MAX));
    assert!(
        !DeliveryPollPolicy::new(3, Duration::ZERO)
            .assert_value()
            .has_next(3)
    );
}
