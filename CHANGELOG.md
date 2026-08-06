## Unreleased

### Bug Fixes

- **logic-engine:** prevent trigger sandbox evaluation from freezing host prototypes while preserving `return`-based logic scripts; reported in [#496](https://github.com/the-open-engine/zeroshot/pull/496).

### Features

- **hosted:** add the unpublished hardened single-worker OECP capsule runtime and private image for trusted-service deployments ([#888](https://github.com/the-open-engine/zeroshot/issues/888)).

# [5.3.0](https://github.com/covibes/zeroshot/compare/v5.2.1...v5.3.0) (2026-01-12)

### Bug Fixes

- **agent:** filter JSON from error extraction to prevent false matches ([b5833aa](https://github.com/covibes/zeroshot/commit/b5833aac3430f126443c8151cf58ce37a2dd6060))
- **agents:** use modelLevel instead of model in git-pusher-agent ([646da10](https://github.com/covibes/zeroshot/commit/646da109a25d9ee0a5709d975bdf0bfd52df229d))
- clear require-await lint errors ([c96c188](https://github.com/covibes/zeroshot/commit/c96c188d1671813c9e09881619f3e0f66d3f3d39))
- **conductor:** add robustness to prevent silent hang on hook failure ([5453958](https://github.com/covibes/zeroshot/commit/54539588de424fc53438fb51c8f8bd7fbed58768))
- inject completion agent after template loading ([0d92a36](https://github.com/covibes/zeroshot/commit/0d92a3658f9301d2f20dc742eb55a37f181689ad))
- **openai:** Codex CLI structured output support ([999c55b](https://github.com/covibes/zeroshot/commit/999c55beb7b80ca5aa87e006af0ffa37259e0231))
- **orchestrator:** honor --pr in foreground runs ([710466a](https://github.com/covibes/zeroshot/commit/710466aca54e072b464846bda1cba0aef82e4794))
- persist task status and stale recovery ([56f51e0](https://github.com/covibes/zeroshot/commit/56f51e01afde171d31b47088493863521c6e351c))
- **preflight:** use cross-platform command detection for Windows ([adf599c](https://github.com/covibes/zeroshot/commit/adf599c240c4a6f6a4be74ad17f6bcb6005a4726)), closes [#47](https://github.com/covibes/zeroshot/issues/47)
- **race:** poll log file before checking stale output + auto-clean stale locks ([78486e2](https://github.com/covibes/zeroshot/commit/78486e2627c514cd8d054cb4e158083bb66926a2))
- replace cpu-blocking spin-wait with async file locking ([f5bfb0d](https://github.com/covibes/zeroshot/commit/f5bfb0d80a2476d6e38a118c4c5dc4202d9a5921))
- **task-executor:** handle stale task status when watcher dies ([026357b](https://github.com/covibes/zeroshot/commit/026357b5e2af9b3cb19349c28825bb5a38b207da))
- **testers:** require behavioral testing, not code review ([27f9e08](https://github.com/covibes/zeroshot/commit/27f9e08d21055b2a6d58a5121bbe69fe12909893)), closes [#828](https://github.com/covibes/zeroshot/issues/828) [#829](https://github.com/covibes/zeroshot/issues/829) [#830](https://github.com/covibes/zeroshot/issues/830)
- **validator:** recognize zero-length fallback as valid role handling ([474ca9b](https://github.com/covibes/zeroshot/commit/474ca9b217518a23d7895c0872108b8a6599349c))

### Features

- add minModel setting and markdown file input ([e689472](https://github.com/covibes/zeroshot/commit/e6894721776c76c7023c7a87d63d132c9e694568)), closes [#42](https://github.com/covibes/zeroshot/issues/42)
- add model override and fix --pr completion agent ([36fb714](https://github.com/covibes/zeroshot/commit/36fb714fd24265cca2054a9727c32555d4a99a0f))
- add multi-provider CLI support (claude/codex/gemini) ([301fc5f](https://github.com/covibes/zeroshot/commit/301fc5f45148a657cd3e81f3f8b4a267019efc33))
- **validators:** add debugging methodology checks to prevent shortcuts ([85bc462](https://github.com/covibes/zeroshot/commit/85bc462c906a0c6cb716e1cb68bb15dbd091778f))

## [5.2.1](https://github.com/covibes/zeroshot/compare/v5.2.0...v5.2.1) (2026-01-07)

### Bug Fixes

- **git-pusher:** handle clusters without validators ([f4cec4d](https://github.com/covibes/zeroshot/commit/f4cec4d179273cb4d46240cad9b3b19be497690e))

# [5.2.0](https://github.com/covibes/zeroshot/compare/v5.1.0...v5.2.0) (2026-01-07)

### Bug Fixes

- **test:** add retry logic to e2e-claude-command tests ([ed52c86](https://github.com/covibes/zeroshot/commit/ed52c86f86180da02a37616018797acaa58aa764))

### Features

- add claudeCommand setting for custom Claude CLI ([#38](https://github.com/covibes/zeroshot/issues/38)) ([6e1a140](https://github.com/covibes/zeroshot/commit/6e1a140e75b2c37d2a071b8afd853656ba5e12f7)), closes [#37](https://github.com/covibes/zeroshot/issues/37)

# [5.1.0](https://github.com/covibes/zeroshot/compare/v5.0.0...v5.1.0) (2026-01-07)

### Features

- add preflight check for root user ([802f0f4](https://github.com/covibes/zeroshot/commit/802f0f41e27c1aa585dec31217fa2aeb3c9ba3db))

# [5.0.0](https://github.com/covibes/zeroshot/compare/v4.2.0...v5.0.0) (2026-01-07)

- feat!: remove interactive setup wizard ([5438953](https://github.com/covibes/zeroshot/commit/54389536e478be1dce0ab707ac7ef8e4ef6ce26d))

### BREAKING CHANGES

- Interactive setup wizard removed. Configure via:
  zeroshot settings set maxModel opus
  zeroshot settings set dockerMounts '["gh","git","ssh"]'

Closes: Setup wizard blocking non-interactive usage

# [4.2.0](https://github.com/covibes/zeroshot/compare/v4.1.4...v4.2.0) (2026-01-06)

### Features

- **security:** add automated security scanning and dependency management ([7b6ae13](https://github.com/covibes/zeroshot/commit/7b6ae139e97ddcefa46ab3e264e25f6f609163dd))

## [4.1.4](https://github.com/covibes/zeroshot/compare/v4.1.3...v4.1.4) (2026-01-06)

### Bug Fixes

- **ci:** enforce CI testing for all releases ([3fad703](https://github.com/covibes/zeroshot/commit/3fad703fb6eb6b7ac8f98400466bac92329c8561))

## [4.1.3](https://github.com/covibes/zeroshot/compare/v4.1.2...v4.1.3) (2026-01-06)

### Bug Fixes

- **package:** include scripts/ in npm package files ([4bd5991](https://github.com/covibes/zeroshot/commit/4bd599163df5c7b7f9309f07c4af4b1ec5e7bf38))
- **preflight:** support macOS Keychain auth detection ([#35](https://github.com/covibes/zeroshot/issues/35)) ([a6f0880](https://github.com/covibes/zeroshot/commit/a6f08807eb2b44b241800a2240a76bf6dbedceca))

## [4.1.2](https://github.com/covibes/zeroshot/compare/v4.1.1...v4.1.2) (2026-01-05)

### Bug Fixes

- **orchestrator:** prevent subscription race condition (issue [#31](https://github.com/covibes/zeroshot/issues/31)) ([9a41bf1](https://github.com/covibes/zeroshot/commit/9a41bf1ba9ccdac0f1653eba9d208c6de4028dbe))

## [4.1.1](https://github.com/covibes/zeroshot/compare/v4.1.0...v4.1.1) (2026-01-05)

### Bug Fixes

- **docker:** change default containerHome from /root to /home/node ([7195539](https://github.com/covibes/zeroshot/commit/71955397d727126525d36f6964980abd0ac1e94c))

# [4.1.0](https://github.com/covibes/zeroshot/compare/v4.0.0...v4.1.0) (2026-01-05)

### Features

- **settings:** improve Docker config display with grouped format ([b743673](https://github.com/covibes/zeroshot/commit/b743673f32d101bb0b86c1b619d85e856a1378c4)), closes [#19](https://github.com/covibes/zeroshot/issues/19)

# [4.0.0](https://github.com/covibes/zeroshot/compare/v3.1.0...v4.0.0) (2026-01-04)

### Bug Fixes

- adversarial tester condition and README accuracy ([c12109b](https://github.com/covibes/zeroshot/commit/c12109b5ee574301e472bd09ec7495f3a578dc36))
- **ci:** use correct agent state in status-footer test ([c6f54a8](https://github.com/covibes/zeroshot/commit/c6f54a89d91a621a8d92c1a21dfa796743e38cd2))
- **cli:** ensure PROCESS_SPAWNED sets EXECUTING_TASK state ([4c3cc9c](https://github.com/covibes/zeroshot/commit/4c3cc9c82b67513cf6ab5e5eca9de1b6d259a9d1))
- **ledger:** prevent write-after-close race condition ([6b64fcf](https://github.com/covibes/zeroshot/commit/6b64fcfa37a4396591599774c788a022cdbfb1e9))
- **release:** allow semantic-release to query remote tags ([0be475b](https://github.com/covibes/zeroshot/commit/0be475b264d400c6b504306e7c535b2736dfaaa1))
- **release:** explicitly fetch tags for semantic-release ([cecf735](https://github.com/covibes/zeroshot/commit/cecf7358d9091992d4c7a1191f874588ba7a592d))
- **tests:** ensure first-run tests are isolated from module cache ([e55dbe7](https://github.com/covibes/zeroshot/commit/e55dbe7255bab7cf3ec4ddefcc897ec71296a74a))
- **tests:** move env var and module setup to before() hook ([cf787ff](https://github.com/covibes/zeroshot/commit/cf787ff7453d1a65cbaaf98655606ccb38dea967))
- **tests:** use validateConfig for modelRules catch-all validation ([4092d78](https://github.com/covibes/zeroshot/commit/4092d78be5739f6a3ca4bc80b3dc25ea7c41f74d))

### chore

- bump version to 4.0.0 ([95844e8](https://github.com/covibes/zeroshot/commit/95844e8ffeee4d24dde56b084053d0cdcd30d3e9))

### Features

- **context:** enforce maximum informativeness, minimum verbosity ([f99a7b7](https://github.com/covibes/zeroshot/commit/f99a7b738214863744119a9b96a50590034299aa))
- **prompts:** add universal language/task support with LLM antipattern detection ([906102b](https://github.com/covibes/zeroshot/commit/906102b654914ccd73ebb8abaa121304ee4f347e))

### Performance Improvements

- **ci:** reduce matrix from 6 jobs to 1 (save ~90% minutes) ([cad652d](https://github.com/covibes/zeroshot/commit/cad652d22fdc24cf10efabf04e13902529c05b98))
- **validators:** remove relevance/notes fields to save tokens ([b775e5a](https://github.com/covibes/zeroshot/commit/b775e5a028475f2f11d3b87ec0202c4398100c1d))

### BREAKING CHANGES

- CREW*\* env vars renamed to ZEROSHOT*\*

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>

- **prompts:** Validator prompts no longer include language-specific examples

# [3.1.0](https://github.com/covibes/zeroshot/compare/v3.0.0...v3.1.0) (2026-01-03)

### Bug Fixes

- **attach:** detect cluster IDs without prefix by checking clusters.json ([a3f3b3a](https://github.com/covibes/zeroshot/commit/a3f3b3a1c3de47333297b98327f36aefb36cb958))
- **cli:** use canonical AGENT_STATE constants for status footer ([ac53f83](https://github.com/covibes/zeroshot/commit/ac53f83b0af9a7f2de8264ca791457e4e0afca9a))
- **footer:** show agents during evaluating_logic, building_context, executing_task ([f3c3484](https://github.com/covibes/zeroshot/commit/f3c348400d4b2e960410121cef0614dc583e7528))
- handle Claude CLI lock contention in parallel validators ([b88d502](https://github.com/covibes/zeroshot/commit/b88d502699c8c0e628310a9b998c4a1f4cb26d1a))
- **orchestrator:** add missing close() method for test cleanup ([a642886](https://github.com/covibes/zeroshot/commit/a6428867647de4d5b28c61163be87d711e001c7c))
- **output:** broadcast text output, not just JSON ([adc8556](https://github.com/covibes/zeroshot/commit/adc8556a47e3d02ed7189d8290e9cf81a07c909c))
- **output:** change from MINIMAL to INFORMATIVE output style ([3b87466](https://github.com/covibes/zeroshot/commit/3b87466eb0012f089edac2fb66a4d118a39e92e0))
- **planner:** explicitly forbid Deferred and Why defer patterns ([0504b0a](https://github.com/covibes/zeroshot/commit/0504b0a5e4e4cd0c902989e29a3759fbc46aa534))
- **planner:** forbid scope reduction in planner prompt ([a9dbfb2](https://github.com/covibes/zeroshot/commit/a9dbfb2bef67a14289af91b0cea77880fe3eff3f))
- **planner:** prevent silent phase omission in scope reduction checks ([7e99787](https://github.com/covibes/zeroshot/commit/7e99787593cd970b45901f7cf1bf641bf4e5f772))
- **status-footer:** cleanup footer on stop regardless of hidden state ([52fe9e9](https://github.com/covibes/zeroshot/commit/52fe9e9efeae5c768291a9a0810399bfdae03934))
- **templates:** hardcode completion-detector model to haiku ([78b917e](https://github.com/covibes/zeroshot/commit/78b917e1c97697bf64d7a0897c2b68d8bb0bbaa3))
- **tests:** set ZEROSHOT_WORKTREE env in git-safety-hook tests ([7399cfc](https://github.com/covibes/zeroshot/commit/7399cfca1d42f748314db355eb247e426fad97a2))
- **tests:** skip isolation tests when Docker image unavailable ([142f43c](https://github.com/covibes/zeroshot/commit/142f43c6af6e209a95b286556d13bb594985e850))
- **tests:** update settings test for maxModel rename and fix git hook case sensitivity ([6cbb654](https://github.com/covibes/zeroshot/commit/6cbb654fd2ef15fde9f1454d63cd6aae6807404b))
- **tests:** update tests for maxModel cost ceiling rename ([45b4ac8](https://github.com/covibes/zeroshot/commit/45b4ac809c480205345be96249608ea2b284f50e))
- **update-checker:** check npm write permissions before auto-update ([dd9efa8](https://github.com/covibes/zeroshot/commit/dd9efa83edeef812f6d0ad6142a8e8c7ec4006e6))
- **watcher:** add global error handlers to prevent silent crashes ([cea4b57](https://github.com/covibes/zeroshot/commit/cea4b57fe7cfea899bf8981c2b0d200d1c0a9050))
- **worker:** forbid scope reduction excuses in worker prompt ([c666847](https://github.com/covibes/zeroshot/commit/c6668473c7f2882482b0593950db780088721925))
- **worktree:** inject cwd into dynamically spawned template agents ([4c3b916](https://github.com/covibes/zeroshot/commit/4c3b9162e5656133b01ccbf58c91782855669e33))

### Features

- **agents:** conditional git restriction based on isolation mode ([70eb368](https://github.com/covibes/zeroshot/commit/70eb3681c3d55747d72b491a4e85279b0e215ab5))
- **orchestrator:** persist agent runtime states for accurate status display ([4205c7d](https://github.com/covibes/zeroshot/commit/4205c7d0234d3e34e0000ed15ac218c9edb7d048))
- **validation:** enforce E2E verification with technical constraints ([f2a680a](https://github.com/covibes/zeroshot/commit/f2a680ada66e1485d174084d346c0ae9932ce2c9))
- **worker:** add aggressive COMPLETION MINDSET to worker prompts ([0c6e37b](https://github.com/covibes/zeroshot/commit/0c6e37b4c0c58cab8b77b7ed1ba23ebb73f55d29))

# [3.0.0](https://github.com/covibes/zeroshot/compare/v2.1.0...v3.0.0) (2025-12-29)

### Bug Fixes

- **isolation:** replace busy-wait with async/await for parallel copy ([c8afbf0](https://github.com/covibes/zeroshot/commit/c8afbf00927ce939af633406c47a928507c339c4)), closes [#21](https://github.com/covibes/zeroshot/issues/21)
- **security:** escape shell arguments in Docker commands ([43476ad](https://github.com/covibes/zeroshot/commit/43476adfb3c67634d478b4dd53d52a6afb42b297))
- shell injection prevention and test reliability improvements ([45254f7](https://github.com/covibes/zeroshot/commit/45254f7f75b027ba43f6e16fa3668960d4b77f97))
- **status-footer:** use decimal display for interpolated metrics ([#26](https://github.com/covibes/zeroshot/issues/26)) ([73ce673](https://github.com/covibes/zeroshot/commit/73ce67376078f97faefe6724e32ff34619f33374))

### Features

- **cli:** change default model ceiling to opus ([#28](https://github.com/covibes/zeroshot/issues/28)) ([1810be3](https://github.com/covibes/zeroshot/commit/1810be3a6a2cbfbb4d3aefa711c32f9ff9718f5a))
- **cli:** change default model ceiling to opus + fix worktree flag cascade ([#29](https://github.com/covibes/zeroshot/issues/29)) ([eaa30b0](https://github.com/covibes/zeroshot/commit/eaa30b06baf381c4fb7306d08fcd2d4e980de002))
- **cli:** consolidate StatusFooter for logs -f mode + add blinking agent indicator ([fe2722d](https://github.com/covibes/zeroshot/commit/fe2722d157e04048b56368e2c0ffcd7052604f36))
- real-time metrics via interpolation + maxModel cost ceiling ([#24](https://github.com/covibes/zeroshot/issues/24)) ([f1db466](https://github.com/covibes/zeroshot/commit/f1db46691eca592de67e399aca18f6db3e94d628)), closes [#21](https://github.com/covibes/zeroshot/issues/21)
- **settings:** replace defaultModel with maxModel cost ceiling ([#25](https://github.com/covibes/zeroshot/issues/25)) ([9877dad](https://github.com/covibes/zeroshot/commit/9877dadad890f78b3af1404b0341da392f6f4bb7)), closes [#23](https://github.com/covibes/zeroshot/issues/23)
- **validation:** add Phase 5 template variable validation ([#27](https://github.com/covibes/zeroshot/issues/27)) ([5e5e7c6](https://github.com/covibes/zeroshot/commit/5e5e7c6ab2a11ba23a3600d101a9c9c7de02569e))

### Performance Improvements

- **isolation:** optimize startup with 4 key improvements ([f28f89c](https://github.com/covibes/zeroshot/commit/f28f89c36ac98c341484124bbaffee745818dffa)), closes [#20](https://github.com/covibes/zeroshot/issues/20) [#21](https://github.com/covibes/zeroshot/issues/21) [#22](https://github.com/covibes/zeroshot/issues/22) [#23](https://github.com/covibes/zeroshot/issues/23) [#20](https://github.com/covibes/zeroshot/issues/20) [#21](https://github.com/covibes/zeroshot/issues/21) [#22](https://github.com/covibes/zeroshot/issues/22) [#23](https://github.com/covibes/zeroshot/issues/23)

### BREAKING CHANGES

- None
- **settings:** defaultModel setting renamed to maxModel
- defaultModel setting renamed to maxModel

- feat(status-footer): implement real-time metrics via interpolation

Replace blocking 1s metrics polling with background sampling + interpolation:

- Sample actual metrics every 500ms (non-blocking background)
- Display updates every 100ms (10 fps - appears continuous)
- Values smoothly drift toward targets via lerp (15% per tick)
- CPU and RAM interpolate; Network is cumulative (no interpolation)

Result: Real-time seeming monitoring while reducing actual polling.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>

- feat(debug-workflow): harden investigator/fixer/tester for senior-dev quality

Implements 7 hardening changes to ensure debug-workflow produces
trustworthy output without manual code review:

**Investigator:**

- Structured rootCauses schema requiring proof each is fundamental
- Mandatory similarPatternLocations field from codebase-wide scan
- Prompt requires documenting WHY each cause is root (not symptom)

**Fixer:**

- Mandatory root cause mapping (each cause → specific fix)
- Mandatory test addition with escape hatch for valid justifications
- Must fix ALL similar pattern locations, not just original failure

**Tester:**

- Structured verification schema with commandResult, rootCauseVerification,
  similarLocationVerification, testVerification, regressionCheck
- Comprehensive checklist: A (command), B (root causes), C (similar locs),
  D (test quality), E (regression via smart tiering)
- Explicit forbidden rationalizations and approval criteria

Result: Workflow now blocks incomplete work, band-aid fixes, missing tests,
and ignored similar bugs. Output can be trusted.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>

# [2.1.0](https://github.com/covibes/zeroshot/compare/v2.0.0...v2.1.0) (2025-12-29)

### Features

- add first-run wizard and update checker ([c93cdfe](https://github.com/covibes/zeroshot/commit/c93cdfec65f05ce5b1ed4583b5ec0a23fcf56f31)), closes [#17](https://github.com/covibes/zeroshot/issues/17)

# [2.0.0](https://github.com/covibes/zeroshot/compare/v1.5.0...v2.0.0) (2025-12-29)

### Code Refactoring

- **cli:** simplify flag hierarchy with cascading --ship → --pr → --isolation ([#18](https://github.com/covibes/zeroshot/issues/18)) ([5718ead](https://github.com/covibes/zeroshot/commit/5718ead37f1771a5dfa68dd9b4f55f73e1f6b9d7)), closes [#17](https://github.com/covibes/zeroshot/issues/17)

### BREAKING CHANGES

- **cli:** `auto` command removed, use `run --ship` instead

* Remove `auto` command (use `run --ship` for full automation)
* Add `--ship` flag: isolation + PR + auto-merge
* `--pr` now auto-enables `--isolation`
* Rename `clear` → `purge` for clarity
* Update help text with cascading flag examples
* Add `agents` command stubs
* Add `--json` output support to list/status

# [1.5.0](https://github.com/covibes/zeroshot/compare/v1.4.0...v1.5.0) (2025-12-28)

### Bug Fixes

- **agent:** stop polling after max failures and fix status matching ([7a0fbfe](https://github.com/covibes/zeroshot/commit/7a0fbfe5439f428bdf8e0bcadbd308542221b6f1))
- **ci:** skip pre-push hook in CI environment ([352b013](https://github.com/covibes/zeroshot/commit/352b013b71fcea7c2d484c8274fe7c42139c65ea))
- **cli:** prevent terminal garbling with status footer coordination ([2716ce5](https://github.com/covibes/zeroshot/commit/2716ce55eae9a08107788200ab798c3f76815820))
- **config:** add timeout: 0 default to agent configuration ([6ff66c0](https://github.com/covibes/zeroshot/commit/6ff66c093bf8dfd5048b468fbd250cbfc0d9dbc1))
- **deps:** regenerate package-lock.json for jscpd dependencies ([c46d84c](https://github.com/covibes/zeroshot/commit/c46d84c3fc1fbb3d00585922613ff36d829d917a))
- **infra:** improve container cleanup and npm install robustness ([6c04b46](https://github.com/covibes/zeroshot/commit/6c04b46374bd3041a8b5c185ca163009f2fb6635))
- **orchestrator:** prevent 0-message clusters on SIGINT during init ([33ed8f9](https://github.com/covibes/zeroshot/commit/33ed8f9b90d92da6bf9caf2a7b5e52eadbcecc9f))
- **template-resolver:** apply param defaults before resolving placeholders ([eafdd62](https://github.com/covibes/zeroshot/commit/eafdd62fce381a7b9a7cb9787cd06e13f421171b))
- **templates:** add timeout parameter to all base templates ([f853ed3](https://github.com/covibes/zeroshot/commit/f853ed39e0e566afaf31040ce94923a2dcc7bfb9))

### Features

- **agents:** add git prohibition + minimal output instructions ([6f6496c](https://github.com/covibes/zeroshot/commit/6f6496c5db29073ebbeb6229ac128a5f62d7591f))
- mechanical enforcement of 7 antipatterns ([4286091](https://github.com/covibes/zeroshot/commit/428609163f9405a8d4b9e84adaee0edbc6bbb7d1)), closes [#1](https://github.com/covibes/zeroshot/issues/1) [#5](https://github.com/covibes/zeroshot/issues/5) [#2](https://github.com/covibes/zeroshot/issues/2) [#4](https://github.com/covibes/zeroshot/issues/4) [#3](https://github.com/covibes/zeroshot/issues/3) [#7](https://github.com/covibes/zeroshot/issues/7) [covibes/covibes#635](https://github.com/covibes/covibes/issues/635)
- **templates:** add timeout parameter to worker-validator agents ([ee8b17b](https://github.com/covibes/zeroshot/commit/ee8b17bc76aa29bb692965fddbc5a993749f11f9))

# [1.5.0](https://github.com/covibes/zeroshot/compare/v1.4.0...v1.5.0) (2025-12-28)

### Bug Fixes

- **agent:** stop polling after max failures and fix status matching ([7a0fbfe](https://github.com/covibes/zeroshot/commit/7a0fbfe5439f428bdf8e0bcadbd308542221b6f1))
- **cli:** prevent terminal garbling with status footer coordination ([2716ce5](https://github.com/covibes/zeroshot/commit/2716ce55eae9a08107788200ab798c3f76815820))
- **config:** add timeout: 0 default to agent configuration ([6ff66c0](https://github.com/covibes/zeroshot/commit/6ff66c093bf8dfd5048b468fbd250cbfc0d9dbc1))
- **deps:** regenerate package-lock.json for jscpd dependencies ([c46d84c](https://github.com/covibes/zeroshot/commit/c46d84c3fc1fbb3d00585922613ff36d829d917a))
- **infra:** improve container cleanup and npm install robustness ([6c04b46](https://github.com/covibes/zeroshot/commit/6c04b46374bd3041a8b5c185ca163009f2fb6635))
- **orchestrator:** prevent 0-message clusters on SIGINT during init ([33ed8f9](https://github.com/covibes/zeroshot/commit/33ed8f9b90d92da6bf9caf2a7b5e52eadbcecc9f))
- **template-resolver:** apply param defaults before resolving placeholders ([eafdd62](https://github.com/covibes/zeroshot/commit/eafdd62fce381a7b9a7cb9787cd06e13f421171b))
- **templates:** add timeout parameter to all base templates ([f853ed3](https://github.com/covibes/zeroshot/commit/f853ed39e0e566afaf31040ce94923a2dcc7bfb9))

### Features

- **agents:** add git prohibition + minimal output instructions ([6f6496c](https://github.com/covibes/zeroshot/commit/6f6496c5db29073ebbeb6229ac128a5f62d7591f))
- mechanical enforcement of 7 antipatterns ([4286091](https://github.com/covibes/zeroshot/commit/428609163f9405a8d4b9e84adaee0edbc6bbb7d1)), closes [#1](https://github.com/covibes/zeroshot/issues/1) [#5](https://github.com/covibes/zeroshot/issues/5) [#2](https://github.com/covibes/zeroshot/issues/2) [#4](https://github.com/covibes/zeroshot/issues/4) [#3](https://github.com/covibes/zeroshot/issues/3) [#7](https://github.com/covibes/zeroshot/issues/7) [covibes/covibes#635](https://github.com/covibes/covibes/issues/635)
- **templates:** add timeout parameter to worker-validator agents ([ee8b17b](https://github.com/covibes/zeroshot/commit/ee8b17bc76aa29bb692965fddbc5a993749f11f9))

# [1.4.0](https://github.com/covibes/zeroshot/compare/v1.3.0...v1.4.0) (2025-12-28)

### Features

- **status-footer:** atomic writes + token cost display ([7baf0c2](https://github.com/covibes/zeroshot/commit/7baf0c228dd5f3489013f75a1782abe6cbe39661))

# [1.3.0](https://github.com/covibes/zeroshot/compare/v1.2.0...v1.3.0) (2025-12-28)

### Features

- **planner:** enforce explicit acceptance criteria via JSON schema ([73009d9](https://github.com/covibes/zeroshot/commit/73009d9ad33e46e546721680be6d2cab9c9e46f0)), closes [#16](https://github.com/covibes/zeroshot/issues/16)

# [1.2.0](https://github.com/covibes/zeroshot/compare/v1.1.4...v1.2.0) (2025-12-28)

### Bug Fixes

- **status-footer:** robust terminal resize handling ([767a610](https://github.com/covibes/zeroshot/commit/767a610027b3e2bb238b54c31a3a7e93db635319))

### Features

- **agent:** publish TOKEN_USAGE events with task completion ([c79482c](https://github.com/covibes/zeroshot/commit/c79482c82582b75a692ba71005c821decdc1d769))
- **stream-parser:** add token usage tracking to result events ([91ad850](https://github.com/covibes/zeroshot/commit/91ad8507f42fd1a398bdc06f3b91b0a13eec8941))

## [1.1.4](https://github.com/covibes/zeroshot/compare/v1.1.3...v1.1.4) (2025-12-28)

### Bug Fixes

- **cli:** read version from package.json instead of hardcoded value ([a6e0e57](https://github.com/covibes/zeroshot/commit/a6e0e570feeaffa64dbc46d494eeef000f32b708))
- **cli:** resolve streaming mode crash and refactor message formatters ([efb9264](https://github.com/covibes/zeroshot/commit/efb9264ce0d3ede0eb7d502d4625694c2c525230))

## [1.1.3](https://github.com/covibes/zeroshot/compare/v1.1.2...v1.1.3) (2025-12-28)

### Bug Fixes

- **publish:** remove tests from prepublishOnly to prevent double execution ([3e11e71](https://github.com/covibes/zeroshot/commit/3e11e71cb722f835634d21f80fee79ea3c29b031))

## [1.1.2](https://github.com/covibes/zeroshot/compare/v1.1.1...v1.1.2) (2025-12-28)

### Bug Fixes

- **ci:** resolve ESLint violations and status-footer test failures ([0d794f9](https://github.com/covibes/zeroshot/commit/0d794f98aa10d2492d8ab0af516bb1e5abee0566))
- **isolation:** handle missing/directory .gitconfig in CI environments ([3d754e4](https://github.com/covibes/zeroshot/commit/3d754e4a02d40e2fd902d97d17a6532ba247f780))
- **workflow:** extract tarball filename correctly from npm pack output ([3cf48a3](https://github.com/covibes/zeroshot/commit/3cf48a3ddf4f1938916c7ed5a2be1796003a988f))

## [1.1.1](https://github.com/covibes/zeroshot/compare/v1.1.0...v1.1.1) (2025-12-28)

### Bug Fixes

- **lint:** resolve require-await and unused-imports errors ([852c8a0](https://github.com/covibes/zeroshot/commit/852c8a0e9076eb5403105c6f319e66e53c27fd6d))

# [1.1.0](https://github.com/covibes/zeroshot/compare/v1.0.2...v1.1.0) (2025-12-28)

### Bug Fixes

- **docker:** use repo root as build context for Dockerfile ([c1d6719](https://github.com/covibes/zeroshot/commit/c1d6719eb43787ba62e5f69663eb4e5bd1aeb492))
- **lint:** remove unused import and fix undefined variable in test ([41c9965](https://github.com/covibes/zeroshot/commit/41c9965eb84d2b8c22eaaf8e1d65a5f41c7b1e44))

### Features

- **isolation:** use zeroshot task infrastructure inside containers ([922f30d](https://github.com/covibes/zeroshot/commit/922f30d5ddd8c4d87cac375fd97025f402e7c43e))
- **monitoring:** add live status footer with CPU/memory metrics ([2df3de0](https://github.com/covibes/zeroshot/commit/2df3de0a1fe9573961b596da9e78a159f3c33086))
- **validators:** add zero-tolerance rejection rules for incomplete code ([308aef8](https://github.com/covibes/zeroshot/commit/308aef8b5ee2e3ff05e336ee810b842492183b2e))
- **validators:** strengthen with senior engineering principles ([d83f666](https://github.com/covibes/zeroshot/commit/d83f6668a145e36bd7d807d9821e8631a3a1cc18))

## [1.0.2](https://github.com/covibes/zeroshot/compare/v1.0.1...v1.0.2) (2025-12-27)

### Bug Fixes

- include task-lib in npm package ([37602fb](https://github.com/covibes/zeroshot/commit/37602fb3f1f6cd735d8db232be5829dc342b815d))

## [1.0.1](https://github.com/covibes/zeroshot/compare/v1.0.0...v1.0.1) (2025-12-27)

### Bug Fixes

- **ci:** checkout latest main to prevent stale SHA race condition ([dd302ba](https://github.com/covibes/zeroshot/commit/dd302ba8e0755cea6835cfae3286b3aa51e2f92a))
- trigger npm publish ([6aa6708](https://github.com/covibes/zeroshot/commit/6aa6708dca0e55299ba5d1be9eb54410731a7da0))

# 1.0.0 (2025-12-27)

### Bug Fixes

- **ci:** update codecov to v5 and add continue-on-error ([53de603](https://github.com/covibes/zeroshot/commit/53de603d008764c31dc158a3f2702128d6cf8bc4))
- **ci:** use Node.js 22 for semantic-release compatibility ([#9](https://github.com/covibes/zeroshot/issues/9)) ([0387c7d](https://github.com/covibes/zeroshot/commit/0387c7dcf5211b8632cf5c19a5516ad119c69a59))
- disable checkJs to fix CI typecheck failures ([cabe14c](https://github.com/covibes/zeroshot/commit/cabe14c21e8827b26423aa1b5339cb4056f0f8a5))
- **lint:** add missing eslint-config-prettier + fix no-control-regex ([d26e1ba](https://github.com/covibes/zeroshot/commit/d26e1ba404a85c96519d2945501dfa4b09505190))
- mark task-lib as ES module for Node 18 compatibility ([44fea80](https://github.com/covibes/zeroshot/commit/44fea80bd4d28877786eb140d9a9d63ac9f609ee))
- prevent agents from asking questions in non-interactive mode ([#8](https://github.com/covibes/zeroshot/issues/8)) ([458ed29](https://github.com/covibes/zeroshot/commit/458ed299aefa2790fcc951dd0efcd9d347c485ce))
- **resume:** find last workflow trigger instead of arbitrary last 5 messages ([497c24f](https://github.com/covibes/zeroshot/commit/497c24f4bd0b8c0be168167965520600b82a3f2a))
- **test:** correct npm install retry timing assertion ([36222d6](https://github.com/covibes/zeroshot/commit/36222d69920fc1aed012002c3846cf9f7d9e6392))

### Features

- **validator:** make validator-tester repo-calibrated and intelligent ([#5](https://github.com/covibes/zeroshot/issues/5)) ([3bccad2](https://github.com/covibes/zeroshot/commit/3bccad2ab32130efb897864de2a31d10c1f1842c))
- **validators:** enforce test quality with antipattern detection ([#2](https://github.com/covibes/zeroshot/issues/2)) ([9b4f912](https://github.com/covibes/zeroshot/commit/9b4f91200f4429acbce300f2c049d1d23191e768))

# 1.0.0 (2025-12-27)

### Bug Fixes

- **ci:** update codecov to v5 and add continue-on-error ([53de603](https://github.com/covibes/zeroshot/commit/53de603d008764c31dc158a3f2702128d6cf8bc4))
- **ci:** use Node.js 22 for semantic-release compatibility ([#9](https://github.com/covibes/zeroshot/issues/9)) ([0387c7d](https://github.com/covibes/zeroshot/commit/0387c7dcf5211b8632cf5c19a5516ad119c69a59))
- disable checkJs to fix CI typecheck failures ([cabe14c](https://github.com/covibes/zeroshot/commit/cabe14c21e8827b26423aa1b5339cb4056f0f8a5))
- **lint:** add missing eslint-config-prettier + fix no-control-regex ([d26e1ba](https://github.com/covibes/zeroshot/commit/d26e1ba404a85c96519d2945501dfa4b09505190))
- mark task-lib as ES module for Node 18 compatibility ([44fea80](https://github.com/covibes/zeroshot/commit/44fea80bd4d28877786eb140d9a9d63ac9f609ee))
- prevent agents from asking questions in non-interactive mode ([#8](https://github.com/covibes/zeroshot/issues/8)) ([458ed29](https://github.com/covibes/zeroshot/commit/458ed299aefa2790fcc951dd0efcd9d347c485ce))
- **resume:** find last workflow trigger instead of arbitrary last 5 messages ([497c24f](https://github.com/covibes/zeroshot/commit/497c24f4bd0b8c0be168167965520600b82a3f2a))
- **test:** correct npm install retry timing assertion ([36222d6](https://github.com/covibes/zeroshot/commit/36222d69920fc1aed012002c3846cf9f7d9e6392))

### Features

- **validator:** make validator-tester repo-calibrated and intelligent ([#5](https://github.com/covibes/zeroshot/issues/5)) ([3bccad2](https://github.com/covibes/zeroshot/commit/3bccad2ab32130efb897864de2a31d10c1f1842c))
- **validators:** enforce test quality with antipattern detection ([#2](https://github.com/covibes/zeroshot/issues/2)) ([9b4f912](https://github.com/covibes/zeroshot/commit/9b4f91200f4429acbce300f2c049d1d23191e768))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2025-12-25

### Added

#### Core Architecture

- Multi-agent coordination engine with message-passing primitives
- SQLite-backed immutable ledger for crash recovery and state persistence
- Pub/sub message bus with topic-based routing and WebSocket support
- JavaScript-based logic engine for trigger evaluation with sandboxed execution
- Agent lifecycle management with state machine (idle → evaluating → executing)
- Dynamic agent spawning via CLUSTER_OPERATIONS messages

#### Agent System

- AgentWrapper for managing Claude CLI process lifecycle
- Context building from ledger with configurable strategies
- Hook system for onComplete, onError, and onStart actions
- Output streaming via message bus with real-time updates
- Liveness detection to identify stuck agents
- Resume capability for failed tasks with error context
- Dynamic model selection based on iteration count and complexity
- Support for both static and parameterized model configurations

#### CLI Commands

- `zeroshot run` - Start multi-agent cluster from GitHub issue or text
- `zeroshot auto` - Full automation with Docker isolation and auto-merge PR
- `zeroshot list` - View all running clusters and tasks
- `zeroshot status` - Get detailed cluster status with zombie detection
- `zeroshot logs` - Follow cluster output in real-time
- `zeroshot resume` - Continue from crashed or stopped clusters
- `zeroshot stop` - Graceful cluster shutdown
- `zeroshot kill` - Force stop running cluster
- `zeroshot clear` - Remove all stopped clusters
- `zeroshot export` - Export conversation as JSON or Markdown
- `zeroshot` - Interactive Ink TUI (TTY only)
- `zeroshot tui` - Open Ink TUI explicitly
- `zeroshot watch` - Open Ink TUI Monitor view (htop-style)
- `zeroshot agents` - View available agent definitions
- `zeroshot settings` - Manage global settings
- Shell completion support via omelette

#### Docker Isolation

- IsolationManager for container lifecycle management
- Fresh git repository initialization in isolated containers
- Credential mounting for Claude CLI, AWS, GitHub, Kubernetes
- Docker-in-Docker support for e2e tests
- Automatic npm dependency installation in containers
- Terraform state preservation across container cleanup
- Git worktree support (alternative to full copy)

#### Workflow Templates

- Conductor system with 2D classification (Complexity × TaskType)
- Four base templates: single-worker, worker-validator, debug-workflow, full-workflow
- Parameterized template resolution with TemplateResolver
- Dynamic agent spawning based on task analysis
- Model tier selection: Haiku (TRIVIAL), Sonnet (SIMPLE/STANDARD), Opus (CRITICAL)
- Validator scaling: 0-5 validators based on complexity
- Adversarial tester for STANDARD/CRITICAL tasks

#### GitHub Integration

- Issue fetching with automatic URL parsing
- GitHub CLI (gh) integration for PR creation
- Auto-merge support via git-pusher agent
- Token authentication with hosts.yml fallback

#### Ink TUI

- Real-time cluster monitoring in Ink TUI
- Cluster list with state, agent count, and message count
- Message viewer with topic filtering
- Agent status display with iteration tracking
- Log viewer with search and navigation
- System resource monitoring (CPU, memory)
- Responsive layout with keyboard navigation

#### Developer Tools

- Config validator with strict mode and warning detection
- ESLint configuration with unused imports detection
- TypeScript type checking with JSDoc annotations
- Mocha test framework with comprehensive test coverage
- Dead code detection with ts-prune, unimported, depcheck
- Proper lockfile support for concurrent file access

#### Safety Features

- PreToolUse hook to block AskUserQuestion in non-interactive mode
- Explicit prompts for autonomous decision-making
- Git safety enforcement (no destructive operations)
- Zombie cluster detection for orphaned processes
- Retry logic with exponential backoff for network operations
- File locking for concurrent orchestrator instances

### Security

- Sandboxed JavaScript execution for trigger logic
- Frozen prototypes in VM context to prevent pollution
- Read-only mounts for credentials in Docker containers
- Docker group GID detection for socket access control
- Timeout enforcement for logic scripts (1 second limit)

## [0.0.0] - Development

Initial development phase before first release.

[Unreleased]: https://github.com/covibes/zeroshot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/covibes/zeroshot/releases/tag/v0.1.0
