# ⚛️ Protomodule - GitHub Actions

This library contains shared workflows for projects managed and build by Pink Robin.

 * `aws-asg-deploy.yml` (deprecated)
 * `aws-detached-deploy.yml` ... Used for µServices where every repository has it's own deployment action. (In contrast to Wastebox where deployments for multiple systems are handled in `wb-core`)
 * `aws-systems-deploy.yml` & `aws-systems-deploy-with-override.yml` ... Checks if images are available in a given Docker registry with the expected tag. If available action updates version in AWS runtime secret und triggers a restart of auto-scaling groups. On startup of an EC2 instance the current version is read from AWS runtime secret.
 * `aws-systems-restart.yml` ... Triggers a ASG update which replaces all EC2 instance. Roughly translates to a simple restart of an application.
 * `aws-systems-stop.yml` ... Modifies an ASG to desired capacity 0. Which eventually stops all EC2 instances in this auto-scaling group.
 * `docker-build.yml` ... Automatically gathers version information from git (branch/tag) and runs `docker build` before uploading the image to the given registry.
 * Wastebox Production Deployment: These actions are used in Web/UI/Auth when a core release is created
    * `github-release-create.yml` ... Creates a release branch and opens a pull request
    * `github-release-finish.yml` ... Merges release branch back into specified default branch
 * `heroku-deploy.yml` ... Used to deploy a container stack on Heroku
 * `test-xunit.yml` ... Run yarn or npm test and convert tap report to xunit for proper display in GitHub

## Slack test-run report action

Parses an xUnit report and posts a Block Kit overview with test metrics and
links to the workflow run and report artifact. Each failed or errored test is
then posted as a separate message in the channel, with its own collapsible
details box titled with the test name. Developers can reply to each test
message to discuss it in its own thread. Passing and skipped tests are counted
in the overview but do not get individual messages. A plain-text fallback is
included for notifications. Set `SLACK_BOT_TOKEN`
(with `chat:write` access) as a secret and `SLACK_CHANNEL_ID` as a repository
variable.

Each report posts its overview and individual test messages in report order.
Concurrent UI and integration runs may interleave, but every test remains a
separate channel message that can be discussed in its own thread. Slack can
rate-limit messages to a channel; each action run spaces its messages at least
one second apart and retries HTTP 429 responses up to five times using Slack's
`Retry-After` header. Concurrent runs do not share this pacing and can still
compete for the channel limit. Use a descriptive `workflow` value to
distinguish concurrent overview messages, such as `UI tests` and `Integration
tests`.

The manually triggered `Test Slack report formatting` workflow posts a trimmed
sample report with 23 test cases (14 passed, 4 failed, and 5 skipped). It keeps
the original failure details in individual channel messages.

```yaml
- name: Report test run to Slack
  if: always()
  continue-on-error: true
  uses: pink-robin-gmbh/cloud-actions/.github/actions/test-run-report@main
  with:
    report-path: results/report.xml
    test-outcome: ${{ steps.tests.outcome }}
    workflow: ${{ github.workflow }}
    branch: ${{ github.ref_name }}
    commit: ${{ github.sha }}
    event-name: ${{ github.event_name }}
    run-url: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
    channel-id: ${{ vars.SLACK_CHANNEL_ID }}
    bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
```

## Glossary

 - **Application**: Name for an application (i.e. wastebox)
 - **Environment**: Full standalone variant of an application (i.e. develop / staging / ...)
 - **System**: An application may contain any number of systems. (i.e. API / web) A system roughly maps to one Docker container.
