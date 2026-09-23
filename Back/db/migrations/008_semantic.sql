CREATE TABLE guide_semantic_embeddings (
 article_id uuid NOT NULL REFERENCES guide_articles, model text NOT NULL, revision_hash text NOT NULL,
 vector double precision[] NOT NULL, dimensions int NOT NULL CHECK(dimensions BETWEEN 1 AND 4096), vector_hash text NOT NULL,
 input_hash text NOT NULL, input_characters int NOT NULL, truncated boolean NOT NULL, usage_id uuid REFERENCES ai_usage,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(article_id,model), CHECK(cardinality(vector)=dimensions)
);
CREATE TABLE guide_semantic_queries (
 query_hash text NOT NULL, locale text NOT NULL CHECK(locale IN ('ru','kk','en')), model text NOT NULL,
 vector double precision[] NOT NULL, dimensions int NOT NULL CHECK(dimensions BETWEEN 1 AND 4096),
 usage_id uuid REFERENCES ai_usage, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(query_hash,locale,model), CHECK(cardinality(vector)=dimensions)
);
CREATE TABLE guide_semantic_evaluations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor uuid NOT NULL REFERENCES user_accounts,
 model text NOT NULL, corpus_hash text NOT NULL, index_hash text NOT NULL, query_count int NOT NULL CHECK(query_count BETWEEN 10 AND 30),
 sql_recall numeric NOT NULL CHECK(sql_recall BETWEEN 0 AND 1), semantic_recall numeric NOT NULL CHECK(semantic_recall BETWEEN 0 AND 1),
 passed boolean NOT NULL, results jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE guide_semantic_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled boolean NOT NULL DEFAULT false,
 model text, corpus_hash text, index_hash text, evaluation_id uuid REFERENCES guide_semantic_evaluations,
 changed_by uuid REFERENCES user_accounts, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT enabled OR (model IS NOT NULL AND corpus_hash IS NOT NULL AND index_hash IS NOT NULL AND evaluation_id IS NOT NULL))
);
INSERT INTO guide_semantic_settings(singleton) VALUES(true);
CREATE TABLE guide_semantic_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES user_accounts,
 operation text NOT NULL, request_key text NOT NULL, payload_hash text NOT NULL,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','uncertain')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '2 minutes', result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,operation,request_key)
);
