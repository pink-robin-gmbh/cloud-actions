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

Parses an xUnit report and posts a summary to Slack. Set `SLACK_BOT_TOKEN`
(with `chat:write` access) as a secret and `SLACK_CHANNEL_ID` as a repository
variable.

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
