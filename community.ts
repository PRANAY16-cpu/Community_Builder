import { count, countDistinct, desc, eq, ilike, or, sql, sum } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  AskCommunityBody,
  AskCommunityResponse,
  CreateCommunityPostBody,
  CreateCommunityPostResponse,
  GetCommunityFeedQueryParams,
  GetCommunityFeedResponse,
  GetCommunityMemoryQueryParams,
  GetCommunityMemoryResponse,
  GetCommunityStatsResponse,
  MarkPostUsefulParams,
  MarkPostUsefulResponse,
} from "@workspace/api-zod";
import { communityMemoryTable, communityPostsTable, db } from "@workspace/db";
import {
  extractKnowledge,
  generateGroundedAnswer,
  understandCommunityQuestion,
  type RetrievedDiscussion,
} from "../lib/community-ai";

const router: IRouter = Router();

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 90) || "community-knowledge"
  );
}

function asPost(item: {
  id: number;
  title: string;
  content: string;
  author: string;
  createdAt: Date;
  tags: string[];
  usefulCount: number;
  discussionCount: number;
  topic?: string | null;
  solution?: string | null;
}) {
  return {
    id: item.id,
    title: item.title,
    content: item.content,
    author: item.author,
    createdAt: item.createdAt.toISOString(),
    tags: item.tags,
    usefulCount: item.usefulCount,
    discussionCount: item.discussionCount,
    topic: item.topic ?? null,
    solution: item.solution ?? null,
  };
}

router.get("/community/stats", async (_req, res): Promise<void> => {
  const [discussionStats] = await db
    .select({
      discussionCount: count(),
      contributorCount: countDistinct(communityPostsTable.author),
      usefulCount: sum(communityPostsTable.usefulCount),
    })
    .from(communityPostsTable);
  const [memoryStats] = await db
    .select({ memoryCount: count() })
    .from(communityMemoryTable);

  res.json(
    GetCommunityStatsResponse.parse({
      discussionCount: discussionStats?.discussionCount ?? 0,
      memoryCount: memoryStats?.memoryCount ?? 0,
      contributorCount: discussionStats?.contributorCount ?? 0,
      usefulCount: Number(discussionStats?.usefulCount ?? 0),
    }),
  );
});

router.get("/community/feed", async (req, res): Promise<void> => {
  const params = GetCommunityFeedQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const filters = [];
  if (params.data.search?.trim()) {
    const pattern = `%${params.data.search.trim()}%`;
    filters.push(
      or(
        ilike(communityPostsTable.title, pattern),
        ilike(communityPostsTable.content, pattern),
        ilike(communityPostsTable.topicSlug, pattern),
        sql`${communityPostsTable.tags}::text ILIKE ${pattern}`,
      ),
    );
  }
  if (params.data.tag?.trim()) {
    filters.push(
      sql`${params.data.tag.trim().toLowerCase()} = ANY(${communityPostsTable.tags})`,
    );
  }

  const rows = await db
    .select({
      post: communityPostsTable,
      topic: communityMemoryTable.topic,
      solution: communityMemoryTable.solution,
    })
    .from(communityPostsTable)
    .leftJoin(
      communityMemoryTable,
      eq(communityPostsTable.topicSlug, communityMemoryTable.topicSlug),
    )
    .where(filters.length ? (filters.length === 1 ? filters[0] : or(...filters)) : undefined)
    .orderBy(desc(communityPostsTable.createdAt))
    .limit(params.data.limit ?? 30);

  res.json(
    GetCommunityFeedResponse.parse(
      rows.map(({ post, topic, solution }) =>
        asPost({ ...post, topic, solution }),
      ),
    ),
  );
});

router.post("/community/posts", async (req, res): Promise<void> => {
  const parsed = CreateCommunityPostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const providedTags = (parsed.data.tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
  const [storedPost] = await db
    .insert(communityPostsTable)
    .values({
      title: parsed.data.title.trim(),
      content: parsed.data.content.trim(),
      author: "You",
      tags: providedTags,
    })
    .returning();
  if (!storedPost) {
    res.status(500).json({ error: "The discussion could not be saved." });
    return;
  }

  const { extraction, aiAvailable } = await extractKnowledge(
    parsed.data.title,
    parsed.data.content,
    providedTags,
  );
  const tags = [...new Set([...providedTags, ...extraction.tags])].slice(0, 8);
  const topicSlug = slugify(extraction.topic);
  const [post] = await db
    .update(communityPostsTable)
    .set({ tags, topicSlug })
    .where(eq(communityPostsTable.id, storedPost.id))
    .returning();

  if (!post) {
    res.status(500).json({ error: "The discussion could not be saved." });
    return;
  }

  const [previous] = await db
    .select()
    .from(communityMemoryTable)
    .where(eq(communityMemoryTable.topicSlug, topicSlug))
    .limit(1);
  const merged = {
    topicSlug,
    topic: extraction.topic,
    problem: extraction.problem,
    knownCauses: [
      ...new Set([...(previous?.knownCauses ?? []), ...extraction.knownCauses]),
    ],
    keyFacts: [
      ...new Set([...(previous?.keyFacts ?? []), ...extraction.keyFacts]),
    ].slice(0, 12),
    solution: extraction.possibleSolution ?? previous?.solution ?? null,
    tags: [...new Set([...(previous?.tags ?? []), ...tags])].slice(0, 8),
  };
  await db
    .insert(communityMemoryTable)
    .values(merged)
    .onConflictDoUpdate({
      target: communityMemoryTable.topicSlug,
      set: {
        topic: merged.topic,
        problem: merged.problem,
        knownCauses: merged.knownCauses,
        keyFacts: merged.keyFacts,
        solution: merged.solution,
        tags: merged.tags,
        lastVerifiedAt: new Date(),
      },
    });

  res.status(201).json(
    CreateCommunityPostResponse.parse({
      post: asPost({
        ...post,
        tags,
        topic: extraction.topic,
        solution: merged.solution,
      }),
      memoryUpdated: true,
      aiAvailable,
    }),
  );
});

router.post("/community/posts/:postId/useful", async (req, res): Promise<void> => {
  const params = MarkPostUsefulParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [updated] = await db
    .update(communityPostsTable)
    .set({
      usefulCount: sql`${communityPostsTable.usefulCount} + 1`,
    })
    .where(eq(communityPostsTable.id, params.data.postId))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Discussion not found." });
    return;
  }

  const [memory] = await db
    .select({
      topic: communityMemoryTable.topic,
      solution: communityMemoryTable.solution,
    })
    .from(communityMemoryTable)
    .where(eq(communityMemoryTable.topicSlug, updated.topicSlug ?? ""))
    .limit(1);

  res.json(
    MarkPostUsefulResponse.parse(
      asPost({ ...updated, topic: memory?.topic, solution: memory?.solution }),
    ),
  );
});

router.get("/community/memory", async (req, res): Promise<void> => {
  const params = GetCommunityMemoryQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const search = params.data.search?.trim();
  const pattern = search ? `%${search}%` : null;
  const entries = await db
    .select({
      memory: communityMemoryTable,
      contributors: sql<string[]>`COALESCE(
        array_agg(DISTINCT ${communityPostsTable.author})
          FILTER (WHERE ${communityPostsTable.author} IS NOT NULL),
        ARRAY[]::text[]
      )`,
      relatedDiscussionCount: sql<number>`count(${communityPostsTable.id})`.mapWith(Number),
    })
    .from(communityMemoryTable)
    .leftJoin(
      communityPostsTable,
      eq(communityMemoryTable.topicSlug, communityPostsTable.topicSlug),
    )
    .where(
      pattern
        ? or(
            ilike(communityMemoryTable.topic, pattern),
            ilike(communityMemoryTable.problem, pattern),
            ilike(communityMemoryTable.solution, pattern),
            sql`${communityMemoryTable.tags}::text ILIKE ${pattern}`,
          )
        : undefined,
    )
    .groupBy(communityMemoryTable.id)
    .orderBy(desc(communityMemoryTable.lastVerifiedAt));

  res.json(
    GetCommunityMemoryResponse.parse(
      entries.map(({ memory, contributors, relatedDiscussionCount }) => ({
        id: memory.id,
        topic: memory.topic,
        problem: memory.problem,
        knownCauses: memory.knownCauses,
        keyFacts: memory.keyFacts,
        solution: memory.solution,
        contributors,
        relatedDiscussionCount,
        lastVerifiedAt: memory.lastVerifiedAt.toISOString(),
        tags: memory.tags,
      })),
    ),
  );
});

router.post("/community/ask", async (req, res): Promise<void> => {
  const parsed = AskCommunityBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { terms } = await understandCommunityQuestion(parsed.data.question);
  const rows = await db
    .select()
    .from(communityPostsTable)
    .orderBy(desc(communityPostsTable.createdAt))
    .limit(150);
  const discussions: RetrievedDiscussion[] = rows
    .map((post) => {
      const title = post.title.toLowerCase();
      const content = post.content.toLowerCase();
      const tags = post.tags.map((tag) => tag.toLowerCase());
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 4;
        if (tags.some((tag) => tag.includes(term))) score += 3;
        if (post.topicSlug?.includes(term)) score += 2;
        if (content.includes(term)) score += 1;
      }
      return { ...post, score };
    })
    .filter((post) => post.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.createdAt.getTime() - left.createdAt.getTime(),
    )
    .slice(0, 5);

  const { answer, aiAvailable } = await generateGroundedAnswer(
    parsed.data.question,
    discussions,
  );
  res.json(
    AskCommunityResponse.parse({
      ...answer,
      aiAvailable,
      sources: discussions.map((source) => ({
        id: source.id,
        title: source.title,
        excerpt: source.content.slice(0, 280),
        author: source.author,
        createdAt: source.createdAt.toISOString(),
        tags: source.tags,
      })),
    }),
  );
});

export default router;
