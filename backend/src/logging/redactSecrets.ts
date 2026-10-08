const secretKeys = new Set([
  "password", "passwordhash", "currentpassword", "newpassword", "credentialspassword", "credentialssecret",
  "secret", "sessionsecret", "encryptionkey", "sessionid", "csrftoken", "accesstoken", "refreshtoken", "token",
  "authorization", "cookie", "proxies",
]);

/** Audit records remain readable while excluding secret-bearing fields at any depth. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 32) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    secretKeys.has(key.toLowerCase().replace(/[_-]/g, "")) ? "[REDACTED]" : redactSecrets(entry, depth + 1),
  ]));
}
