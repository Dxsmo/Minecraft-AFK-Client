mod bundle;

pub use bundle::{
    IncomingBundleDiagnostics, IncomingBundleError, IncomingPacketBatch, MAX_GAME_BUNDLE_PACKETS,
};

use std::{
    fmt::{self, Debug},
    io::{self, Cursor},
    mem,
    sync::{
        Arc,
        atomic::{self, AtomicBool, AtomicU64},
    },
    time::Instant,
};

use azalea_crypto::Aes128CfbEnc;
use azalea_protocol::{
    connect::{RawReadConnection, RawWriteConnection},
    packets::{
        ConnectionProtocol, Packet, ProtocolPacket, config::ClientboundConfigPacket,
        game::ClientboundGamePacket, login::ClientboundLoginPacket,
    },
    read::{ReadPacketError, deserialize_packet},
    write::serialize_packet,
};
use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use bevy_tasks::{IoTaskPool, futures_lite::future};
use thiserror::Error;
use tokio::{
    io::AsyncWriteExt,
    net::tcp::OwnedWriteHalf,
    sync::mpsc::{self},
};
use tracing::{debug, error, info, trace};

use super::packet::{
    config::ReceiveConfigPacketEvent, game::ReceiveGamePacketEvent, login::ReceiveLoginPacketEvent,
};
use crate::packet::{config, game, login};

pub struct ConnectionPlugin;
impl Plugin for ConnectionPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PreUpdate, (read_packets, poll_all_writer_tasks).chain());
    }
}

pub fn read_packets(ecs: &mut World) {
    let mut entity_and_conn_query = ecs.query::<(Entity, &mut RawConnection)>();
    let mut conn_query = ecs.query::<&mut RawConnection>();

    let mut entities_handling_packets = Vec::new();
    let mut entities_with_injected_packets = Vec::new();
    for (entity, mut raw_conn) in entity_and_conn_query.iter_mut(ecs) {
        if !raw_conn.injected_clientbound_packets.is_empty() {
            entities_with_injected_packets.push((
                entity,
                mem::take(&mut raw_conn.injected_clientbound_packets),
            ));
        }

        if raw_conn.network.is_none() {
            // no network connection, don't bother with the normal packet handling
            continue;
        }

        entities_handling_packets.push(entity);
    }

    let mut queued_packet_events = QueuedPacketEvents::default();

    // handle injected packets, see the comment on
    // RawConnection::injected_clientbound_packets for more info
    for (entity, raw_packets) in entities_with_injected_packets {
        for raw_packet in raw_packets {
            let conn = conn_query.get(ecs, entity).unwrap();
            if !conn.is_alive() {
                break;
            }
            let state = conn.state;

            trace!("Received injected packet with bytes: {raw_packet:?}");
            if let Err(e) =
                handle_raw_packet(ecs, &raw_packet, entity, state, &mut queued_packet_events)
            {
                error!("Error reading injected packet: {e}");
            }
        }
    }

    for entity in entities_handling_packets {
        loop {
            let mut conn = conn_query.get_mut(ecs, entity).unwrap();
            if !conn.is_alive() {
                break;
            }
            let Some(net_conn) = conn.net_conn() else {
                break;
            };
            let read_res = net_conn.try_read();
            let state = conn.state;
            match read_res {
                Ok(Some(raw_packet)) => {
                    let raw_packet = Arc::<[u8]>::from(raw_packet);
                    if let Err(e) = handle_raw_packet(
                        ecs,
                        &raw_packet,
                        entity,
                        state,
                        &mut queued_packet_events,
                    ) {
                        error!("Error reading packet: {e}");
                    }
                }
                Ok(None) => {
                    // no packets available
                    break;
                }
                Err(err) => {
                    log_for_error(&err);

                    if matches!(
                        &*err,
                        ReadPacketError::IoError { .. } | ReadPacketError::ConnectionClosed
                    ) {
                        info!("Server closed connection");
                        // ungraceful disconnect :(
                        conn.network = None;
                        // setting this will make us send a DisconnectEvent
                        conn.is_alive = false;
                    }

                    break;
                }
            }
        }
    }

    queued_packet_events.write_messages(ecs);
}

#[doc(hidden)]
pub fn poll_all_writer_tasks(mut conn_query: Query<&mut RawConnection>) {
    for mut conn in conn_query.iter_mut() {
        if let Some(net_conn) = &mut conn.network {
            // this needs to be done at some point every update to make sure packets are
            // actually sent to the network

            if net_conn.poll_writer().is_some() {
                // means the writer task ended
                conn.network = None;
                conn.is_alive = false;
            }
        }
    }
}

#[derive(Default)]
pub struct QueuedPacketEvents {
    login: Vec<ReceiveLoginPacketEvent>,
    config: Vec<ReceiveConfigPacketEvent>,
    game: Vec<ReceiveGamePacketEvent>,
}
impl QueuedPacketEvents {
    fn write_messages(&mut self, ecs: &mut World) {
        ecs.write_message_batch(self.login.drain(..));
        ecs.write_message_batch(self.config.drain(..));
        ecs.write_message_batch(self.game.drain(..));
    }
}

fn log_for_error(error: &ReadPacketError) {
    if !matches!(*error, ReadPacketError::ConnectionClosed) {
        error!("Error reading packet from Client: {error:?}");
    }
}

/// The client's connection to the server.
#[derive(Component)]
pub struct RawConnection {
    /// The network connection to the server.
    ///
    /// This isn't guaranteed to be present, for example during the main packet
    /// handlers or at all times during tests.
    ///
    /// You shouldn't rely on this. Instead, use the events for sending packets
    /// like [`SendGamePacketEvent`](crate::packet::game::SendGamePacketEvent) /
    /// [`SendConfigPacketEvent`](crate::packet::config::SendConfigPacketEvent)
    /// / [`SendLoginPacketEvent`](crate::packet::login::SendLoginPacketEvent).
    ///
    /// To check if we haven't disconnected from the server, use
    /// [`Self::is_alive`].
    pub(crate) network: Option<NetworkConnection>,
    pub state: ConnectionProtocol,
    pub(crate) is_alive: bool,

    /// This exists for internal testing purposes and probably shouldn't be used
    /// for normal bots.
    ///
    /// It's basically a way to make our client think it received a packet from
    /// the server without needing to interact with the network.
    pub injected_clientbound_packets: Vec<Box<[u8]>>,
    incoming_bundle: bundle::GameBundle,
}
impl RawConnection {
    pub fn new(
        reader: RawReadConnection,
        writer: RawWriteConnection,
        state: ConnectionProtocol,
    ) -> Self {
        let task_pool = IoTaskPool::get();

        let (network_packet_writer_tx, network_packet_writer_rx) =
            mpsc::unbounded_channel::<PendingNetworkPacket>();
        let write_statistics = Arc::new(WriteStatistics::default());

        let writer_task = task_pool.spawn(write_task(
            network_packet_writer_rx,
            writer.write_stream,
            write_statistics.clone(),
        ));

        let mut conn = Self::new_networkless(state);
        conn.network = Some(NetworkConnection {
            reader,
            enc_cipher: writer.enc_cipher,
            network_packet_writer_tx,
            writer_task,
            write_statistics,
            writer_finished: false,
        });

        conn
    }

    pub fn new_networkless(state: ConnectionProtocol) -> Self {
        Self {
            network: None,
            state,
            is_alive: true,
            injected_clientbound_packets: Vec::new(),
            incoming_bundle: bundle::GameBundle::default(),
        }
    }

    pub fn is_alive(&self) -> bool {
        self.is_alive
    }

    /// Hold game bundles across reads/updates and release them only when complete.
    /// Both network readers must call this before invoking any packet handler.
    pub fn collect_incoming_packet(
        &mut self,
        raw: &[u8],
    ) -> Result<IncomingPacketBatch, IncomingBundleError> {
        self.incoming_bundle.collect(self.state, raw)
    }

    /// Write a packet to the server without emitting any events.
    ///
    /// This is called by the handlers for [`SendGamePacketEvent`],
    /// [`SendConfigPacketEvent`], and [`SendLoginPacketEvent`].
    ///
    /// [`SendGamePacketEvent`]: crate::packet::game::SendGamePacketEvent
    /// [`SendConfigPacketEvent`]: crate::packet::config::SendConfigPacketEvent
    /// [`SendLoginPacketEvent`]: crate::packet::login::SendLoginPacketEvent
    pub fn write<P: ProtocolPacket + Debug>(
        &mut self,
        packet: impl Packet<P>,
    ) -> Result<(), WritePacketError> {
        if let Some(network) = &mut self.network {
            network.write(packet)?;
        } else {
            static WARNED: AtomicBool = AtomicBool::new(false);
            if !WARNED.swap(true, atomic::Ordering::Relaxed) {
                debug!(
                    "tried to write packet to the network but there is no NetworkConnection. if you're trying to send a packet from the handler function, use self.write instead"
                );
            }
        }
        Ok(())
    }

    pub fn net_conn(&mut self) -> Option<&mut NetworkConnection> {
        self.network.as_mut()
    }

    /// A nonblocking snapshot. Completed writes mean TCP accepted the bytes,
    /// not that the remote Minecraft server acknowledged the packet.
    pub fn network_diagnostics(&self) -> Option<NetworkDiagnostics> {
        self.network.as_ref().map(|network| {
            let mut diagnostics = network.diagnostics();
            diagnostics.completed_bundles = self.incoming_bundle.completed;
            diagnostics.pending_bundle_packets = self.incoming_bundle.pending_packets();
            diagnostics.bundle = self.incoming_bundle.diagnostics();
            diagnostics
        })
    }
}

pub fn handle_raw_packet(
    ecs: &mut World,
    raw_packet: &[u8],
    entity: Entity,
    state: ConnectionProtocol,
    queued_packet_events: &mut QueuedPacketEvents,
) -> Result<(), Box<ReadPacketError>> {
    // A framed empty payload has no packet ID. Preserve the same silent skip
    // in the standard comparison reader; valid one-byte bundle delimiters stay.
    if raw_packet.is_empty() {
        return Ok(());
    }
    let batch = ecs
        .get_mut::<RawConnection>(entity)
        .unwrap()
        .collect_incoming_packet(raw_packet);
    match batch {
        Ok(IncomingPacketBatch::Pending) => return Ok(()),
        Ok(IncomingPacketBatch::Complete(packets)) => {
            let mut first_error = None;
            for packet in packets {
                if let Err(error) =
                    handle_single_raw_packet(ecs, &packet, entity, state, queued_packet_events)
                {
                    first_error.get_or_insert(error);
                }
            }
            return first_error.map_or(Ok(()), Err);
        }
        Ok(IncomingPacketBatch::Single) => {}
        Err(error) => {
            let reason = format!("Java: ungültiges Paket-Bundle: {error}");
            ecs.get_mut::<RawConnection>(entity).unwrap().is_alive = false;
            ecs.write_message(crate::disconnect::DisconnectEvent {
                entity,
                reason: Some(reason.clone().into()),
            });
            return Err(Box::new(ReadPacketError::IoError {
                source: io::Error::new(io::ErrorKind::InvalidData, reason),
            }));
        }
    }
    handle_single_raw_packet(ecs, raw_packet, entity, state, queued_packet_events)
}

fn handle_single_raw_packet(
    ecs: &mut World,
    raw_packet: &[u8],
    entity: Entity,
    state: ConnectionProtocol,
    queued_packet_events: &mut QueuedPacketEvents,
) -> Result<(), Box<ReadPacketError>> {
    let stream = &mut Cursor::new(raw_packet);
    match state {
        ConnectionProtocol::Handshake => {
            unreachable!()
        }
        ConnectionProtocol::Game => {
            let packet = Arc::new(deserialize_packet::<ClientboundGamePacket>(stream)?);
            trace!("Packet: {packet:?}");
            game::process_packet(ecs, entity, packet.as_ref());
            queued_packet_events
                .game
                .push(ReceiveGamePacketEvent { entity, packet });
        }
        ConnectionProtocol::Status => {
            unreachable!()
        }
        ConnectionProtocol::Login => {
            let packet = Arc::new(deserialize_packet::<ClientboundLoginPacket>(stream)?);
            trace!("Packet: {packet:?}");
            login::process_packet(ecs, entity, &packet);
            queued_packet_events
                .login
                .push(ReceiveLoginPacketEvent { entity, packet });
        }
        ConnectionProtocol::Configuration => {
            let packet = Arc::new(deserialize_packet::<ClientboundConfigPacket>(stream)?);
            trace!("Packet: {packet:?}");
            config::process_packet(ecs, entity, &packet);
            queued_packet_events
                .config
                .push(ReceiveConfigPacketEvent { entity, packet });
        }
    };

    Ok(())
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NetworkDiagnostics {
    pub buffered_bytes: usize,
    pub read_buffer_bytes: usize,
    pub completed_bundles: u64,
    pub pending_bundle_packets: Option<usize>,
    pub bundle: IncomingBundleDiagnostics,
    pub packets_enqueued: u64,
    pub packets_written: u64,
    pub keepalives_enqueued: u64,
    pub keepalives_written: u64,
    pub pongs_enqueued: u64,
    pub pongs_written: u64,
    pub last_keepalive_write_ms: Option<u64>,
    pub max_keepalive_write_ms: u64,
    pub last_pong_write_ms: Option<u64>,
    pub max_pong_write_ms: u64,
    pub writer_error: Option<NetworkWriteError>,
}

#[derive(Clone, Copy, Debug)]
pub struct NetworkWriteError {
    pub kind: io::ErrorKind,
    pub os_code: Option<i32>,
    pub packet_name: &'static str,
    pub queued_ms: u64,
}

impl fmt::Display for NetworkWriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Paket {}: {:?}", self.packet_name, self.kind)?;
        if let Some(code) = self.os_code {
            write!(f, " ({})", io::Error::from_raw_os_error(code))?;
        }
        write!(f, "; seit Einreihung {}ms", self.queued_ms)?;
        Ok(())
    }
}

#[derive(Default)]
struct WriteStatistics {
    packets_enqueued: AtomicU64,
    packets_written: AtomicU64,
    keepalives_enqueued: AtomicU64,
    keepalives_written: AtomicU64,
    pongs_enqueued: AtomicU64,
    pongs_written: AtomicU64,
    last_keepalive_write_ms: AtomicU64,
    max_keepalive_write_ms: AtomicU64,
    last_pong_write_ms: AtomicU64,
    max_pong_write_ms: AtomicU64,
    writer_error: parking_lot::Mutex<Option<NetworkWriteError>>,
}

struct PendingNetworkPacket {
    bytes: Box<[u8]>,
    packet_name: &'static str,
    enqueued_at: Instant,
}

pub struct NetworkConnection {
    reader: RawReadConnection,
    // compression threshold is in the RawReadConnection
    pub enc_cipher: Option<Aes128CfbEnc>,

    pub writer_task: bevy_tasks::Task<()>,
    /// A queue of raw TCP packets to send.
    ///
    /// These will not be modified further, they should already be serialized
    /// and compressed and encrypted before being added here.
    network_packet_writer_tx: mpsc::UnboundedSender<PendingNetworkPacket>,
    write_statistics: Arc<WriteStatistics>,
    writer_finished: bool,
}
impl NetworkConnection {
    /// Read at most one already available packet without blocking.
    /// Exposed for the AFK client's bounded reader; compression and encryption
    /// remain handled by the upstream RawReadConnection.
    pub fn try_read(&mut self) -> Result<Option<Box<[u8]>>, Box<ReadPacketError>> {
        // Upstream clears this buffer only when a frame ends exactly at its
        // end. Continuous TCP fragmentation can leave a partial next frame
        // behind indefinitely, retaining every already consumed byte. Reclaim
        // that prefix periodically while preserving the decrypted unread tail.
        let consumed = self.reader.buffer.position() as usize;
        if consumed >= 64 * 1024 {
            self.reader.buffer.get_mut().drain(..consumed);
            self.reader.buffer.set_position(0);
        }
        self.reader.try_read()
    }

    pub fn write<P: ProtocolPacket + Debug>(
        &mut self,
        packet: impl Packet<P>,
    ) -> Result<(), WritePacketError> {
        let packet = packet.into_variant();
        let raw_packet = serialize_packet(&packet)?;
        self.enqueue_raw(&raw_packet, packet.name())?;

        Ok(())
    }

    pub fn write_raw(&mut self, raw_packet: &[u8]) -> Result<(), WritePacketError> {
        self.enqueue_raw(raw_packet, "raw")
    }

    fn enqueue_raw(&mut self, raw_packet: &[u8], packet_name: &'static str) -> Result<(), WritePacketError> {
        let network_packet = azalea_protocol::write::encode_to_network_packet(
            raw_packet,
            self.reader.compression_threshold,
            &mut self.enc_cipher,
        );
        self.network_packet_writer_tx
            .send(PendingNetworkPacket {
                bytes: network_packet.into_boxed_slice(),
                packet_name,
                enqueued_at: Instant::now(),
            })
            .map_err(|error| mpsc::error::SendError(error.0.bytes))?;
        self.write_statistics.packets_enqueued.fetch_add(1, atomic::Ordering::Relaxed);
        if packet_name == "keep_alive" {
            self.write_statistics
                .keepalives_enqueued
                .fetch_add(1, atomic::Ordering::Relaxed);
        }
        if packet_name == "pong" {
            self.write_statistics
                .pongs_enqueued
                .fetch_add(1, atomic::Ordering::Relaxed);
        }
        Ok(())
    }

    fn diagnostics(&self) -> NetworkDiagnostics {
        let stats = &self.write_statistics;
        NetworkDiagnostics {
            buffered_bytes: self.reader.buffer.get_ref().len()
                .saturating_sub(self.reader.buffer.position() as usize),
            read_buffer_bytes: self.reader.buffer.get_ref().len(),
            completed_bundles: 0,
            pending_bundle_packets: None,
            bundle: IncomingBundleDiagnostics::default(),
            packets_enqueued: stats.packets_enqueued.load(atomic::Ordering::Relaxed),
            packets_written: stats.packets_written.load(atomic::Ordering::Relaxed),
            keepalives_enqueued: stats.keepalives_enqueued.load(atomic::Ordering::Relaxed),
            keepalives_written: stats.keepalives_written.load(atomic::Ordering::Relaxed),
            pongs_enqueued: stats.pongs_enqueued.load(atomic::Ordering::Relaxed),
            pongs_written: stats.pongs_written.load(atomic::Ordering::Relaxed),
            last_keepalive_write_ms: (stats.keepalives_written.load(atomic::Ordering::Relaxed) > 0)
                .then(|| {
                    stats
                        .last_keepalive_write_ms
                        .load(atomic::Ordering::Relaxed)
                }),
            max_keepalive_write_ms: stats.max_keepalive_write_ms.load(atomic::Ordering::Relaxed),
            last_pong_write_ms: (stats.pongs_written.load(atomic::Ordering::Relaxed) > 0)
                .then(|| stats.last_pong_write_ms.load(atomic::Ordering::Relaxed)),
            max_pong_write_ms: stats.max_pong_write_ms.load(atomic::Ordering::Relaxed),
            writer_error: *stats.writer_error.lock(),
        }
    }

    /// Makes sure packets get sent and returns Some(()) if the connection has
    /// closed.
    pub fn poll_writer(&mut self) -> Option<()> {
        if self.writer_finished {
            return Some(());
        }
        let poll_once_res = future::poll_once(&mut self.writer_task);
        let finished = future::block_on(poll_once_res);
        self.writer_finished = finished.is_some();
        finished
    }

    pub fn set_compression_threshold(&mut self, threshold: Option<u32>) {
        trace!("Set compression threshold to {threshold:?}");
        self.reader.compression_threshold = threshold;
    }
    /// Set the encryption key that is used to encrypt and decrypt packets.
    ///
    /// The same key is used for both reading and writing.
    pub fn set_encryption_key(&mut self, key: [u8; 16]) {
        trace!("Enabled protocol encryption");
        let (enc_cipher, dec_cipher) = azalea_crypto::create_cipher(&key);
        self.reader.dec_cipher = Some(dec_cipher);
        self.enc_cipher = Some(enc_cipher);
    }
}

async fn write_task(
    mut network_packet_writer_rx: mpsc::UnboundedReceiver<PendingNetworkPacket>,
    mut write_half: OwnedWriteHalf,
    statistics: Arc<WriteStatistics>,
) {
    while let Some(network_packet) = network_packet_writer_rx.recv().await {
        if let Err(e) = write_half.write_all(&network_packet.bytes).await {
            *statistics.writer_error.lock() = Some(NetworkWriteError {
                kind: e.kind(),
                os_code: e.raw_os_error(),
                packet_name: network_packet.packet_name,
                queued_ms: network_packet.enqueued_at.elapsed().as_millis() as u64,
            });
            debug!("Error writing packet to server: {e}");
            break;
        };
        statistics.packets_written.fetch_add(1, atomic::Ordering::Relaxed);
        if network_packet.packet_name == "keep_alive" {
            let elapsed = network_packet.enqueued_at.elapsed().as_millis() as u64;
            statistics
                .last_keepalive_write_ms
                .store(elapsed, atomic::Ordering::Relaxed);
            statistics
                .max_keepalive_write_ms
                .fetch_max(elapsed, atomic::Ordering::Relaxed);
            statistics
                .keepalives_written
                .fetch_add(1, atomic::Ordering::Relaxed);
        }
        if network_packet.packet_name == "pong" {
            let elapsed = network_packet.enqueued_at.elapsed().as_millis() as u64;
            statistics
                .last_pong_write_ms
                .store(elapsed, atomic::Ordering::Relaxed);
            statistics
                .max_pong_write_ms
                .fetch_max(elapsed, atomic::Ordering::Relaxed);
            statistics
                .pongs_written
                .fetch_add(1, atomic::Ordering::Relaxed);
        }
    }

    trace!("write task is done");
}

#[derive(Debug, Error)]
pub enum WritePacketError {
    #[error("Wrong protocol state: expected {expected:?}, got {got:?}")]
    WrongState {
        expected: ConnectionProtocol,
        got: ConnectionProtocol,
    },
    #[error(transparent)]
    Encoding(#[from] azalea_protocol::write::PacketEncodeError),
    #[error(transparent)]
    SendError {
        #[from]
        #[backtrace]
        source: mpsc::error::SendError<Box<[u8]>>,
    },
}
