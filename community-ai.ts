export interface KnowledgeExtraction {
  topic: string;
  problem: string;
  keyFacts: string[];
  knownCauses: string[];
  tags: string[];
  possibleSolution: string | null;
}

export interface GroundedAnswer {
  answer: string;
  confidence: "high" | "medium" | "low";
  communityFindings: string;
  aiInference: string | null;
  caveat: string | null;
}

export interface RetrievedDiscussion {
  id: number;
  title: string;
  content: string;
  author: string;
  createdAt: Date;
  tags: string[];
  score: number;
}

const queryStopWords = new Set([
  "about",
  "anyone",
  "could",
  "does",
  "from",
  "have",
  "help",
  "into",
  "issue",
  "please",
  "solve",
  "solved",
  "that",
  "this",
  "with",
  "would",
]);

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";

type GroqJsonSchema = {
  name: string;
  schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
};

const extractionSchema: GroqJsonSchema = {
  name: "community_knowledge_extraction",
  schema: {
    type: "object",
    properties: {
      topic: { type: "string" },
      problem: { type: "string" },
      keyFacts: { type: "array", items: { type: "string" } },
      knownCauses: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
      possibleSolution: { type: ["string", "null"] },
    },
    required: [
      "topic",
      "problem",
      "keyFacts",
      "knownCauses",
      "tags",
      "possibleSolution",
    ],
    additionalProperties: false,
  },
};

const querySchema: GroqJsonSchema = {
  name: "community_search_query",
  schema: {
    type: "object",
    properties: {
      searchTerms: { type: "array", items: { type: "string" } },
    },
    required: ["searchTerms"],
    additionalProperties: false,
  },
};

const answerSchema: GroqJsonSchema = {
  name: "grounded_community_answer",
  schema: {
    type: "object",
    properties: {
      answer: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      communityFindings: { type: "string" },
      aiInference: { type: ["string", "null"] },
      caveat: { type: ["string", "null"] },
    },
    required: [
      "answer",
      "confidence",
      "communityFindings",
      "aiInference",
      "caveat",
    ],
    additionalProperties: false,
  },
};

function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    console.warn("[community-ai] Groq returned content that was not a JSON object.");
    return null;
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

async function groqChat(
  system: string,
  user: string,
  maxTokens: number,
  outputSchema: GroqJsonSchema,
): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn("[community-ai] Groq is unavailable: GROQ_API_KEY is not configured.");
    return null;
  }

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: maxTokens,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: outputSchema.name,
            strict: true,
            schema: outputSchema.schema,
          },
        },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(18_000),
    });
    if (!response.ok) {
      let providerError = "";
      try {
        const errorBody: unknown = await response.json();
        if (errorBody && typeof errorBody === "object") {
          const providerDetails = (errorBody as {
            error?: { code?: unknown; type?: unknown; param?: unknown; message?: unknown };
          }).error;
          if (providerDetails && typeof providerDetails === "object") {
            providerError = [
              providerDetails.code,
              providerDetails.type,
              providerDetails.param,
              providerDetails.message,
            ]
              .filter((value): value is string => typeof value === "string")
              .join(" ")
              .replace(/gsk_[A-Za-z0-9_-]+/g, "[redacted]")
              .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
              .slice(0, 300);
          }
        }
      } catch {
        // Keep the safe status-only diagnostic if the provider error is not JSON.
      }
      console.warn(
        `[community-ai] Groq request failed with HTTP ${response.status} (model ${GROQ_MODEL})${providerError ? `: ${providerError}` : "."}`,
      );
      return null;
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") {
      console.warn("[community-ai] Groq returned an unexpected response shape.");
      return null;
    }
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) {
      console.warn("[community-ai] Groq response did not include completion choices.");
      return null;
    }
    const first = choices[0] as { message?: { content?: unknown } } | undefined;
    if (typeof first?.message?.content !== "string") {
      console.warn("[community-ai] Groq response did not include text content.");
      return null;
    }
    return first.message.content;
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.warn(`[community-ai] Groq request failed before a response (${errorName}).`);
    return null;
  }
}

export function fallbackExtraction(
  title: string,
  content: string,
  providedTags: string[],
): KnowledgeExtraction {
  const sentences = content
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const topic = providedTags[0] ?? title;

  return {
    topic,
    problem: title,
    keyFacts: sentences.slice(0, 4),
    knownCauses: [],
    tags: providedTags.length
      ? providedTags
      : topic
          .split(/[\s,/:]+/)
          .map((tag) => tag.trim())
          .filter(Boolean)
          .slice(0, 4),
    possibleSolution: null,
  };
}

export async function extractKnowledge(
  title: string,
  content: string,
  providedTags: string[],
): Promise<{ extraction: KnowledgeExtraction; aiAvailable: boolean }> {
  const raw = await groqChat(
    [
      "You extract useful, reusable knowledge from a developer community discussion.",
      "Return one JSON object with topic (short label), problem (one sentence), keyFacts (string array), knownCauses (string array), tags (string array), and possibleSolution (string or null).",
      "Only include facts explicitly stated in the discussion. Do not add outside knowledge.",
    ].join(" "),
    JSON.stringify({ title, content, providedTags }),
    1800,
    extractionSchema,
  );
  const parsed = raw ? parseJsonObject(raw) : null;
  if (!parsed) {
    return {
      extraction: fallbackExtraction(title, content, providedTags),
      aiAvailable: false,
    };
  }

  const topic =
    typeof parsed.topic === "string" && parsed.topic.trim()
      ? parsed.topic.trim().slice(0, 100)
      : providedTags[0] ?? title;
  const problem =
    typeof parsed.problem === "string" && parsed.problem.trim()
      ? parsed.problem.trim().slice(0, 500)
      : title;
  const possibleSolution =
    typeof parsed.possibleSolution === "string" &&
    parsed.possibleSolution.trim()
      ? parsed.possibleSolution.trim().slice(0, 1200)
      : null;
  const tags = [...new Set([...providedTags, ...stringList(parsed.tags)])].slice(
    0,
    8,
  );

  return {
    extraction: {
      topic,
      problem,
      keyFacts: stringList(parsed.keyFacts),
      knownCauses: stringList(parsed.knownCauses),
      tags,
      possibleSolution,
    },
    aiAvailable: true,
  };
}

export async function understandCommunityQuestion(
  question: string,
): Promise<{ terms: string[]; aiAvailable: boolean }> {
  const raw = await groqChat(
    [
      "You prepare a community-search query from a user's question.",
      "Identify concise keywords and exact technical terms that should match earlier community posts.",
      "Do not answer the question or add facts. Preserve product names, error codes, and technologies.",
      "Return a JSON object with searchTerms as an array of short strings.",
    ].join(" "),
    JSON.stringify({ question }),
    1200,
    querySchema,
  );
  const parsed = raw ? parseJsonObject(raw) : null;
  const modelTerms = stringList(parsed?.searchTerms);
  const originalTerms = question
    .toLowerCase()
    .split(/[^a-z0-9.+#_-]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2 && !queryStopWords.has(term));
  const terms = [
    ...new Set([...modelTerms, ...originalTerms].flatMap((value) =>
      value
        .toLowerCase()
        .split(/[^a-z0-9.+#_-]+/)
        .map((term) => term.trim())
        .filter((term) => term.length > 2 && !queryStopWords.has(term)),
    )),
  ].slice(0, 20);

  return { terms, aiAvailable: Boolean(parsed && modelTerms.length) };
}

export async function generateGroundedAnswer(
  question: string,
  discussions: RetrievedDiscussion[],
): Promise<{ answer: GroundedAnswer; aiAvailable: boolean }> {
  const insufficientMessage =
    "I couldn't find enough reliable information in this community's knowledge base.";

  if (!discussions.length) {
    return {
      answer: {
        answer: insufficientMessage,
        confidence: "low",
        communityFindings: insufficientMessage,
        aiInference: null,
        caveat: "No relevant discussions were found.",
      },
      aiAvailable: false,
    };
  }

  const context = discussions.map((item) => ({
    id: item.id,
    title: item.title,
    author: item.author,
    tags: item.tags,
    discussion: item.content,
  }));
  const raw = await groqChat(
    [
      "You are Community Builder's community knowledge assistant.",
      "Answer the user's question using ONLY the retrieved community context.",
      "Cite relevant discussions by their exact [id] and title.",
      "Never fabricate a solution, person, event, citation, or community fact.",
      `If the evidence is insufficient, explicitly use this sentence: "${insufficientMessage}"`,
      "Clearly separate community findings from any AI inference. Any inference must be labeled and must not add community facts.",
      "Return a JSON object with answer, confidence (high, medium, or low), communityFindings, aiInference (string or null), and caveat (string or null).",
    ].join(" "),
    JSON.stringify({ question, retrievedDiscussions: context }),
    1600,
    answerSchema,
  );
  const parsed = raw ? parseJsonObject(raw) : null;
  const confidence = parsed?.confidence;

  if (
    parsed &&
    typeof parsed.answer === "string" &&
    typeof parsed.communityFindings === "string" &&
    (confidence === "high" ||
      confidence === "medium" ||
      confidence === "low")
  ) {
    return {
      answer: {
        answer: parsed.answer,
        confidence,
        communityFindings: parsed.communityFindings,
        aiInference:
          typeof parsed.aiInference === "string" && parsed.aiInference.trim()
            ? parsed.aiInference
            : null,
        caveat:
          typeof parsed.caveat === "string" && parsed.caveat.trim()
            ? parsed.caveat
            : null,
      },
      aiAvailable: true,
    };
  }

  const excerpts = discussions
    .slice(0, 3)
    .map((item) => `[${item.id}] ${item.title}: ${item.content.slice(0, 220)}`)
    .join("\n\n");
  return {
    answer: {
      answer:
        "I found related community discussions, but AI answer generation is unavailable right now. Review the cited posts below.",
      confidence: "low",
      communityFindings: excerpts,
      aiInference: null,
      caveat:
        "This is a direct retrieval fallback, not a generated solution. Check that GROQ_API_KEY is valid and GROQ_MODEL is available for your Groq plan.",
    },
    aiAvailable: false,
  };
}
