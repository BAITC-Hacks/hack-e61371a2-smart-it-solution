CREATE TABLE assessment_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id text NOT NULL REFERENCES employees,
 batch_id uuid NOT NULL REFERENCES dataset_batches, assessed_on date NOT NULL, captured_at timestamptz NOT NULL DEFAULT now(),
 skills jsonb NOT NULL, UNIQUE(employee_id,batch_id)
);
INSERT INTO assessment_snapshots(employee_id,batch_id,assessed_on,skills)
 SELECT e.employee_id,e.dataset_batch_id,e.last_review_date,
 COALESCE(jsonb_object_agg(b.skill_id,b.assessed_level) FILTER(WHERE b.skill_id IS NOT NULL),'{}'::jsonb)
 FROM employees e LEFT JOIN employee_skill_baselines b USING(employee_id)
 GROUP BY e.employee_id;
CREATE TABLE event_translations (
 event_id text NOT NULL REFERENCES events, locale text NOT NULL CHECK(locale IN ('ru','kk','en')),
 title text NOT NULL, description text NOT NULL, approved_by uuid REFERENCES user_accounts,
 approved_at timestamptz, PRIMARY KEY(event_id,locale)
);
CREATE TABLE program_financials (
 event_id text PRIMARY KEY REFERENCES events, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 cost numeric NOT NULL CHECK(cost>=0), measured_benefit numeric CHECK(measured_benefit>=0),
 methodology text NOT NULL, approved_by uuid NOT NULL REFERENCES user_accounts, approved_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_preferences (
 employee_id text PRIMARY KEY REFERENCES employees, in_app boolean NOT NULL DEFAULT true,
 messenger boolean NOT NULL DEFAULT false, reminders boolean NOT NULL DEFAULT true
);
CREATE TABLE webhook_subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, target_key text NOT NULL,
 topics text[] NOT NULL, active boolean NOT NULL DEFAULT true, created_by uuid NOT NULL REFERENCES user_accounts,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subscription_id uuid NOT NULL REFERENCES webhook_subscriptions,
 event_id uuid NOT NULL REFERENCES outbox_events, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','delivered','failed')),
 attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz,
 delivered_at timestamptz, last_error text, UNIQUE(subscription_id,event_id)
);
CREATE TABLE service_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES user_accounts,
 provider_key text NOT NULL, external_id text NOT NULL, title text NOT NULL,
 status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider_key,external_id)
);
CREATE TABLE integration_identities (
 provider_key text NOT NULL, entity_type text NOT NULL CHECK(entity_type IN ('employee','event')),
 external_id text NOT NULL, local_id text NOT NULL, PRIMARY KEY(provider_key,entity_type,external_id)
);
CREATE TABLE integration_receipts (
 provider_key text NOT NULL, message_id text NOT NULL, payload_hash text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider_key,message_id)
);
CREATE TABLE oidc_identities (
 issuer text NOT NULL, subject text NOT NULL, user_id uuid NOT NULL REFERENCES user_accounts,
 PRIMARY KEY(issuer,subject), UNIQUE(issuer,user_id)
);
CREATE TABLE oidc_states (
 state_hash text PRIMARY KEY, browser_hash text NOT NULL, nonce text NOT NULL, verifier text NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
