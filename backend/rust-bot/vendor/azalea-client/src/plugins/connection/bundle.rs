//! Assemble game bundles before exposing their contents to ECS systems.

use std::{io::Cursor, sync::LazyLock, time::Instant};

use azalea_buf::AzBufVar;
use azalea_protocol::packets::{
    ConnectionProtocol, Packet, ProtocolPacket,
    game::{
        ClientboundBundleDelimiter, ClientboundKeepAlive, ClientboundPing,
        ClientboundStartConfiguration,
    },
};
use thiserror::Error;

/// Matches Mojang's BundlerInfo limit, excluding the two delimiters.
pub const MAX_GAME_BUNDLE_PACKETS: usize = 4096;

static CONTROL_IDS: LazyLock<(u32, u32)> = LazyLock::new(|| {
    (
        ClientboundKeepAlive { id: 0 }.into_variant().id(),
        ClientboundPing { id: 0 }.into_variant().id(),
    )
});

#[derive(Clone, Copy, Debug, Default)]
pub struct IncomingBundleDiagnostics {
    pub pending_age_ms: Option<u64>,
    pub pending_keepalives: usize,
    pub pending_pings: usize,
    pub pending_control_age_ms: Option<u64>,
    pub max_completed_age_ms: u64,
    pub max_control_wait_ms: u64,
}

pub enum IncomingPacketBatch {
    /// An ordinary packet; the caller can use its original allocation.
    Single,
    /// A delimiter or an incomplete bundle. Do not run packet handlers yet.
    Pending,
    /// Apply all these packets in wire order before yielding to other systems.
    Complete(Vec<Box<[u8]>>),
}

#[derive(Debug, Error)]
pub enum IncomingBundleError {
    #[error("Too many packets in a bundle (maximum {MAX_GAME_BUNDLE_PACKETS})")]
    TooManyPackets,
    #[error("Terminal message received in bundle: start_configuration")]
    TerminalPacket,
    #[error("Malformed bundle delimiter")]
    MalformedDelimiter,
    #[error("Malformed packet ID in bundle: {0}")]
    MalformedPacketId(String),
}

#[derive(Default)]
pub(super) struct GameBundle {
    pending: Option<Vec<Box<[u8]>>>,
    pub(super) completed: u64,
    started_at: Option<Instant>,
    control_started_at: Option<Instant>,
    pending_keepalives: usize,
    pending_pings: usize,
    max_completed_age_ms: u64,
    max_control_wait_ms: u64,
}

impl GameBundle {
    pub(super) fn pending_packets(&self) -> Option<usize> {
        self.pending.as_ref().map(Vec::len)
    }

    pub(super) fn diagnostics(&self) -> IncomingBundleDiagnostics {
        IncomingBundleDiagnostics {
            pending_age_ms: self.started_at.map(|at| at.elapsed().as_millis() as u64),
            pending_keepalives: self.pending_keepalives,
            pending_pings: self.pending_pings,
            pending_control_age_ms: self
                .control_started_at
                .map(|at| at.elapsed().as_millis() as u64),
            max_completed_age_ms: self.max_completed_age_ms,
            max_control_wait_ms: self.max_control_wait_ms,
        }
    }

    fn clear_pending(&mut self) {
        self.pending = None;
        self.started_at = None;
        self.control_started_at = None;
        self.pending_keepalives = 0;
        self.pending_pings = 0;
    }

    pub(super) fn collect(
        &mut self,
        state: ConnectionProtocol,
        raw: &[u8],
    ) -> Result<IncomingPacketBatch, IncomingBundleError> {
        if state != ConnectionProtocol::Game {
            self.clear_pending();
            return Ok(IncomingPacketBatch::Single);
        }
        // A zero-byte frame has no ID and must not close a valid open bundle.
        if raw.is_empty() {
            return Ok(IncomingPacketBatch::Pending);
        }
        // Upstream's VarInt reader ignores a continuation bit on byte five.
        // It must not turn an unterminated zero ID into a closing delimiter.
        if raw.len() >= 5 && raw[..5].iter().all(|byte| byte & 0x80 != 0) {
            self.clear_pending();
            return Err(IncomingBundleError::MalformedPacketId(
                "VarInt exceeds five bytes".into(),
            ));
        }
        let mut cursor = Cursor::new(raw);
        let id = match u32::azalea_read_var(&mut cursor) {
            Ok(id) => id,
            Err(error) if self.pending.is_some() => {
                self.clear_pending();
                return Err(IncomingBundleError::MalformedPacketId(error.to_string()));
            }
            // Preserve ordinary packet parsing and its normal error handling.
            Err(_) => return Ok(IncomingPacketBatch::Single),
        };
        if id == ClientboundBundleDelimiter.into_variant().id() {
            if cursor.position() as usize != raw.len() {
                self.clear_pending();
                return Err(IncomingBundleError::MalformedDelimiter);
            }
            return Ok(match self.pending.take() {
                Some(packets) => {
                    self.completed = self.completed.saturating_add(1);
                    if let Some(at) = self.started_at {
                        self.max_completed_age_ms = self
                            .max_completed_age_ms
                            .max(at.elapsed().as_millis() as u64);
                    }
                    if let Some(at) = self.control_started_at {
                        self.max_control_wait_ms = self
                            .max_control_wait_ms
                            .max(at.elapsed().as_millis() as u64);
                    }
                    self.clear_pending();
                    IncomingPacketBatch::Complete(packets)
                }
                None => {
                    self.pending = Some(Vec::new());
                    self.started_at = Some(Instant::now());
                    IncomingPacketBatch::Pending
                }
            });
        }
        if self.pending.is_some() && id == ClientboundStartConfiguration.into_variant().id() {
            self.clear_pending();
            return Err(IncomingBundleError::TerminalPacket);
        }
        if let Some(packets) = &mut self.pending {
            if packets.len() >= MAX_GAME_BUNDLE_PACKETS {
                self.clear_pending();
                return Err(IncomingBundleError::TooManyPackets);
            }
            packets.push(raw.to_vec().into_boxed_slice());
            if id == CONTROL_IDS.0 || id == CONTROL_IDS.1 {
                self.control_started_at.get_or_insert_with(Instant::now);
                if id == CONTROL_IDS.0 {
                    self.pending_keepalives += 1;
                } else {
                    self.pending_pings += 1;
                }
            }
            Ok(IncomingPacketBatch::Pending)
        } else {
            Ok(IncomingPacketBatch::Single)
        }
    }
}
