-- CortexOS Database Schema
-- Run against a PostgreSQL database with pgvector extension installed.

CREATE EXTENSION IF NOT EXISTS vector;

-- Persistent agent memories with semantic embeddings
CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_role TEXT NOT NULL,
    task_type TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding vector(384) NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'fail')),
    tags TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inter-agent message log
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HNSW index for fast approximate nearest neighbor search on embeddings
CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw
    ON memories
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

-- Supporting indexes
CREATE INDEX IF NOT EXISTS idx_memories_agent_role ON memories (agent_role);
CREATE INDEX IF NOT EXISTS idx_memories_task_type ON memories (task_type);
CREATE INDEX IF NOT EXISTS idx_memories_outcome ON memories (outcome);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages (to_agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages (from_agent, created_at DESC);
