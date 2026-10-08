-- Prior Name Sniper settings audits stored the submitted proxy credentials as plaintext.
UPDATE "AuditLog"
SET "details" = json_set("details", '$.proxies', '[REDACTED]')
WHERE "action" = 'SNIPER_ACCOUNT_UPDATE'
  AND json_valid("details")
  AND json_type("details", '$.proxies') IS NOT NULL;
