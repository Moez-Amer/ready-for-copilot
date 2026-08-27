import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
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
  const base = `Title: ${issue.title}\n\nBody:\n${issue.body}`;
  return issue.repoContext
    ? `${base}\n\n---\n# Repository context\n\n${issue.repoContext}`
    : base;
}

export async function scoreReadiness(issue: IssueText): Promise<ReadinessResult> {
  const grounded = Boolean(issue.repoContext);
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: grounded ? `${READINESS_RUBRIC}\n${GROUNDING_RUBRIC}` : READINESS_RUBRIC,
    messages: [{ role: "user", content: userContent(issue) }],
    output_config: {
      format: zodOutputFormat(grounded ? GroundedReadinessSchema : ReadinessSchema),
    },
  });
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
    system: DECOMPOSE_RUBRIC,
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
  if (!response.parsed_output) {
    throw new Error("Decomposer returned no parsed output");
  }
  return response.parsed_output.subIssues.slice(0, MAX_SUB_ISSUES);
}

export async function classifyForDelegation(subIssue: IssueText): Promise<DelegationResult> {
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: DELEGATION_RUBRIC,
    messages: [{ role: "user", content: userContent(subIssue) }],
    output_config: { format: zodOutputFormat(DelegationSchema) },
  });
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
    system: grounded ? `${DELEGATION_RUBRIC}\n${GROUNDING_RUBRIC}` : DELEGATION_RUBRIC,
    messages: [{ role: "user", content: userContent(issue) }],
    output_config: {
      format: zodOutputFormat(grounded ? GroundedDelegationSchema : DelegationSchema),
    },
  });
  if (!response.parsed_output) {
    throw new Error("Assessment returned no parsed output");
  }
  return deriveAssessment(response.parsed_output, issue.title);
}
