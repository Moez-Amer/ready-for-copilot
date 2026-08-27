import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { DECOMPOSE_RUBRIC, DecompositionSchema, MAX_SUB_ISSUES, type SubIssue } from "./decompose.js";
import { deriveDelegationResult, deriveReadinessResult, type DelegationResult, type ReadinessResult } from "./derive.js";
import { DELEGATION_RUBRIC, READINESS_RUBRIC } from "./rubric.js";
import { DelegationSchema, ReadinessSchema } from "./schema.js";

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
}

function userContent(issue: IssueText): string {
  return `Title: ${issue.title}\n\nBody:\n${issue.body}`;
}

export async function scoreReadiness(issue: IssueText): Promise<ReadinessResult> {
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: READINESS_RUBRIC,
    messages: [{ role: "user", content: userContent(issue) }],
    output_config: { format: zodOutputFormat(ReadinessSchema) },
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
export async function decomposeIssue(issue: IssueText): Promise<SubIssue[]> {
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: DECOMPOSE_RUBRIC,
    messages: [{ role: "user", content: userContent(issue) }],
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
