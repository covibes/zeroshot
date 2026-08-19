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
    ReviewSyncRace,
    CiFailsThenMerges,
    NeverConfirmsMerge,
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
            Script::NoCi => self.no_ci_state(),
            Script::CiFailed => open_review(failed_checks()),
            Script::Conflict => GitHubReviewState::Conflict,
            Script::ConflictAtMerge => open_review(GitHubChecks::NotRequired),
            Script::RegistrationRace => self.registration_race_state(inspection),
            Script::ReviewSyncRace => self.no_ci_state(),
            Script::CiFailsThenMerges => self.ci_repair_state(inspection),
            Script::NeverConfirmsMerge => open_review(GitHubChecks::Passed),
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
        assert_eq!(credential.expose(), "test-token");
        let inspection = self.inspections.fetch_add(1, Ordering::SeqCst) + 1;
        let state = self.review_state(inspection);
        Ok(review.observation(state))
    }

    async fn request_merge(
        &self,
        _review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubMergeRequestOutcome, GitHubAuthorityError> {
        assert_eq!(credential.expose(), "test-token");
        self.merge_requests.fetch_add(1, Ordering::SeqCst);
        if matches!(self.script, Script::ConflictAtMerge) {
            return Ok(GitHubMergeRequestOutcome::Conflict);
        }
        if matches!(self.script, Script::RegistrationRace)
            && self.merge_requests.load(Ordering::SeqCst) == 1
        {
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
