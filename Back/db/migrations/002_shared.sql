CREATE TABLE idempotency_records (
 user_id uuid NOT NULL REFERENCES user_accounts, operation text NOT NULL, key text NOT NULL,
 payload_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,operation,key)
);
CREATE TABLE notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id text NOT NULL REFERENCES employees,
 kind text NOT NULL, title text NOT NULL, body text NOT NULL, link text, read_at timestamptz,
 dedupe_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), topic text NOT NULL, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
