//! Assemble game bundles before exposing their contents to ECS systems.

use std::io::Cursor;

use azalea_buf::AzBufVar;
use azalea_protocol::packets::{
    ConnectionProtocol, Packet, ProtocolPacket,
    game::{ClientboundBundleDelimiter, ClientboundStartConfiguration},
};
use thiserror::Error;

/// Matches Mojang's BundlerInfo limit, excluding the two delimiters.
pub const MAX_GAME_BUNDLE_PACKETS: usize = 4096;

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
}

impl GameBundle {
    pub(super) fn pending_packets(&self) -> Option<usize> {
        self.pending.as_ref().map(Vec::len)
    }

    pub(super) fn collect(
        &mut self,
        state: ConnectionProtocol,
        raw: &[u8],
    ) -> Result<IncomingPacketBatch, IncomingBundleError> {
        if state != ConnectionProtocol::Game {
            self.pending = None;
            return Ok(IncomingPacketBatch::Single);
        }
        // A zero-byte frame has no ID and must not close a valid open bundle.
        if raw.is_empty() {
            return Ok(IncomingPacketBatch::Pending);
        }
        // Upstream's VarInt reader ignores a continuation bit on byte five.
        // It must not turn an unterminated zero ID into a closing delimiter.
        if raw.len() >= 5 && raw[..5].iter().all(|byte| byte & 0x80 != 0) {
            self.pending = None;
            return Err(IncomingBundleError::MalformedPacketId(
                "VarInt exceeds five bytes".into(),
            ));
        }
        let mut cursor = Cursor::new(raw);
        let id = match u32::azalea_read_var(&mut cursor) {
            Ok(id) => id,
            Err(error) if self.pending.is_some() => {
                self.pending = None;
                return Err(IncomingBundleError::MalformedPacketId(error.to_string()));
            }
            // Preserve ordinary packet parsing and its normal error handling.
            Err(_) => return Ok(IncomingPacketBatch::Single),
        };
        if id == ClientboundBundleDelimiter.into_variant().id() {
            if cursor.position() as usize != raw.len() {
                self.pending = None;
                return Err(IncomingBundleError::MalformedDelimiter);
            }
            return Ok(match self.pending.take() {
                Some(packets) => {
                    self.completed = self.completed.saturating_add(1);
                    IncomingPacketBatch::Complete(packets)
                }
                None => {
                    self.pending = Some(Vec::new());
                    IncomingPacketBatch::Pending
                }
            });
        }
        if self.pending.is_some() && id == ClientboundStartConfiguration.into_variant().id() {
            self.pending = None;
            return Err(IncomingBundleError::TerminalPacket);
        }
        if let Some(packets) = &mut self.pending {
            if packets.len() >= MAX_GAME_BUNDLE_PACKETS {
                self.pending = None;
                return Err(IncomingBundleError::TooManyPackets);
            }
            packets.push(raw.to_vec().into_boxed_slice());
            Ok(IncomingPacketBatch::Pending)
        } else {
            Ok(IncomingPacketBatch::Single)
        }
    }
}
