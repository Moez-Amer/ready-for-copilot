import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { DECOMPOSE_RUBRIC, DecompositionSchema, MAX_SUB_ISSUES, type SubIssue } from "./decompose.js";
import {
  deriveAssessment,
  deriveDelegationResult,
  deriveReadinessResult,
  type AssessmentResult,
  type DelegationResult,
  type ReadinessResult,
} from "./derive.js";
import { DELEGATION_RUBRIC, GROUNDING_RUBRIC, READINESS_RUBRIC } from "./rubric.js";
import { estimateCost, recordUsage } from "./usage.js";
import {
  DelegationSchema,
  GroundedDelegationSchema,
  GroundedReadinessSchema,
  ReadinessSchema,
} from "./schema.js";

// Served via Amazon Bedrock's classic bedrock-runtime endpoint (not Mantle --
// Mantle turned out to have an access gap for Claude on this account that
// bedrock-runtime doesn't have), authenticated with the same
// AWS_BEARER_TOKEN_BEDROCK bearer key used throughout this project. The Geo:US
// cross-region inference ID is required here since bedrock-runtime doesn't
// support in-region inference for this model. Override via
// BEDROCK_SCORER_MODEL if a different model/region profile is needed.
const MODEL = process.env.BEDROCK_SCORER_MODEL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";

let client: AnthropicBedrock | undefined;
function getClient(): AnthropicBedrock {
  client ??= new AnthropicBedrock();
  return client;
}

export interface IssueText {
  title: string;
  body: string;
  /**
   * What this repository actually contains. When present, the scorer also
   * checks the issue's claims about existing code against it.
   */
  repoContext?: string | undefined;
}

function userContent(issue: IssueText): string {
  return `Title: ${issue.title}\n\nBody:\n${issue.body}`;
}

/**
 * Build the system prompt, caching the repository context.
 *
 * One /split sends the same repository listing once to decompose and again for
 * every sub-issue it classifies -- nine times over an eight-way split, for
 * content that never changes. Caching only applies to a stable prefix, so the
 * listing goes first, ahead of the rubric and the issue, with the breakpoint
 * after it. Bedrock then serves it from cache on every later call in the run.
 *
 * Caching needs at least 4096 tokens to engage; below that Bedrock ignores the
 * breakpoint and charges normally, so a small repository simply sees no
 * benefit rather than an error.
 */
function systemFor(rubric: string, repoContext?: string): string | Anthropic.TextBlockParam[] {
  if (!repoContext) return rubric;
  return [
    {
      type: "text",
      text: `# Repository context\n\n${repoContext}`,
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: rubric },
  ];
}

/**
 * Record what a call consumed and print it.
 *
 * Token counts come from the response, so spend is measured per call rather
 * than reconstructed from a monthly bill -- which is the only way to answer
 * "what does one split cost" before adopting this.
 */
function meter(label: string, usage: Anthropic.Usage | undefined): void {
  const call = recordUsage(label, usage);
  if (!call) return;
  const cached = call.cacheReadTokens ? `, ${call.cacheReadTokens} cached` : "";
  console.log(
    `[usage] ${label}: ${call.inputTokens} in, ${call.outputTokens} out${cached} ` +
      `≈ $${estimateCost(call).toFixed(5)}`,
  );
}

export async function scoreReadiness(issue: IssueText): Promise<ReadinessResult> {
  const grounded = Boolean(issue.repoContext);
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: systemFor(
      grounded ? `${READINESS_RUBRIC}\n${GROUNDING_RUBRIC}` : READINESS_RUBRIC,
      issue.repoContext,
    ),
    messages: [{ role: "user", content: userContent(issue) }],
    output_config: {
      format: zodOutputFormat(grounded ? GroundedReadinessSchema : ReadinessSchema),
    },
  });
  meter("readiness", response.usage);
  if (!response.parsed_output) {
    throw new Error("Readiness scorer returned no parsed output");
  }
  return deriveReadinessResult(response.parsed_output);
}

/**
 * Decompose step of /split. The MAX_SUB_ISSUES cap is enforced here in code,
 * not just requested in the prompt -- the prompt is a preference, this is the
 * guarantee.
 */
export async function decomposeIssue(
  issue: IssueText,
  openIssues?: string,
): Promise<SubIssue[]> {
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: systemFor(DECOMPOSE_RUBRIC, issue.repoContext),
    messages: [
      {
        role: "user",
        content: openIssues
          ? `${userContent(issue)}\n\n---\n# Issues already open in this repository\n\n${openIssues}`
          : userContent(issue),
      },
    ],
    output_config: { format: zodOutputFormat(DecompositionSchema) },
  });
  meter("decompose", response.usage);
  if (!response.parsed_output) {
    throw new Error("Decomposer returned no parsed output");
  }
  return response.parsed_output.subIssues.slice(0, MAX_SUB_ISSUES);
}

export async function classifyForDelegation(subIssue: IssueText): Promise<DelegationResult> {
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: systemFor(DELEGATION_RUBRIC, subIssue.repoContext),
    messages: [{ role: "user", content: userContent(subIssue) }],
    output_config: { format: zodOutputFormat(DelegationSchema) },
  });
  meter("classify", response.usage);
  if (!response.parsed_output) {
    throw new Error("Delegation classifier returned no parsed output");
  }
  return deriveDelegationResult(response.parsed_output);
}

/**
 * Score an issue on every signal at once -- readiness, grounding, and
 * delegation safety -- in a single call. Used wherever a caller has to decide
 * whether an issue may be handed to an agent, which readiness alone cannot
 * answer.
 */
export async function assessIssue(issue: IssueText): Promise<AssessmentResult> {
  const grounded = Boolean(issue.repoContext);
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: systemFor(
      grounded ? `${DELEGATION_RUBRIC}\n${GROUNDING_RUBRIC}` : DELEGATION_RUBRIC,
      issue.repoContext,
    ),
    messages: [{ role: "user", content: userContent(issue) }],
    output_config: {
      format: zodOutputFormat(grounded ? GroundedDelegationSchema : DelegationSchema),
    },
  });
  meter("assess", response.usage);
  if (!response.parsed_output) {
    throw new Error("Assessment returned no parsed output");
  }
  return deriveAssessment(response.parsed_output, issue.title);
}
