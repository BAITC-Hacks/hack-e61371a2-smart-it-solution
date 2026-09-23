CREATE TABLE dataset_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version text NOT NULL, as_of_date date NOT NULL,
 source_sha256 text UNIQUE NOT NULL, counts jsonb NOT NULL, imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE DOMAIN grade_name AS text CHECK (VALUE IN ('Junior','Middle','Senior','Lead'));
CREATE TABLE roles (role text PRIMARY KEY);
CREATE TABLE skills (skill_id text PRIMARY KEY, name text NOT NULL, type text NOT NULL CHECK(type IN ('hard','soft')), category text NOT NULL, description text NOT NULL);
CREATE TABLE role_profiles (role text REFERENCES roles, grade grade_name, PRIMARY KEY(role,grade));
CREATE TABLE role_requirements (
 role text, grade grade_name, skill_id text REFERENCES skills, required_level int NOT NULL CHECK(required_level BETWEEN 0 AND 5),
 is_critical boolean NOT NULL, PRIMARY KEY(role,grade,skill_id), FOREIGN KEY(role,grade) REFERENCES role_profiles
);
CREATE TABLE employees (
 employee_id text PRIMARY KEY, full_name text NOT NULL, department text NOT NULL, role text NOT NULL, grade grade_name NOT NULL,
 manager_id text REFERENCES employees DEFERRABLE INITIALLY DEFERRED, hire_date date NOT NULL,
 tenure_months int NOT NULL CHECK(tenure_months>=0), work_format text NOT NULL CHECK(work_format IN ('office','hybrid','remote')),
 preferred_language text NOT NULL CHECK(preferred_language IN ('ru','kk','en')), last_review_date date NOT NULL,
 dataset_batch_id uuid NOT NULL REFERENCES dataset_batches, FOREIGN KEY(role,grade) REFERENCES role_profiles,
 CHECK(manager_id IS DISTINCT FROM employee_id)
);
CREATE INDEX employees_scope ON employees(manager_id);
CREATE INDEX employees_filters ON employees(role,grade,department);
CREATE TABLE employee_skill_baselines (
 employee_id text REFERENCES employees, skill_id text REFERENCES skills, assessed_level int NOT NULL CHECK(assessed_level BETWEEN 0 AND 5), PRIMARY KEY(employee_id,skill_id)
);
CREATE TABLE career_goals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id text NOT NULL REFERENCES employees,
 target_role text NOT NULL, target_grade grade_name NOT NULL, status text NOT NULL CHECK(status IN ('active','archived')) DEFAULT 'active',
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(target_role,target_grade) REFERENCES role_profiles
);
CREATE UNIQUE INDEX one_active_goal ON career_goals(employee_id) WHERE status='active';
CREATE TABLE events (
 event_id text PRIMARY KEY, title text NOT NULL, description text NOT NULL,
 type text NOT NULL CHECK(type IN ('compliance','onboarding','course','workshop','mentoring','certification','meetup')),
 format text NOT NULL CHECK(format IN ('online','offline','self_paced')),
 duration_hours numeric NOT NULL CHECK(duration_hours>0), mandatory boolean NOT NULL, is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE event_target_roles (event_id text REFERENCES events, role text REFERENCES roles, PRIMARY KEY(event_id,role));
CREATE TABLE event_target_grades (event_id text REFERENCES events, grade grade_name, PRIMARY KEY(event_id,grade));
CREATE TABLE event_skill_effects (event_id text REFERENCES events, skill_id text REFERENCES skills, gain int NOT NULL CHECK(gain>0), max_level int NOT NULL CHECK(max_level BETWEEN 0 AND 5), PRIMARY KEY(event_id,skill_id));
CREATE TABLE event_prerequisites (event_id text REFERENCES events, skill_id text REFERENCES skills, min_level int NOT NULL CHECK(min_level BETWEEN 0 AND 5), PRIMARY KEY(event_id,skill_id));
CREATE TABLE event_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id text NOT NULL REFERENCES events, session_date date NOT NULL, capacity int CHECK(capacity>0), UNIQUE(event_id,session_date));
CREATE TABLE participations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_record_id text UNIQUE, employee_id text NOT NULL REFERENCES employees,
 event_id text NOT NULL REFERENCES events, date date NOT NULL, due_date date,
 status text NOT NULL CHECK(status IN ('completed','in_progress','dropped','no_show','declined','overdue')),
 completion_pct int NOT NULL CHECK(completion_pct BETWEEN 0 AND 100), score int CHECK(score BETWEEN 0 AND 100),
 feedback_rating int CHECK(feedback_rating BETWEEN 1 AND 5), assigned_by text NOT NULL CHECK(assigned_by IN ('self','manager','hr')),
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(status<>'completed' OR completion_pct=100)
);
CREATE INDEX participation_employee ON participations(employee_id,date DESC);
CREATE INDEX participation_event ON participations(event_id,status,date);
CREATE TABLE user_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id text REFERENCES employees,
 app_role text NOT NULL CHECK(app_role IN ('employee','manager','hr','admin')), login text UNIQUE NOT NULL,
 display_name text NOT NULL, password_hash text, demo_only boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
 CHECK(app_role NOT IN ('employee','manager') OR employee_id IS NOT NULL), CHECK(demo_only OR password_hash IS NOT NULL)
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES user_accounts,
 token_hash text UNIQUE NOT NULL, csrf_token text NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE audit_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor uuid REFERENCES user_accounts, action text NOT NULL,
 entity text NOT NULL, entity_id text, details jsonb NOT NULL DEFAULT '{}', request_id text, created_at timestamptz NOT NULL DEFAULT now()
);
