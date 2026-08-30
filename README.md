# Relay

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

The report covers whichever repository it runs in, so each repository using this tool publishes its own, about its own issues. Setup is in step 3 below.

To see one without deploying anything, generate it locally:

```bash
npm run report -- owner/repo        # writes readiness-report.html
```

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
      - uses: Moez-Amer/relay/actions/readiness@main
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
      - uses: Moez-Amer/relay/actions/split@main
        with:
          aws-bearer-token-bedrock: ${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}
          aws-region: us-east-1
```

`.github/workflows/issue-report.yml` (optional — the readiness report):

```yaml
name: Issue Readiness Report

on:
  schedule:
    - cron: "0 3 * * *"    # nightly
  workflow_dispatch:        # and on demand

permissions:
  issues: read
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  report:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: Moez-Amer/relay/actions/analytics@main
        with:
          output: public/index.html
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: public
      - id: deploy
        uses: actions/deploy-pages@v4
```

Then enable **Settings → Pages → Source: GitHub Actions**.

> GitHub Pages is free on public repositories. Publishing from a private repository requires a paid plan — the report still generates without it, so you can upload it as a build artifact instead of deploying to Pages.

### 4. A personal access token, to assign Copilot

`/split` creates sub-issues and labels them fine with the default token, but the final handoff needs more: **`GITHUB_TOKEN` cannot see the Copilot coding agent as an assignable actor**, so the assignment silently degrades to leaving the issue unassigned.

Create a [fine-grained token](https://github.com/settings/personal-access-tokens) with:

| Setting | Value |
|---|---|
| Repository access | **Only select repositories** → the repository using Relay |
| Issues | Read and write |
| Contents | Read-only |

Store it as a secret named `RELAY_TOKEN`, and pass it to the split action:

```yaml
      - uses: Moez-Amer/relay/actions/split@main
        with:
          aws-bearer-token-bedrock: ${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}
          github-token: ${{ secrets.RELAY_TOKEN || github.token }}
```

The fallback means the action still works without the token — it just stops short of assigning.

> Repository access defaults to *Public repositories*, which cannot reach a private repo at all. Every call returns `Not Found` if that is left unchanged.

> A second benefit: issues created with a personal token **do** trigger workflows, so sub-issues from `/split` also get scored by the Linter. Ones created with `GITHUB_TOKEN` do not.

> **`contents: read` is not optional.** Declaring any `permissions:` block sets every unlisted scope to none, so leaving it out silently disables grounding — the actions keep working, but stop checking whether issues match your code. The only symptom is a warning in the run log: `Could not read repository context`.

## Configuration

| Input | Default | Notes |
|---|---|---|
| `aws-bearer-token-bedrock` | — | Required. |
| `aws-region` | `us-east-1` | Must be a region where your Bedrock model is available. |
| `github-token` | `${{ github.token }}` | Override only if you need a PAT (see Limitations). |

The model is set by the `BEDROCK_SCORER_MODEL` environment variable, defaulting to `us.anthropic.claude-haiku-4-5-20251001-v1:0`. Any Bedrock model id your account can invoke works.

## Cost

One model call per issue opened or meaningfully edited, and one per sub-issue during a split. On Haiku 4.5 that is a fraction of a cent per issue.

The repository listing is the bulk of each request, and it is identical across
every call in one run, so it is sent as a cached prefix. The first call in a
run writes it; the rest read it at roughly a tenth of the cost. Measured on a
1,200-file repository, an eight-way split pays one full send of ~16k tokens
instead of nine.

Caching needs at least 4,096 tokens to engage, so small repositories see no
benefit — Bedrock ignores the breakpoint and charges normally rather than
erroring.

Every run reports what it consumed, so the cost of a scoring or a split is
measured rather than guessed:

```
1 model call: 1,607 in, 267 out, 0 cached — ~$0.0029
```

Set `RELAY_VERBOSE=1` for a per-call breakdown, which is worth having when
tracking down which step of a split is expensive.

Token counts come from the API response and are exact. The money is an
estimate: Bedrock's rates vary by region and inference profile, so set
`RELAY_RATE_INPUT` and `RELAY_RATE_OUTPUT` (dollars per million tokens) to
match your own bill. Defaults are $1 and $5.

## Limitations

- **Assigning Copilot needs a personal access token.** The default `GITHUB_TOKEN` cannot see the coding agent as an assignable actor, so without one, `/split` labels mechanical sub-issues and leaves them unassigned rather than failing. See step 4 below.
- **A personal token attributes the work to you.** Sub-issues and comments from `/split` appear under your name rather than `github-actions[bot]`. Keeping the Linter on the default token leaves its comments clearly bot-authored.
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
