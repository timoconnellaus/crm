// Where record embeddings live (ADR 0154): Vectorize in a deployment, an in-memory store in tests
// and local development (Vectorize has no local simulation). Vector ids are `<object>:<id>`, or a
// hash when that would pass Vectorize's 64-byte id limit; metadata carries the object type (a
// Vectorize metadata index, so queries can filter by object) and the record id.

export interface VectorMetadata {
  object: string;
  id: string;
}

export interface VectorMatch {
  vectorId: string;
  score: number;
  object: string;
  id: string;
}

export interface VectorStore {
  upsert(vectors: { id: string; values: number[]; metadata: VectorMetadata }[]): Promise<void>;
  deleteByIds(ids: string[]): Promise<void>;
  /** Nearest neighbours, best first. `objects` filters by object type. */
  query(vector: number[], options: { topK: number; objects?: string[] }): Promise<VectorMatch[]>;
  /** A stored vector, for "similar records" without re-embedding. */
  getVector(id: string): Promise<number[] | null>;
}

/** The Vectorize binding, as far as we use it (structural, so tests need no real binding). */
export interface VectorizeLike {
  upsert(vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  query(
    vector: number[],
    options?: { topK?: number; returnMetadata?: "none" | "indexed" | "all"; filter?: unknown },
  ): Promise<{ matches: { id: string; score: number; metadata?: Record<string, unknown> }[] }>;
  getByIds(ids: string[]): Promise<{ id: string; values: number[] | Float32Array | Float64Array }[]>;
}

const encoder = new TextEncoder();

/** The Vectorize id of a record: `<object>:<id>`, or `h:<sha-256 prefix>` past 64 bytes. */
export async function vectorId(object: string, id: string): Promise<string> {
  const plain = `${object}:${id}`;
  if (encoder.encode(plain).length <= 64) return plain;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(plain));
  return `h:${[...new Uint8Array(digest)]
    .slice(0, 24)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

const UPSERT_BATCH = 1000; // Vectorize's per-call limit from Workers
const DELETE_BATCH = 1000;

/**
 * Vectorize. Queries ask for `indexed` metadata (the object type is a metadata index) with topK
 * at most 50 (Vectorize's limit when metadata is returned).
 */
export function vectorizeStore(index: VectorizeLike): VectorStore {
  return {
    async upsert(vectors) {
      for (let i = 0; i < vectors.length; i += UPSERT_BATCH) {
        await index.upsert(
          vectors.slice(i, i + UPSERT_BATCH).map((v) => ({ ...v, metadata: { ...v.metadata } })),
        );
      }
    },
    async deleteByIds(ids) {
      for (let i = 0; i < ids.length; i += DELETE_BATCH) {
        await index.deleteByIds(ids.slice(i, i + DELETE_BATCH));
      }
    },
    async query(vector, { topK, objects }) {
      const filter =
        objects?.length === 1
          ? { object: { $eq: objects[0] } }
          : objects?.length
            ? { object: { $in: objects } }
            : undefined;
      const result = await index.query(vector, {
        topK: Math.min(topK, 50),
        returnMetadata: "all",
        ...(filter ? { filter } : {}),
      });
      return result.matches.flatMap((m) => {
        const object = m.metadata?.object;
        const id = m.metadata?.id;
        return typeof object === "string" && typeof id === "string"
          ? [{ vectorId: m.id, score: m.score, object, id }]
          : [];
      });
    },
    async getVector(id) {
      const [found] = await index.getByIds([id]);
      return found ? Array.from(found.values) : null;
    },
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface MemoryVectorStore extends VectorStore {
  readonly size: number;
  ids(): string[];
}

/** An exact, in-memory store: tests and local development only. */
export function memoryVectorStore(): MemoryVectorStore {
  const vectors = new Map<string, { values: number[]; metadata: VectorMetadata }>();
  return {
    get size() {
      return vectors.size;
    },
    ids: () => [...vectors.keys()],
    async upsert(list) {
      for (const v of list) vectors.set(v.id, { values: v.values, metadata: v.metadata });
    },
    async deleteByIds(ids) {
      for (const id of ids) vectors.delete(id);
    },
    async query(vector, { topK, objects }) {
      return [...vectors.entries()]
        .filter(([, v]) => !objects?.length || objects.includes(v.metadata.object))
        .map(([vectorId, v]) => ({
          vectorId,
          score: cosine(vector, v.values),
          object: v.metadata.object,
          id: v.metadata.id,
        }))
        .sort((a, b) => b.score - a.score || a.vectorId.localeCompare(b.vectorId))
        .slice(0, topK);
    },
    async getVector(id) {
      return vectors.get(id)?.values ?? null;
    },
  };
}
