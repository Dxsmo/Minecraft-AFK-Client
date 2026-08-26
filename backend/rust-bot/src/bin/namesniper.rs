//! Standalone "Name Sniper" subprocess.
//!
//! One process == one sniper account. It authenticates a Microsoft account
//! exactly like `azalea-bot` (see [`msauth`]) but never joins a Minecraft
//! server — instead it repeatedly calls the Mojang name-change API
//! (`PUT https://api.minecraftservices.com/minecraft/profile/name/{name}`)
//! trying to claim the configured desired name, waiting a configurable
//! cooldown between attempts.
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

    // Build one HTTP client (and thus one independent request strand) per
    // configured proxy. With no proxies, a single direct client is used.
    let workers = build_workers(&config.proxies);
    if workers.len() > 1 {
        emit(&OutEvent::Warning {
            message: format!(
                "{} parallele Stränge aktiv (ein Worker pro Proxy) für maximale Abdeckung.",
                workers.len()
            ),
        });
    }

    let account = Arc::new(account);
    let last_refresh = Arc::new(Mutex::new(Instant::now()));

    // Run every worker concurrently on the single-threaded runtime; they
    // interleave at await points (all work is network I/O). The first to
    // succeed sets `success_name` + `stop`, so the rest wind down promptly.
    let futures = workers.into_iter().map(|(label, client)| {
        let account = Arc::clone(&account);
        let last_refresh = Arc::clone(&last_refresh);
        run_worker(label, client, account, last_refresh)
    });
    futures::future::join_all(futures).await;

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

/// One independent rename-attempt loop, bound to a single HTTP client (which
/// may route through a specific proxy). Returns when the shared `stop` flag is
/// set (by a user stop command or by another worker succeeding).
async fn run_worker(
    label: String,
    http: reqwest::Client,
    account: Arc<Account>,
    last_refresh: Arc<Mutex<Instant>>,
) {
    // Per-worker 429 streak so each proxy backs off on its own schedule.
    let mut consecutive_rate_limits: u32 = 0;

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

        // Proactive token refresh, coordinated across workers so only one
        // refreshes per interval (the others see the bumped timestamp).
        let needs_refresh = {
            let mut lr = last_refresh.lock();
            if lr.elapsed() > TOKEN_REFRESH_INTERVAL {
                *lr = Instant::now();
                true
            } else {
                false
            }
        };
        if needs_refresh {
            let _ = account.refresh().await;
        }

        let Some(token) = account.access_token() else {
            emit(&OutEvent::FatalError {
                error: "No access token available after authentication".into(),
            });
            std::process::exit(1);
        };

        emit(&OutEvent::RenameAttempt {
            desired_name: desired_name.clone(),
            source: Some(label.clone()),
        });

        match attempt_rename(&http, &token, &desired_name).await {
            RenameOutcome::Success { current_name } => {
                // Record the win and signal every other worker to stop; the
                // final success event is emitted centrally in `async_main`.
                let mut s = shared().lock();
                s.success_name = Some(current_name);
                s.stop = true;
                return;
            }
            RenameOutcome::Unauthorized => {
                let _ = account.refresh().await;
                *last_refresh.lock() = Instant::now();
                emit(&OutEvent::Warning {
                    message: format!("[{label}] Zugriffstoken abgelaufen, wird erneuert..."),
                });
            }
            RenameOutcome::RateLimited { retry_after } => {
                if rate_limit_protection {
                    consecutive_rate_limits += 1;
                    // Prefer the server's own Retry-After value; otherwise back
                    // off with a delay that doubles per consecutive 429,
                    // starting no lower than 10s and capped at 5 minutes.
                    let backoff = retry_after.unwrap_or_else(|| {
                        let base = cooldown_seconds.max(10);
                        base.saturating_mul(1u64 << consecutive_rate_limits.min(5).saturating_sub(1))
                            .min(300)
                    });
                    emit(&OutEvent::Warning {
                        message: format!(
                            "[{label}] Rate-Limit erkannt (HTTP 429), warte {backoff}s bevor der nächste Versuch unternommen wird..."
                        ),
                    });
                    sleep_checking_stop(Duration::from_secs(backoff)).await;
                    continue;
                }

                consecutive_rate_limits = 0;
                emit(&OutEvent::RenameResult {
                    success: false,
                    message: "Rate-Limit erreicht (HTTP 429) – zu viele Anfragen. Aktiviere den Rate-Limit-Schutz oder füge Proxies hinzu.".into(),
                    current_name: None,
                    source: Some(label.clone()),
                });
            }
            RenameOutcome::Failed { message } => {
                consecutive_rate_limits = 0;
                emit(&OutEvent::RenameResult {
                    success: false,
                    message,
                    current_name: None,
                    source: Some(label.clone()),
                });
            }
        }

        sleep_checking_stop(Duration::from_secs(cooldown_seconds.clamp(1, 60))).await;
    }
}

/// Turn the configured proxy list into `(label, client)` pairs — one request
/// strand each. An empty list yields a single direct client.
fn build_workers(proxies: &[String]) -> Vec<(String, reqwest::Client)> {
    let cleaned: Vec<&String> = proxies.iter().filter(|p| !p.trim().is_empty()).collect();
    if cleaned.is_empty() {
        return vec![("Direkt".to_string(), reqwest::Client::new())];
    }

    let mut workers = Vec::new();
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

    // If every proxy was invalid, fall back to a direct strand so the sniper
    // still runs rather than silently doing nothing.
    if workers.is_empty() {
        workers.push(("Direkt".to_string(), reqwest::Client::new()));
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
