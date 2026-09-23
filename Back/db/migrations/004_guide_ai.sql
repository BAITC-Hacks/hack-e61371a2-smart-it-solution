CREATE TABLE guide_topics (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL,
 category text NOT NULL, sensitivity text NOT NULL DEFAULT 'normal' CHECK(sensitivity IN ('normal','sensitive')),
 priority integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
 aliases jsonb NOT NULL DEFAULT '{}', contexts text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE guide_articles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), topic_id uuid NOT NULL REFERENCES guide_topics,
 locale text NOT NULL CHECK(locale IN ('ru','kk','en')), version integer NOT NULL CHECK(version>0),
 title text NOT NULL, summary text NOT NULL, body text NOT NULL, applies_when text NOT NULL,
 steps jsonb NOT NULL DEFAULT '[]', resources jsonb NOT NULL DEFAULT '[]', tags text[] NOT NULL DEFAULT '{}',
 visibility text[] NOT NULL DEFAULT ARRAY['employee','manager','hr','admin'], departments text[] NOT NULL DEFAULT '{}',
 ai_allowed boolean NOT NULL DEFAULT false, synthetic boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
 owner_user_id uuid NOT NULL REFERENCES user_accounts, approved_by uuid REFERENCES user_accounts,
 reviewed_at timestamptz, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple',title||' '||summary||' '||body)) STORED,
 UNIQUE(topic_id,locale,version),
 CHECK(status <> 'published' OR (approved_by IS NOT NULL AND reviewed_at IS NOT NULL AND expires_at>reviewed_at)),
 CHECK(cardinality(visibility)>0 AND visibility<@ARRAY['employee','manager','hr','admin']::text[])
);
CREATE UNIQUE INDEX guide_one_published ON guide_articles(topic_id,locale) WHERE status='published';
CREATE INDEX guide_search ON guide_articles USING gin(search_vector);
CREATE INDEX guide_article_visibility ON guide_articles(status,locale,expires_at);
CREATE FUNCTION protect_guide_article_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status<>'draft' AND ((to_jsonb(NEW)-'status'-'updated_at'-'search_vector') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'updated_at'-'search_vector') OR NEW.status NOT IN ('archived',OLD.status)) THEN
  RAISE EXCEPTION 'Published and archived guide versions are immutable; create a new draft' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guide_article_immutable BEFORE UPDATE ON guide_articles FOR EACH ROW EXECUTE FUNCTION protect_guide_article_version();
CREATE TABLE contact_channels (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), label text NOT NULL, channel text NOT NULL CHECK(channel IN ('email','phone','url','demo')),
 value text NOT NULL, description text NOT NULL DEFAULT '', visibility text[] NOT NULL DEFAULT ARRAY['employee','manager','hr','admin'],
 departments text[] NOT NULL DEFAULT '{}', confidential boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
 synthetic boolean NOT NULL DEFAULT false, verified_by uuid REFERENCES user_accounts, verified_at timestamptz, expires_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(cardinality(visibility)>0 AND visibility<@ARRAY['employee','manager','hr','admin']::text[]),
 CHECK(channel<>'demo' OR synthetic)
);
CREATE TABLE guide_routing_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), topic_id uuid NOT NULL REFERENCES guide_topics,
 department text, primary_contact_id uuid REFERENCES contact_channels, fallback_contact_id uuid REFERENCES contact_channels,
 urgency text NOT NULL DEFAULT 'normal' CHECK(urgency IN ('normal','urgent')), active boolean NOT NULL DEFAULT true,
 CHECK(primary_contact_id IS NOT NULL OR fallback_contact_id IS NOT NULL)
);
CREATE INDEX guide_routing_topic ON guide_routing_rules(topic_id) WHERE active;
CREATE TABLE guide_feedback (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), article_id uuid NOT NULL REFERENCES guide_articles,
 user_id uuid NOT NULL REFERENCES user_accounts, kind text NOT NULL CHECK(kind IN ('helpful','unhelpful','outdated','wrong_contact','incorrect')),
 comment text NOT NULL DEFAULT '', resolved_at timestamptz, resolved_by uuid REFERENCES user_accounts, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_usage (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES user_accounts,
 purpose text NOT NULL, provider text NOT NULL DEFAULT 'openai', model text NOT NULL,
 status text NOT NULL CHECK(status IN ('reserved','settled')), reserved_microusd bigint NOT NULL CHECK(reserved_microusd>=0),
 cost_microusd bigint CHECK(cost_microusd>=0), input_tokens integer, output_tokens integer,
 outcome text, created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
 CHECK(status='reserved' OR cost_microusd IS NOT NULL)
);
CREATE INDEX ai_usage_user_time ON ai_usage(user_id,created_at);
CREATE TABLE assistant_threads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES user_accounts,
 access_context text NOT NULL,
 locale text NOT NULL DEFAULT 'ru' CHECK(locale IN ('ru','kk','en')), title text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, processing_until timestamptz
);
CREATE INDEX assistant_thread_owner ON assistant_threads(user_id,updated_at DESC);
CREATE TABLE assistant_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), thread_id uuid NOT NULL REFERENCES assistant_threads ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL, request_key text,
 payload_hash text, response jsonb, source text CHECK(source IN ('ai','fallback','verified_script')),
 usage_id uuid REFERENCES ai_usage, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(thread_id,request_key,role)
);
