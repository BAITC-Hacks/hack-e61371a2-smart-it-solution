CREATE TABLE employee_preferences (
 employee_id text PRIMARY KEY REFERENCES employees,
 weekly_hours numeric NOT NULL DEFAULT 4 CHECK(weekly_hours BETWEEN 0.5 AND 40),
 formats text[] NOT NULL DEFAULT ARRAY['online','offline','self_paced']::text[] CHECK(formats <@ ARRAY['online','offline','self_paced']::text[] AND cardinality(formats)>0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE development_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id text NOT NULL REFERENCES employees,
 target_role text NOT NULL, target_grade grade_name NOT NULL, horizon_days int NOT NULL CHECK(horizon_days IN (30,90,180)),
 start_date date NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 weekly_hours numeric NOT NULL, formats text[] NOT NULL, baseline_levels jsonb NOT NULL,
 projected_levels jsonb NOT NULL, unmet_requirements jsonb NOT NULL, total_hours numeric NOT NULL,
 version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(target_role,target_grade) REFERENCES role_profiles
);
CREATE INDEX development_plans_employee ON development_plans(employee_id,created_at DESC);
CREATE TABLE development_plan_steps (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid NOT NULL REFERENCES development_plans ON DELETE CASCADE,
 position int NOT NULL CHECK(position>0), event_id text NOT NULL REFERENCES events,
 session_id uuid REFERENCES event_sessions, scheduled_date date NOT NULL, duration_hours numeric NOT NULL,
 gains jsonb NOT NULL, prerequisites jsonb NOT NULL, alternatives jsonb NOT NULL,
 UNIQUE(plan_id,position), UNIQUE(plan_id,event_id)
);
CREATE TABLE mentor_profiles (
 employee_id text PRIMARY KEY REFERENCES employees, headline text NOT NULL,
 skill_ids text[] NOT NULL, capacity int NOT NULL CHECK(capacity BETWEEN 1 AND 20),
 enabled boolean NOT NULL DEFAULT true, approved_by uuid REFERENCES user_accounts, approved_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mentorship_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mentee_id text NOT NULL REFERENCES employees, mentor_id text NOT NULL REFERENCES employees,
 message text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled','completed')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK(mentee_id<>mentor_id)
);
CREATE UNIQUE INDEX mentorship_open_pair ON mentorship_requests(mentee_id,mentor_id) WHERE status IN ('pending','accepted');
CREATE TABLE personal_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id text NOT NULL REFERENCES employees, title text NOT NULL,
 skill_id text REFERENCES skills, target_level int CHECK(target_level BETWEEN 1 AND 5), due_date date,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 CHECK((skill_id IS NULL AND target_level IS NULL) OR (skill_id IS NOT NULL AND target_level IS NOT NULL))
);
CREATE TABLE recognitions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sender_id text NOT NULL REFERENCES employees, recipient_id text NOT NULL REFERENCES employees,
 message text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','reported','hidden')),
 moderation_note text, moderated_by uuid REFERENCES user_accounts,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK(sender_id<>recipient_id)
);
CREATE INDEX recognitions_private_inbox ON recognitions(recipient_id,created_at DESC);
CREATE TABLE team_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, description text NOT NULL,
 created_by uuid NOT NULL REFERENCES user_accounts, manager_id text REFERENCES employees,
 starts_on date NOT NULL, ends_on date NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(ends_on>=starts_on)
);
CREATE TABLE team_challenge_events (challenge_id uuid REFERENCES team_challenges ON DELETE CASCADE,event_id text REFERENCES events,PRIMARY KEY(challenge_id,event_id));
CREATE TABLE team_challenge_members (challenge_id uuid REFERENCES team_challenges ON DELETE CASCADE,employee_id text REFERENCES employees,joined_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(challenge_id,employee_id));
CREATE TABLE reward_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled boolean NOT NULL DEFAULT false,
 points_per_event int NOT NULL DEFAULT 10 CHECK(points_per_event BETWEEN 1 AND 1000),
 monthly_cap int NOT NULL DEFAULT 100 CHECK(monthly_cap BETWEEN 1 AND 10000),
 effective_from timestamptz, rules_text text NOT NULL DEFAULT '', approved_by uuid REFERENCES user_accounts,
 updated_at timestamptz NOT NULL DEFAULT now(), CHECK(NOT enabled OR (effective_from IS NOT NULL AND approved_by IS NOT NULL AND length(rules_text)>0))
);
INSERT INTO reward_policy(singleton) VALUES(true);
CREATE TABLE reward_catalog (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, description text NOT NULL,
 cost int NOT NULL CHECK(cost BETWEEN 1 AND 100000), stock int CHECK(stock>=0), active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reward_redemptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id text NOT NULL REFERENCES employees, reward_id uuid NOT NULL REFERENCES reward_catalog,
 cost int NOT NULL CHECK(cost>0), status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fulfilled','cancelled')),
 fulfilled_by uuid REFERENCES user_accounts, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- Real completion time is independent of the dataset's fictional calendar and enrollment time.
ALTER TABLE participations ADD COLUMN reward_completed_at timestamptz;
CREATE FUNCTION mark_reward_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_record_id IS NULL AND NEW.status='completed' THEN
  IF TG_OP='INSERT' THEN NEW.reward_completed_at=now();
  ELSIF OLD.status IS DISTINCT FROM 'completed' THEN NEW.reward_completed_at=now();
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reward_completion_time BEFORE INSERT OR UPDATE ON participations FOR EACH ROW EXECUTE FUNCTION mark_reward_completion();
CREATE TABLE reward_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id text NOT NULL REFERENCES employees, delta int NOT NULL CHECK(delta<>0),
 kind text NOT NULL CHECK(kind IN ('earned','reversed','redeemed','refunded')),
 participation_id uuid REFERENCES participations, event_id text REFERENCES events, redemption_id uuid REFERENCES reward_redemptions,
 source_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind IN ('earned','reversed') AND participation_id IS NOT NULL AND event_id IS NOT NULL AND redemption_id IS NULL)
    OR (kind IN ('redeemed','refunded') AND redemption_id IS NOT NULL AND participation_id IS NULL AND event_id IS NULL))
);
CREATE UNIQUE INDEX reward_once_per_event ON reward_ledger(employee_id,event_id) WHERE kind='earned';
CREATE UNIQUE INDEX reward_once_per_redemption_kind ON reward_ledger(redemption_id,kind) WHERE redemption_id IS NOT NULL;
CREATE INDEX reward_ledger_employee ON reward_ledger(employee_id,created_at DESC);
