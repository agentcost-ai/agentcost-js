/**
 * Capability fingerprint, same contract as the Python SDK's `_ac_caps`:
 * what a call needed (vision, tools, structured output), so the optimizer can
 * tell whether a cheaper model would still serve it. Booleans and counts only;
 * no text, no tool definitions, no media. Omitted when nothing notable was used.
 */
export const CAPABILITY_KEY = "_ac_caps";

const VISION_TYPES = new Set(["image_url", "input_image", "image", "file", "input_file", "document"]);
// Keys that carry binary media: Anthropic `source`, Gemini inline/file data.
const MEDIA_KEYS = ["source", "inline_data", "inlineData", "file_data", "fileData"];

function partIsMedia(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  if (typeof p.type === "string" && VISION_TYPES.has(p.type)) return true;
  // Vercel AI SDK file parts carry a mediaType.
  if (typeof p.mediaType === "string" && !p.mediaType.startsWith("text/")) return true;
  return MEDIA_KEYS.some((k) => p[k] != null);
}

function hasMedia(messages: unknown): boolean {
  const list = Array.isArray(messages) ? messages : messages && typeof messages === "object" ? [messages] : [];
  for (const m of list) {
    if (partIsMedia(m)) return true;
    if (!m || typeof m !== "object") continue;
    const content = (m as any).content ?? (m as any).parts;
    if (Array.isArray(content) && content.some(partIsMedia)) return true;
  }
  return false;
}

function structured(p: Record<string, any>): boolean {
  const rf = p.response_format ?? p.responseFormat;
  if (rf && typeof rf === "object") {
    if (["json_object", "json_schema", "json"].includes(rf.type)) return true;
  } else if (rf != null) {
    return true;
  }
  const textFormat = p.text?.format?.type; // Responses API
  if (textFormat === "json_schema" || textFormat === "json_object") return true;
  if (p.output_config?.format || p.output_format) return true; // Anthropic structured outputs
  return !!(p.responseSchema ?? p.responseJsonSchema ?? p.response_schema ?? (p.responseMimeType === "application/json" ? true : undefined));
}

/** Fingerprint one request's parameters. Never throws. */
export function fingerprint(params: unknown): Record<string, unknown> | undefined {
  try {
    if (!params || typeof params !== "object") return undefined;
    const raw = params as Record<string, any>;
    // Gemini nests tools and response schema under `config`.
    const p: Record<string, any> = raw.config && typeof raw.config === "object" ? { ...raw, ...raw.config } : raw;
    const tools = p.tools ?? p.functions;
    const toolCount = Array.isArray(tools) ? tools.length : tools && typeof tools === "object" ? Object.keys(tools).length : 0;
    const caps: Record<string, unknown> = {};
    if (hasMedia(p.messages ?? p.input ?? p.contents ?? p.prompt)) caps.vision = true;
    if (toolCount || p.tool_choice || p.toolChoice || p.function_call || p.toolConfig) {
      caps.tools = true;
      if (toolCount) caps.tool_count = toolCount;
    }
    if (structured(p)) caps.structured_output = true;
    return Object.keys(caps).length ? caps : undefined;
  } catch {
    return undefined;
  }
}
