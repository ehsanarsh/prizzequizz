-- Question pipeline metadata (AI review / fact-check / dedup / quality / player
-- feedback), kept separate from the core questions table.
CREATE TABLE IF NOT EXISTS question_pipeline (
  question_id UUID PRIMARY KEY,
  source VARCHAR(12) NOT NULL DEFAULT 'manual',
  stage VARCHAR(20) NOT NULL DEFAULT 'draft',
  quality_score INT NOT NULL DEFAULT 0,
  report_count INT NOT NULL DEFAULT 0,
  meta JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qpipeline_stage ON question_pipeline(stage);
