const REMEMBER_KEY = "afk.remembered-login.v1";
type PasswordCredentialConstructor = new (data: { id: string; password: string }) => Credential;

function passwordCredentialConstructor() {
  return (window as Window & { PasswordCredential?: PasswordCredentialConstructor }).PasswordCredential;
}

/** Only the username/preference goes into website storage; never the password. */
export function rememberedUsername(): string | null {
  try {
    const entry = JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? "null");
    return entry && Object.keys(entry).length === 1 && typeof entry.username === "string" &&
      entry.username.trim().length > 0 && entry.username.length <= 64 ? entry.username : null;
  } catch { return null; }
}

export function rememberUsername(username: string | null) {
  try {
    if (username === null) localStorage.removeItem(REMEMBER_KEY);
    else localStorage.setItem(REMEMBER_KEY, JSON.stringify({ username }));
  } catch { /* Private browsing/storage restrictions must not prevent login. */ }
}

/** The browser decides whether to save, and may ask the user to confirm. */
export async function storeBrowserPassword(username: string, password: string) {
  const Constructor = passwordCredentialConstructor();
  if (!window.isSecureContext || !Constructor || !navigator.credentials) return;
  try { await navigator.credentials.store(new Constructor({ id: username, password })); }
  catch { /* Native autocomplete remains available if the browser declines. */ }
}

export async function restoreBrowserPassword(username: string, signal: AbortSignal): Promise<string | null> {
  if (!window.isSecureContext || !passwordCredentialConstructor() || !navigator.credentials) return null;
  try {
    // Only prefill; never sign in automatically or open a chooser on page load.
    const options = { password: true, mediation: "silent" as const, signal };
    const credential = await navigator.credentials.get(options);
    if (credential?.type === "password" && credential.id.toLowerCase() === username.toLowerCase() &&
        "password" in credential && typeof credential.password === "string") return credential.password;
  } catch { /* Ordinary browser/password-manager autocomplete is the fallback. */ }
  return null;
}
