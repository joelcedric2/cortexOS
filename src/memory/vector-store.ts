import pg from "pg";

export interface MemoryRecord {
  id: string;
  agentRole: string;
  taskType: string;
  content: string;
  embedding: number[];
  outcome: "success" | "fail";
  tags: string[];
  createdAt: Date;
}

export interface MemorySearchResult extends MemoryRecord {
  similarity: number;
}

export interface MessageRecord {
  id: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  createdAt: Date;
}

/**
 * pgvector-backed CRUD for memories and inter-agent messages.
 */
export class VectorStore {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    const pgvector = await import("pgvector/pg");
    const client = await this.pool.connect();
    try {
      await pgvector.registerType(client);

      // Auto-create tables if they don't exist
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS memories (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          agent_role TEXT NOT NULL,
          task_type TEXT NOT NULL,
          content TEXT NOT NULL,
          embedding vector(384) NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('success', 'fail')),
          tags TEXT[] DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          from_agent TEXT NOT NULL,
          to_agent TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      // Create indexes (IF NOT EXISTS)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw ON memories USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_agent_role ON memories (agent_role)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_task_type ON memories (task_type)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_outcome ON memories (outcome)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages (to_agent, created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages (from_agent, created_at DESC)`);
    } finally {
      client.release();
    }
  }

  async storeMemory(
    record: Omit<MemoryRecord, "id" | "createdAt">,
  ): Promise<string> {
    const pgvector = await import("pgvector");
    const result = await this.pool.query(
      `INSERT INTO memories (agent_role, task_type, content, embedding, outcome, tags)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        record.agentRole,
        record.taskType,
        record.content,
        pgvector.toSql(record.embedding),
        record.outcome,
        record.tags,
      ],
    );
    return result.rows[0].id;
  }

  async searchMemories(
    embedding: number[],
    topK: number,
    filters?: {
      agentRole?: string;
      taskType?: string;
      outcome?: "success" | "fail";
    },
  ): Promise<MemorySearchResult[]> {
    const pgvector = await import("pgvector");
    const conditions: string[] = [];
    const params: unknown[] = [pgvector.toSql(embedding)];
    let paramIndex = 2;

    if (filters?.agentRole) {
      conditions.push(`agent_role = $${paramIndex++}`);
      params.push(filters.agentRole);
    }
    if (filters?.taskType) {
      conditions.push(`task_type = $${paramIndex++}`);
      params.push(filters.taskType);
    }
    if (filters?.outcome) {
      conditions.push(`outcome = $${paramIndex++}`);
      params.push(filters.outcome);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    params.push(topK);

    const result = await this.pool.query(
      `SELECT id, agent_role, task_type, content, embedding, outcome, tags, created_at,
              (embedding <=> $1) AS distance
       FROM memories
       ${whereClause}
       ORDER BY distance ASC
       LIMIT $${paramIndex}`,
      params,
    );

    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      agentRole: row.agent_role as string,
      taskType: row.task_type as string,
      content: row.content as string,
      embedding: row.embedding as number[],
      outcome: row.outcome as "success" | "fail",
      tags: row.tags as string[],
      createdAt: row.created_at as Date,
      similarity: 1 - (row.distance as number),
    }));
  }

  async getMemoryById(id: string): Promise<MemoryRecord | null> {
    const result = await this.pool.query(
      `SELECT id, agent_role, task_type, content, embedding, outcome, tags, created_at
       FROM memories WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      agentRole: row.agent_role,
      taskType: row.task_type,
      content: row.content,
      embedding: row.embedding,
      outcome: row.outcome,
      tags: row.tags,
      createdAt: row.created_at,
    };
  }

  async deleteMemory(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM memories WHERE id = $1`, [id]);
  }

  async storeMessage(
    fromAgent: string,
    toAgent: string,
    content: string,
  ): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO messages (from_agent, to_agent, content)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [fromAgent, toAgent, content],
    );
    return result.rows[0].id;
  }

  async getMessages(agentRole: string, limit: number): Promise<MessageRecord[]> {
    const result = await this.pool.query(
      `SELECT id, from_agent, to_agent, content, created_at
       FROM messages
       WHERE to_agent = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [agentRole, limit],
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      fromAgent: row.from_agent as string,
      toAgent: row.to_agent as string,
      content: row.content as string,
      createdAt: row.created_at as Date,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
