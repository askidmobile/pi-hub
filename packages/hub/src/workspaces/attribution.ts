/**
 * AI attribution detector. MUST stay identical to PATTERN in scripts/check-attribution.sh
 * (CI uses `grep -Ei`); a test compares the two.
 */
export const ATTRIBUTION_PATTERN =
  "(co-authored-by:.*(noreply@anthropic\\.com|openai\\.com|claude|codex|copilot|gemini|cursor|deepseek|chatgpt))|(generated (with|by) .*(claude|codex|copilot|chatgpt|gemini|cursor|ai))|🤖 generated";

const RE = new RegExp(ATTRIBUTION_PATTERN, "i");

/** Lines of `message` that credit an AI tool as author or co-author. */
export function findAttribution(message: string): string[] {
  return message.split(/\r?\n/).filter((line) => RE.test(line));
}
