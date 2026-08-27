# ready-for-copilot

Scores GitHub issues for agent-readiness and splits big ones into sub-issues, routing the safe parts to Copilot and the rest to humans.

Two GitHub Actions that share one rubric:

- **Readiness Linter** — scores every new issue out of 4, comments with a single suggested rewrite, and labels what the issue needs next. Never blocks anyone.
- **`/split`** — decomposes a large issue into linked sub-issues, then classifies each as safe for a coding agent or needing a human.

## Why

"Fix the login bug" was always a bad issue. It used to be survivable, because a human would wander over and ask what you meant. Hand the same issue to a coding agent and it will confidently build the wrong thing.

## What it does

### The Linter

Runs on every issue as it's opened or edited. It asks four questions:

| Signal | Question |
|---|---|
| Outcome | Would you know when this is done? |
| Scope | Is this one change, or several? |
| Context | Are the files or reproduction steps identified? |
| Ambiguity | Are undefined terms doing the heavy lifting? |

Then two more, which decide whether the work is safe to delegate at all:

| Signal | Question |
|---|---|
| Task pattern | Is this a routine kind of change, or does it need taste? |
| Blast radius | Does it touch auth, migrations, billing, public APIs, or dependencies? |

And one that checks the issue is *true*, using your repository's actual file tree and code search:

| Signal | Question |
|---|---|
| Grounding | Does the code this issue describes actually exist? |

It posts **one comment** — a score and a single suggested rewrite of the weakest part — and applies exactly one label:

| Label | Meaning |
|---|---|
| `agent-ready` | 4/4, real, and safe to delegate |
| `needs-human` | Well specified, but touches something an agent shouldn't change unreviewed |
| `needs-detail` | Scored below 4/4 — the comment says what's missing |
| `not-in-codebase` | Reads as ready, but describes code that isn't there |
| `not-a-task` | A question or discussion rather than a change request |

Editing an issue re-scores it and updates the label in place, so acting on the feedback moves the issue along. An edit that doesn't change the meaningful content costs nothing.

### `/split`

Comment `/split` on a large issue. It creates linked sub-issues, labels each `mechanical` or `judgement`, and hands the mechanical ones to the Copilot coding agent.

It declines rather than making things worse, when:

- the issue is **already one bounded change** — splitting would just restate it
- the issue **describes code that isn't there** — the sub-issues would inherit the problem
- the issue **names nothing concrete** — there are no seams to split along

It also skips any sub-issue an **open issue already covers**, and caps decomposition at 8.

> `/split` is ordinary comment text, not a registered GitHub command, so it won't appear in the comment box's autocomplete. Type it, press <kbd>Esc</kbd> to dismiss the popup, then comment.

### The report

A third action builds a static page showing where issues land, and whether the rubric predicts anything: it compares median time-to-close for `agent-ready` against `needs-detail`. If well-scored issues don't actually resolve faster, the rubric is wrong — which is a more useful finding than the tool.

Add `.github/workflows/issue-report.yml` (see the file in this repository), enable **Settings → Pages → Source: GitHub Actions**, and it publishes nightly. Run it on demand from the Actions tab.

## Setup

### 1. A Bedrock API key

The scorer runs on Claude Haiku 4.5 via Amazon Bedrock's `bedrock-runtime` endpoint. In the [Bedrock console](https://console.aws.amazon.com/bedrock/home#/api-keys/long-term/create), generate a **long-term API key**.

Your IAM identity needs Bedrock invoke permissions — the `AmazonBedrockFullAccess` managed policy is the simplest starting point.

### 2. Add it as a repository secret

**Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `AWS_BEARER_TOKEN_BEDROCK` | the key from step 1 |

### 3. Add the workflows

`.github/workflows/issue-readiness.yml`:

```yaml
name: Issue Readiness

on:
  issues:
    types: [opened, edited]

permissions:
  issues: write
  contents: read   # required -- see the note below

jobs:
  score:
    runs-on: ubuntu-latest
    steps:
      - uses: Moez-Amer/ready-for-copilot/actions/readiness@main
        with:
          aws-bearer-token-bedrock: ${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}
          aws-region: us-east-1
```

`.github/workflows/issue-split.yml`:

```yaml
name: Issue Split

on:
  issue_comment:
    types: [created]

permissions:
  issues: write
  contents: read

jobs:
  split:
    if: ${{ !github.event.issue.pull_request && contains(github.event.comment.body, '/split') }}
    runs-on: ubuntu-latest
    steps:
      - uses: Moez-Amer/ready-for-copilot/actions/split@main
        with:
          aws-bearer-token-bedrock: ${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}
          aws-region: us-east-1
```

> **`contents: read` is not optional.** Declaring any `permissions:` block sets every unlisted scope to none, so leaving it out silently disables grounding — the actions keep working, but stop checking whether issues match your code. The only symptom is a warning in the run log: `Could not read repository context`.

## Configuration

| Input | Default | Notes |
|---|---|---|
| `aws-bearer-token-bedrock` | — | Required. |
| `aws-region` | `us-east-1` | Must be a region where your Bedrock model is available. |
| `github-token` | `${{ github.token }}` | Override only if you need a PAT (see Limitations). |

The model is set by the `BEDROCK_SCORER_MODEL` environment variable, defaulting to `us.anthropic.claude-haiku-4-5-20251001-v1:0`. Any Bedrock model id your account can invoke works.

## Cost

One model call per issue opened or meaningfully edited, and one per sub-issue during a split. On Haiku 4.5 that's a fraction of a cent per issue. The heaviest call is `/split`'s decompose step, which reads your repository's file layout.

## Limitations

- **Copilot assignment is unverified.** The code uses the `replaceActorsForAssignable` mutation, but it has only ever been exercised on repositories without the coding agent enabled, where it takes the graceful-degradation path: the sub-issue is labelled `mechanical` and left unassigned.
- **Sub-issues aren't Linter-scored.** GitHub doesn't trigger workflows for actions taken with `GITHUB_TOKEN`, so issues created by `/split` don't fire the readiness workflow. They're labelled by `/split` itself instead. Supplying a PAT as `github-token` would change this.
- **Repository context is re-sent on every call.** `/split` sends the file tree once to decompose and again for each sub-issue it classifies. Prompt caching would fix this; it isn't implemented yet.
- **Code search can be unavailable** on new or unindexed repositories. Grounding degrades to file-path checking; unverified is never treated as absent.

## Development

```bash
npm install
npm run build     # type-check and bundle every action
npm test          # unit tests (no API calls)
```

The repository is an npm workspace:

- `packages/scorer` — the rubric, schemas, and model calls. Knows nothing about GitHub.
- `packages/repo-context` — reads the repository and detects duplicates. Knows nothing about the model.
- `packages/analytics` — turns issue history into the report. Pure functions and one HTML renderer.
- `actions/readiness`, `actions/split`, `actions/analytics` — thin GitHub wrappers over the packages.

`actions/*/dist/*.cjs` is committed deliberately: GitHub runs actions straight from the checked-out repository with no build step.
