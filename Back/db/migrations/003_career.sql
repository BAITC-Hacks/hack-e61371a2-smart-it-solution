ALTER TABLE participations DROP CONSTRAINT participations_status_check;
ALTER TABLE participations ADD CONSTRAINT participations_status_check CHECK(status IN ('registered','waitlisted','completed','in_progress','dropped','no_show','declined','overdue'));
ALTER TABLE participations ADD COLUMN session_id uuid REFERENCES event_sessions;
ALTER TABLE participations ADD COLUMN effects_snapshot jsonb;
ALTER TABLE participations ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX participations_session ON participations(session_id,status);
CREATE UNIQUE INDEX participations_live_application ON participations(employee_id,event_id) WHERE source_record_id IS NULL AND status IN ('registered','waitlisted','in_progress');

-- Persist the effects at completion time: future catalog edits cannot rewrite history.
UPDATE participations p SET effects_snapshot=COALESCE((SELECT jsonb_agg(jsonb_build_object('skillId',s.skill_id,'gain',s.gain,'maxLevel',s.max_level) ORDER BY s.skill_id) FROM event_skill_effects s WHERE s.event_id=p.event_id),'[]'::jsonb) WHERE status='completed';
CREATE FUNCTION capture_completion_effects() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='completed' AND NEW.effects_snapshot IS NULL THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('skillId',s.skill_id,'gain',s.gain,'maxLevel',s.max_level) ORDER BY s.skill_id),'[]'::jsonb) INTO NEW.effects_snapshot FROM event_skill_effects s WHERE s.event_id=NEW.event_id;
 END IF;
 NEW.updated_at=now(); RETURN NEW;
END $$;
CREATE TRIGGER participation_effects BEFORE INSERT OR UPDATE ON participations FOR EACH ROW EXECUTE FUNCTION capture_completion_effects();

CREATE TABLE recommendation_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id text NOT NULL REFERENCES employees,
 input_hash text NOT NULL, algorithm_version text NOT NULL, source text NOT NULL CHECK(source IN ('ai','fallback')),
 model text, allowed_ids jsonb NOT NULL, result jsonb NOT NULL, latency_ms integer NOT NULL,
 tokens integer NOT NULL DEFAULT 0, cost_usd numeric NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recommendation_runs_employee ON recommendation_runs(employee_id,created_at DESC);
CREATE INDEX recommendation_runs_cache ON recommendation_runs(employee_id,input_hash,algorithm_version,created_at DESC);
CREATE TABLE recommendation_feedback (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES recommendation_runs,
 user_id uuid NOT NULL REFERENCES user_accounts, event_id text NOT NULL REFERENCES events,
 helpful boolean NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,user_id,event_id)
);
CREATE TABLE career_activity_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id text NOT NULL REFERENCES employees,
 event_id text NOT NULL REFERENCES events, participation_id uuid REFERENCES participations,
 run_id uuid REFERENCES recommendation_runs, stage text NOT NULL CHECK(stage IN ('offered','registered','started','completed')),
 date date NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(participation_id,stage), UNIQUE(run_id,event_id,stage)
);
CREATE INDEX career_activity_date ON career_activity_log(date,stage);
