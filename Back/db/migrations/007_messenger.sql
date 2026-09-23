ALTER TABLE integration_receipts ADD COLUMN lease_token uuid;
ALTER TABLE integration_receipts ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE integration_receipts ADD COLUMN normalized_payload jsonb;

ALTER TABLE notifications ADD COLUMN messenger_enqueued_at timestamptz;
ALTER TABLE notification_preferences ADD COLUMN messenger_enabled_at timestamptz;
UPDATE notification_preferences SET messenger_enabled_at=now() WHERE messenger;
CREATE INDEX notifications_messenger_pending ON notifications(created_at,id)
 WHERE messenger_enqueued_at IS NULL AND read_at IS NULL;

ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_status_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_status_check
 CHECK(status IN ('pending','sending','delivered','failed','suppressed'));
CREATE INDEX integration_identities_recipient ON integration_identities(provider_key,entity_type,local_id);
CREATE UNIQUE INDEX one_messenger_subscription ON webhook_subscriptions(target_key)
 WHERE active AND topics @> ARRAY['notification.created']::text[];
