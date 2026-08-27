//! Standalone "Name Sniper" subprocess.
//!
//! One process == one sniper account. It authenticates a Microsoft account
//! exactly like `azalea-bot` (see [`msauth`]) but never joins a Minecraft
//! server. It works in two phases:
//!
//!   1. **Availability polling** — it rapidly polls the *public* name-lookup
//!      endpoint (`GET /minecraft/profile/lookup/name/{name}`, no auth), which
//!      is rate-limited *per IP*. Requests are rotated across the direct "Home"
//!      connection plus every configured proxy, so more proxies == more checks
//!      per second without tripping the per-IP limit. A `404` means the name
//!      currently has no owner and is (likely) claimable.
//!   2. **Instant claim** — the moment a lookup reports the name is free, it
//!      fires the authenticated rename (`PUT /minecraft/profile/name/{name}`).
//!      That endpoint is rate-limited *per account*, so it is only ever fired
//!      when the name is actually free — never spammed — which also avoids the
//!      temporary account suspension Mojang applies to high volumes of 429s.
//!
//! Speaks the same NDJSON-over-stdio style as `azalea-bot`:
//!   * The **first** stdin line is a [`protocol::SniperConfig`] JSON object.
//!   * Every **subsequent** stdin line is a [`protocol::SniperCommand`] JSON
//!     object (configure / stop).
//!   * Every stdout line is a [`protocol::OutEvent`] JSON object.
//!
//! These sibling modules are shared with `main.rs` (the `azalea-bot` binary)
//! via `#[path]` inclusion rather than duplicated, so both binaries
//! authenticate identically and speak the identical wire protocol types.

#[path = "../mspassword.rs"]
mod mspassword;
#[path = "../msauth.rs"]
mod msauth;
#[path = "../protocol.rs"]
mod protocol;

use std::io::{BufRead, Write};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use azalea::prelude::*;
use parking_lot::Mutex;
use protocol::{OutEvent, SniperCommand, SniperConfig};

/// How often the Microsoft/Minecraft access token is proactively refreshed
/// while the loop is running, well within its typical ~24h lifetime.
const TOKEN_REFRESH_INTERVAL: Duration = Duration::from_secs(20 * 60);
/// How long the idle loop (no desired name configured yet) sleeps between
/// checks.
const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Granularity used while sleeping out a cooldown, so a `Stop` command takes
/// effect quickly instead of waiting out the full cooldown.
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// How often a "still taken" heartbeat is emitted while polling, so the console
/// shows progress without a line for every single availability check.
const STATUS_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// Serialize and print a single NDJSON event on stdout, then flush so Node
/// receives it immediately (line-buffered pipes otherwise hold it back).
pub(crate) fn emit(event: &OutEvent) {
    if let Ok(line) = serde_json::to_string(event) {
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        let _ = writeln!(lock, "{line}");
        let _ = lock.flush();
    }
}

fn flush_stdout() {
    let _ = std::io::stdout().flush();
}

/// State shared between the stdin-reader thread (producer) and the worker
/// loops (consumers).
struct Shared {
    desired_name: String,
    cooldown_seconds: u64,
    rate_limit_protection: bool,
    stop: bool,
    /// Set by the first worker that succeeds (carries the claimed name), which
    /// also flips `stop` so the remaining workers wind down.
    success_name: Option<String>,
}

static SHARED: OnceLock<Arc<Mutex<Shared>>> = OnceLock::new();

fn shared() -> &'static Arc<Mutex<Shared>> {
    SHARED.get().expect("shared state not initialized")
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build the Tokio runtime");
    runtime.block_on(async_main());
}

async fn async_main() {
    let config = match read_config() {
        Some(c) => c,
        None => {
            emit(&OutEvent::FatalError {
                error: "No config received on stdin".into(),
            });
            std::process::exit(1);
        }
    };

    let _ = SHARED.set(Arc::new(Mutex::new(Shared {
        desired_name: config.desired_name.clone(),
        cooldown_seconds: config.cooldown_seconds.clamp(1, 60),
        rate_limit_protection: config.rate_limit_protection,
        stop: false,
        success_name: None,
    })));

    spawn_command_reader();

    let account = match msauth::build_microsoft_account(
        &config.cache_dir,
        Some(config.email.as_str()),
        None,
        &config.email,
    )
    .await
    {
        Ok(a) => a,
        Err(e) => {
            emit(&OutEvent::FatalError {
                error: format!("Authentication failed: {e}"),
            });
            std::process::exit(1);
        }
    };

    // Build the ordered list of availability-check sources: the direct "Home"
    // connection first, followed by one HTTP client per configured proxy. The
    // poll loop rotates through them, so each individual IP stays well under
    // its per-IP lookup rate limit while the *combined* check rate scales with
    // the number of sources.
    let sources = build_workers(&config.proxies);
    // Global poll interval: fast, but throttled so each individual IP is hit at
    // most ~once per second. More sources -> shorter global interval -> more
    // checks per second overall.
    let poll_interval =
        Duration::from_millis((1000 / sources.len() as u64).max(120));
    let checks_per_sec = 1000.0 / poll_interval.as_millis() as f64;
    emit(&OutEvent::Warning {
        message: format!(
            "Verfügbarkeits-Polling über {} Quelle(n) (Home + Proxys) – ~{:.1} Checks/Sekunde. Der Rename wird erst gefeuert, sobald der Name frei ist.",
            sources.len(),
            checks_per_sec,
        ),
    });

    let account = Arc::new(account);
    run_rotation(sources, poll_interval, account).await;

    if let Some(name) = shared().lock().success_name.clone() {
        emit(&OutEvent::RenameResult {
            success: true,
            message: format!("Name erfolgreich zu \"{name}\" geändert! Sniper wird gestoppt."),
            current_name: Some(name),
            source: None,
        });
    }
    flush_stdout();
    std::process::exit(0);
}

/// The main sniper loop. Phase 1 rapidly polls the public name-lookup endpoint,
/// rotating across all sources (Home + proxies) so each IP stays under its
/// per-IP limit. Phase 2 fires the authenticated rename the instant a lookup
/// reports the name is free. Returns when the shared `stop` flag is set (by a
/// user stop command or by a successful rename).
async fn run_rotation(
    sources: Vec<(String, reqwest::Client)>,
    poll_interval: Duration,
    account: Arc<Account>,
) {
    let mut last_refresh = Instant::now();
    // Consecutive 429s on the *rename* endpoint, for exponential backoff when
    // rate-limit protection is enabled.
    let mut consecutive_rate_limits: u32 = 0;
    // Which source performs the next availability check; wraps around.
    let mut idx: usize = 0;
    // When we last actually fired a rename, so account-limited rename attempts
    // are spaced by the configured cooldown even if the name reads as free.
    let mut last_rename_attempt: Option<Instant> = None;
    // When we last emitted a "still taken" heartbeat.
    let mut last_status_emit: Option<Instant> = None;
    // A dedicated direct client for the actual claim; the rename is account-
    // limited, so the IP it goes out on does not matter — keep it off the
    // rotated proxy clients.
    let home = reqwest::Client::new();

    loop {
        let (stop, desired_name, cooldown_seconds, rate_limit_protection) = {
            let s = shared().lock();
            (s.stop, s.desired_name.clone(), s.cooldown_seconds, s.rate_limit_protection)
        };
        if stop {
            return;
        }

        if desired_name.trim().is_empty() {
            sleep_checking_stop(IDLE_POLL_INTERVAL).await;
            continue;
        }

        // Proactive token refresh, kept ready so the claim can fire instantly.
        if last_refresh.elapsed() > TOKEN_REFRESH_INTERVAL {
            let _ = account.refresh().await;
            last_refresh = Instant::now();
        }

        // Phase 1: availability check via the next rotated source.
        let (label, http) = {
            let (label, client) = &sources[idx % sources.len()];
            (label.clone(), client.clone())
        };
        idx = idx.wrapping_add(1);

        match attempt_lookup(&http, &desired_name).await {
            LookupOutcome::Free => {
                // Phase 2: the name has no owner — claim it now, respecting the
                // rename cooldown so repeated attempts don't rack up 429s.
                let ready = last_rename_attempt
                    .map(|t| t.elapsed() >= Duration::from_secs(cooldown_seconds.clamp(1, 60)))
                    .unwrap_or(true);
                if !ready {
                    sleep_checking_stop(poll_interval).await;
                    continue;
                }

                let Some(token) = account.access_token() else {
                    emit(&OutEvent::FatalError {
                        error: "No access token available after authentication".into(),
                    });
                    std::process::exit(1);
                };

                emit(&OutEvent::RenameAttempt {
                    desired_name: desired_name.clone(),
                    source: Some("Claim".to_string()),
                });
                last_rename_attempt = Some(Instant::now());
                last_status_emit = None;

                match attempt_rename(&home, &token, &desired_name).await {
                    RenameOutcome::Success { current_name } => {
                        let mut s = shared().lock();
                        s.success_name = Some(current_name);
                        s.stop = true;
                        return;
                    }
                    RenameOutcome::Unauthorized => {
                        let _ = account.refresh().await;
                        last_refresh = Instant::now();
                        emit(&OutEvent::Warning {
                            message: "Zugriffstoken abgelaufen, wird erneuert...".into(),
                        });
                    }
                    RenameOutcome::RateLimited { retry_after } => {
                        consecutive_rate_limits += 1;
                        let backoff = if rate_limit_protection {
                            retry_after.unwrap_or_else(|| {
                                let base = cooldown_seconds.max(10);
                                base.saturating_mul(1u64 << consecutive_rate_limits.min(5).saturating_sub(1))
                                    .min(300)
                            })
                        } else {
                            // Even without protection, never hammer the rename
                            // endpoint: a small mandatory pause avoids the
                            // suspension Mojang applies to 429 floods.
                            retry_after.unwrap_or_else(|| cooldown_seconds.clamp(1, 60))
                        };
                        emit(&OutEvent::Warning {
                            message: format!(
                                "Rate-Limit beim Rename (HTTP 429). Warte {backoff}s vor dem nächsten Claim-Versuch (Konto-Limit – zu viele Versuche können den Account temporär sperren)."
                            ),
                        });
                        sleep_checking_stop(Duration::from_secs(backoff)).await;
                        continue;
                    }
                    RenameOutcome::Failed { message } => {
                        // A rename failure right after a "free" lookup usually
                        // means someone else grabbed it or it's in the 37-day
                        // protection window — report and keep polling.
                        consecutive_rate_limits = 0;
                        emit(&OutEvent::RenameResult {
                            success: false,
                            message,
                            current_name: None,
                            source: Some("Claim".to_string()),
                        });
                    }
                }
            }
            LookupOutcome::Taken => {
                // Still owned — emit an occasional heartbeat so the console
                // shows the sniper is alive without a line per check.
                let due = last_status_emit
                    .map(|t| t.elapsed() >= STATUS_HEARTBEAT_INTERVAL)
                    .unwrap_or(true);
                if due {
                    last_status_emit = Some(Instant::now());
                    emit(&OutEvent::Warning {
                        message: format!(
                            "[{label}] Prüfe „{desired_name}\"… noch vergeben, warte auf Freigabe."
                        ),
                    });
                }
            }
            LookupOutcome::RateLimited { .. } => {
                emit(&OutEvent::Warning {
                    message: format!(
                        "[{label}] Lookup-Rate-Limit (HTTP 429) auf dieser IP – wird übersprungen. Mehr Proxys hinzufügen, um schneller zu prüfen."
                    ),
                });
            }
            LookupOutcome::Error { message } => {
                emit(&OutEvent::Warning {
                    message: format!("[{label}] {message}"),
                });
            }
        }

        sleep_checking_stop(poll_interval).await;
    }
}

/// Build the ordered list of `(label, client)` request sources for the
/// rotation: the direct "Home" connection is always first, followed by one
/// client per valid proxy. Invalid proxies are skipped with a warning.
fn build_workers(proxies: &[String]) -> Vec<(String, reqwest::Client)> {
    // The direct/home connection always leads the rotation.
    let mut workers = vec![("Home".to_string(), reqwest::Client::new())];

    let cleaned: Vec<&String> = proxies.iter().filter(|p| !p.trim().is_empty()).collect();
    for (idx, proxy) in cleaned.iter().enumerate() {
        let raw = proxy.trim();
        let label = format!("Proxy {} ({})", idx + 1, proxy_display(raw));
        match reqwest::Proxy::all(raw).and_then(|px| reqwest::Client::builder().proxy(px).build()) {
            Ok(client) => workers.push((label, client)),
            Err(e) => emit(&OutEvent::Warning {
                message: format!("Proxy \"{}\" wird übersprungen (ungültig: {e})", proxy_display(raw)),
            }),
        }
    }

    workers
}

/// Strip any `user:pass@` credentials from a proxy URL for safe display/logging.
fn proxy_display(proxy: &str) -> String {
    match (proxy.rfind('@'), proxy.find("://")) {
        (Some(at), Some(scheme)) => {
            format!("{}{}", &proxy[..scheme + 3], &proxy[at + 1..])
        }
        (Some(at), None) => proxy[at + 1..].to_string(),
        _ => proxy.to_string(),
    }
}

enum RenameOutcome {
    Success { current_name: String },
    Unauthorized,
    /// HTTP 429: rate limited by Mojang. Carries the `Retry-After` header
    /// value in seconds, if the server sent one.
    RateLimited { retry_after: Option<u64> },
    Failed { message: String },
}

/// Result of a public name-availability lookup.
enum LookupOutcome {
    /// The name currently has no owner (HTTP 404) — likely claimable.
    Free,
    /// The name is owned by someone (HTTP 2xx with a profile).
    Taken,
    /// HTTP 429 on the lookup endpoint (per-IP limit for this source).
    RateLimited { retry_after: Option<u64> },
    Error { message: String },
}

/// Check whether `name` currently has an owner via the public, unauthenticated
/// name-lookup endpoint. This endpoint is rate-limited *per IP*, so callers
/// rotate it across multiple proxy clients to raise the combined check rate.
async fn attempt_lookup(client: &reqwest::Client, name: &str) -> LookupOutcome {
    let url = format!("https://api.minecraftservices.com/minecraft/profile/lookup/name/{name}");
    let res = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            return LookupOutcome::Error {
                message: format!("Verfügbarkeits-Check fehlgeschlagen: {e}"),
            };
        }
    };

    let status = res.status();
    match status.as_u16() {
        404 => LookupOutcome::Free,
        429 => {
            let retry_after = res
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok());
            LookupOutcome::RateLimited { retry_after }
        }
        code if (200..300).contains(&code) => LookupOutcome::Taken,
        _ => LookupOutcome::Error {
            message: format!("Verfügbarkeits-Check: unerwartete Antwort (HTTP {status})"),
        },
    }
}

/// Call the Mojang name-change API once and classify the result.
async fn attempt_rename(client: &reqwest::Client, token: &str, desired_name: &str) -> RenameOutcome {
    let url = format!("https://api.minecraftservices.com/minecraft/profile/name/{desired_name}");
    let res = match client.put(&url).bearer_auth(token).send().await {
        Ok(r) => r,
        Err(e) => {
            return RenameOutcome::Failed {
                message: format!("Anfrage fehlgeschlagen: {e}"),
            };
        }
    };

    let status = res.status();

    if status.as_u16() == 429 {
        let retry_after = res
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        return RenameOutcome::RateLimited { retry_after };
    }

    let body = res.text().await.unwrap_or_default();

    if status.is_success() {
        let name = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
            .unwrap_or_else(|| desired_name.to_string());
        return RenameOutcome::Success { current_name: name };
    }

    if status.as_u16() == 401 {
        return RenameOutcome::Unauthorized;
    }

    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("errorMessage")
                .or_else(|| v.get("error"))
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("Name nicht verfügbar (HTTP {status})"));
    RenameOutcome::Failed { message }
}

/// Sleep for `total`, checking the shared `stop` flag frequently so a `Stop`
/// command interrupts the wait almost immediately instead of blocking for the
/// full cooldown.
async fn sleep_checking_stop(total: Duration) {
    let mut elapsed = Duration::ZERO;
    while elapsed < total {
        if shared().lock().stop {
            return;
        }
        let step = STOP_POLL_INTERVAL.min(total - elapsed);
        tokio::time::sleep(step).await;
        elapsed += step;
    }
}

/// Read and parse the first stdin line into a [`SniperConfig`].
fn read_config() -> Option<SniperConfig> {
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).ok()? == 0 {
        return None;
    }
    match serde_json::from_str(line.trim()) {
        Ok(config) => Some(config),
        Err(e) => {
            emit(&OutEvent::FatalError {
                error: format!("Invalid config JSON: {e}"),
            });
            None
        }
    }
}

/// Continuously read command lines from stdin and apply them to [`Shared`].
fn spawn_command_reader() {
    std::thread::spawn(|| {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<SniperCommand>(line) {
                Ok(SniperCommand::Configure { desired_name, cooldown_seconds, rate_limit_protection }) => {
                    let mut s = shared().lock();
                    s.desired_name = desired_name;
                    s.cooldown_seconds = cooldown_seconds.clamp(1, 60);
                    s.rate_limit_protection = rate_limit_protection;
                }
                Ok(SniperCommand::Stop) => {
                    shared().lock().stop = true;
                }
                Err(e) => emit(&OutEvent::Warning {
                    message: format!("Ignored malformed command: {e}"),
                }),
            }
        }
    });
}
