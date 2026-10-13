//! Bounded network work for a stationary AFK client.
//!
//! Azalea's default reader drains the socket until it is empty before running
//! ticks or flushing outgoing packets. Item farms can keep that reader busy.
//! Delegate protocol handling to the pinned Azalea version, but yield between
//! batches and omit dropped-item entities, which the server collects for us.

use std::collections::{HashSet, VecDeque};
use std::io::Cursor;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use azalea::app::{App, Plugin, PreUpdate};
use azalea::buf::AzBufVar;
use azalea::client_chat::ChatPacket;
use azalea::connection::{IncomingPacketBatch, NetworkDiagnostics, RawConnection};
use azalea::core::entity_id::MinecraftEntityId;
use azalea::disconnect::DisconnectEvent;
use azalea::ecs as bevy_ecs;
use azalea::ecs::prelude::*;
use azalea::packet::{config, game, login};
use azalea::protocol::packets::{
    config::ClientboundConfigPacket, game::ClientboundGamePacket, login::ClientboundLoginPacket,
    ConnectionProtocol, Packet, ProtocolPacket,
};
use azalea::protocol::read::{deserialize_packet, ReadPacketError};
use azalea::registry::builtin::EntityKind;

use crate::{emit, protocol::OutEvent};

const MAX_PACKETS_PER_UPDATE: usize = 256;
// Cosmetic packets do not consume the ECS packet quota. A farm can continuously
// send more than 256 * 60 packets/s; counting those would grow a permanent TCP
// backlog even though ticks and outgoing commands themselves remain responsive.
const MAX_SCANNED_PACKETS_PER_UPDATE: usize = 8192;
const READ_BUDGET: Duration = Duration::from_millis(4);
// A stopped writer does not imply that all incoming frames have been read.
// Keep the same bounded updates briefly to recover the server's kick reason.
const WRITER_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

// Derive IDs from the pinned protocol, rather than duplicating wire constants.
static FAST_ITEM_PACKET_IDS: LazyLock<Vec<u32>> = LazyLock::new(|| {
    use azalea::protocol::packets::game::*;
    let position = azalea::protocol::common::movements::PositionMoveRotation {
        pos: azalea::Vec3::ZERO,
        delta: azalea::Vec3::ZERO,
        look_direction: azalea::entity::LookDirection::new(0.0, 0.0),
    };
    vec![
        ClientboundSetEntityData {
            id: 0.into(),
            packed_items: azalea::entity::EntityMetadataItems(vec![]),
        }
        .into_variant()
        .id(),
        ClientboundSetEntityMotion {
            id: 0.into(),
            delta: Default::default(),
        }
        .into_variant()
        .id(),
        ClientboundMoveEntityPos {
            entity_id: 0.into(),
            delta: Default::default(),
            on_ground: false,
        }
        .into_variant()
        .id(),
        ClientboundMoveEntityPosRot {
            entity_id: 0.into(),
            delta: Default::default(),
            look_direction: Default::default(),
            on_ground: false,
        }
        .into_variant()
        .id(),
        ClientboundMoveEntityRot {
            entity_id: 0.into(),
            look_direction: Default::default(),
            on_ground: false,
        }
        .into_variant()
        .id(),
        ClientboundTakeItemEntity {
            item_id: 0,
            player_id: 0.into(),
            amount: 0,
        }
        .into_variant()
        .id(),
        ClientboundEntityPositionSync {
            id: 0.into(),
            values: position.clone(),
            on_ground: false,
        }
        .into_variant()
        .id(),
        ClientboundTeleportEntity {
            id: 0.into(),
            change: position,
            relative: Default::default(),
            on_ground: false,
        }
        .into_variant()
        .id(),
    ]
});

pub struct AfkNetworkPlugin;

impl Plugin for AfkNetworkPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PreUpdate, read_packets.after(azalea::events::init_listener));
    }
}

#[derive(Component, Default)]
struct ItemFilter {
    ignored: HashSet<MinecraftEntityId>,
    last_warning_at: Option<Instant>,
    empty_payloads: u64,
    last_received_at: Option<Instant>,
    keepalives_received: u64,
    last_keepalive_at: Option<Instant>,
    read_errors: u64,
    last_read_error: Option<String>,
    last_protocol: Option<ConnectionProtocol>,
    last_transport: Option<NetworkDiagnostics>,
    diagnostics_reported: bool,
    writer_failed_at: Option<Instant>,
    server_disconnect_received: bool,
    server_tooltip_text: Option<String>,
}

impl ItemFilter {
    /// Skip already-identified item visuals before decoding their metadata/NBT.
    /// Spawns, removals and world changes still take the ordered normal path.
    fn skip_raw(&self, raw: &[u8]) -> bool {
        let mut stream = Cursor::new(raw);
        let Ok(packet_id) = u32::azalea_read_var(&mut stream) else {
            return false;
        };
        if !FAST_ITEM_PACKET_IDS.contains(&packet_id) {
            return false;
        }
        let Ok(entity_id) = i32::azalea_read_var(&mut stream) else {
            return false;
        };
        self.ignored.contains(&MinecraftEntityId(entity_id))
    }

    /// Only dropped item visuals are omitted. Inventory/content packets and
    /// the player, mobs, boats, and other collidable entities stay untouched.
    fn keep(&mut self, packet: &mut ClientboundGamePacket) -> bool {
        match packet {
            ClientboundGamePacket::AddEntity(p) => {
                if p.entity_type == EntityKind::Item {
                    self.ignored.insert(p.id);
                    false
                } else {
                    // Servers can reuse an entity id without a removal packet.
                    self.ignored.remove(&p.id);
                    true
                }
            }
            ClientboundGamePacket::RemoveEntities(p) => {
                p.entity_ids.retain(|id| !self.ignored.remove(id));
                !p.entity_ids.is_empty()
            }
            ClientboundGamePacket::SetEntityData(p) => !self.ignored.contains(&p.id),
            ClientboundGamePacket::SetEntityMotion(p) => !self.ignored.contains(&p.id),
            ClientboundGamePacket::EntityPositionSync(p) => !self.ignored.contains(&p.id),
            ClientboundGamePacket::TeleportEntity(p) => !self.ignored.contains(&p.id),
            ClientboundGamePacket::MoveEntityPos(p) => !self.ignored.contains(&p.entity_id),
            ClientboundGamePacket::MoveEntityPosRot(p) => !self.ignored.contains(&p.entity_id),
            ClientboundGamePacket::MoveEntityRot(p) => !self.ignored.contains(&p.entity_id),
            ClientboundGamePacket::EntityEvent(p) => !self.ignored.contains(&p.entity_id),
            ClientboundGamePacket::TakeItemEntity(p) => {
                !self.ignored.contains(&MinecraftEntityId(p.item_id as i32))
            }
            ClientboundGamePacket::Login(_)
            | ClientboundGamePacket::Respawn(_)
            | ClientboundGamePacket::StartConfiguration(_) => {
                self.ignored.clear();
                true
            }
            _ => true,
        }
    }

    fn warn(&mut self, message: String) {
        self.record_error(&message);
        let now = Instant::now();
        if self
            .last_warning_at
            .is_none_or(|at| now.duration_since(at) >= Duration::from_secs(30))
        {
            self.last_warning_at = Some(now);
            emit(&OutEvent::Warning { message });
        }
    }

    fn record_error(&mut self, message: &str) {
        self.read_errors = self.read_errors.saturating_add(1);
        self.last_read_error = Some(message.chars().take(240).collect());
    }
}

pub(crate) fn is_failed_server_message(sender: Option<&str>, message: &str) -> bool {
    static FORMATTING: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new("(?i)§[0-9a-u]").unwrap()
    });
    static MESSAGE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)^\s*Verbindung\s+zum\s+vorherigen\s+Server\s+verloren\s*[–—-]\s*du\s+wurdest\s+auf\s+einen\s+anderen\s+Server\s+verschoben[.!]?\s*$").unwrap()
    });
    if sender.is_some_and(|sender| {
        !FORMATTING.replace_all(sender, "").replace('§', "").eq_ignore_ascii_case("HugoSMP")
    }) {
        return false;
    }
    MESSAGE.is_match(&FORMATTING.replace_all(message, "").replace('§', ""))
}

fn diagnostics_message(ecs: &World, entity: Entity, filter: &ItemFilter) -> String {
    let age = |at: Option<Instant>| {
        at.map_or_else(
            || "unbekannt".to_owned(),
            |at| format!("{}s", at.elapsed().as_secs()),
        )
    };
    let transport = ecs
        .get::<RawConnection>(entity)
        .and_then(RawConnection::network_diagnostics)
        .or(filter.last_transport);
    let writes = transport.map_or_else(
        || "TCP-Schreibdaten unbekannt".to_owned(),
        |stats| format!(
            "Keepalive eingereiht {}, an TCP übergeben {}; Schreibqueue {} Pakete; Lesepuffer {} Bytes (gesamt {} Bytes); Bundles vollständig {}, offen {}{}",
            stats.keepalives_enqueued,
            stats.keepalives_written,
            stats.packets_enqueued.saturating_sub(stats.packets_written),
            stats.buffered_bytes,
            stats.read_buffer_bytes,
            stats.completed_bundles,
            stats.pending_bundle_packets.map_or_else(|| "keines".into(), |count| format!("{count} Pakete")),
            stats.writer_error.map_or_else(String::new, |error| format!("; TCP-Schreibfehler: {error}")),
        ),
    );
    format!(
        "AFK-Verbindungsdiagnose: Status {:?}; Keepalive erhalten {}, letzter vor {}; letzte Daten vor {}; {writes}; leere Pakete {}; Lesefehler {}{}{}",
        filter.last_protocol, filter.keepalives_received, age(filter.last_keepalive_at),
        age(filter.last_received_at), filter.empty_payloads, filter.read_errors,
        filter.last_read_error.as_ref().map_or_else(String::new, |error| format!("; letzter Fehler: {error}")),
        filter.server_tooltip_text.as_ref().map_or_else(String::new, |text| format!("; Server-Tooltip: {text}")),
    )
}

/// Emit once at a reported failure, preserving the last transport snapshot even
/// after the socket has been removed. TCP writes are not server acknowledgements.
pub(crate) fn report_network_diagnostics(bot: &azalea::Client) {
    let mut ecs = bot.ecs.write();
    let Some(filter) = ecs.get::<ItemFilter>(bot.entity) else {
        return;
    };
    if filter.diagnostics_reported {
        return;
    }
    let message = diagnostics_message(&ecs, bot.entity, filter);
    ecs.get_mut::<ItemFilter>(bot.entity).unwrap().diagnostics_reported = true;
    drop(ecs);
    emit(&OutEvent::BehaviorLog { message });
}

/// The bot handler needs only these raw packet callbacks. Chat, health,
/// keepalive, disconnect, resource packs and world loading are still processed
/// normally by Azalea and emit their own higher-level events.
fn needs_callback(packet: &ClientboundGamePacket) -> bool {
    matches!(
        packet,
        ClientboundGamePacket::OpenScreen(_)
            | ClientboundGamePacket::ContainerSetContent(_)
            | ClientboundGamePacket::Respawn(_)
            | ClientboundGamePacket::PlayerPosition(_)
    )
}

fn process_packet(
    ecs: &mut World,
    entity: Entity,
    raw: &[u8],
    filter: &mut ItemFilter,
) -> Result<bool, Box<ReadPacketError>> {
    let Some(mut connection) = ecs.get_mut::<RawConnection>(entity) else {
        return Ok(false);
    };
    filter.last_protocol = Some(connection.state);
    let batch = connection.collect_incoming_packet(raw);
    drop(connection);
    match batch {
        Ok(IncomingPacketBatch::Pending) => {
            filter.last_received_at = Some(Instant::now());
            if raw.is_empty() {
                filter.empty_payloads = filter.empty_payloads.saturating_add(1);
            }
            Ok(false)
        }
        Ok(IncomingPacketBatch::Single) => process_single_packet(ecs, entity, raw, filter),
        Ok(IncomingPacketBatch::Complete(packets)) => {
            // A complete bundle is one atomic unit. The update limits apply
            // between units, never between its world/inventory/correction packets.
            let mut applied = false;
            let mut first_error = None;
            for packet in packets {
                match process_single_packet(ecs, entity, &packet, filter) {
                    Ok(kept) => applied |= kept,
                    Err(error) => {
                        first_error.get_or_insert(error);
                    }
                }
            }
            first_error.map_or(Ok(applied), Err)
        }
        Err(error) => {
            let reason = format!("Java: ungültiges Paket-Bundle: {error}");
            filter.record_error(&reason);
            disconnect(ecs, entity, filter, reason);
            Ok(true)
        }
    }
}

fn process_single_packet(
    ecs: &mut World,
    entity: Entity,
    raw: &[u8],
    filter: &mut ItemFilter,
) -> Result<bool, Box<ReadPacketError>> {
    // Re-read the state for EACH packet. Login, compression and configuration
    // transitions in one incoming batch must affect all subsequent packets.
    let Some(connection) = ecs.get::<RawConnection>(entity) else {
        return Ok(false);
    };
    let state = connection.state;
    filter.last_protocol = Some(state);
    filter.last_received_at = Some(Instant::now());
    // A zero-byte framed/decompressed payload has no packet ID. It is not a
    // bundle delimiter (that is the valid one-byte packet [0]). Dropping this
    // frame silently leaves the next frame aligned; no user action is needed.
    if raw.is_empty() {
        filter.empty_payloads = filter.empty_payloads.saturating_add(1);
        return Ok(false);
    }
    let stream = &mut Cursor::new(raw);
    match state {
        ConnectionProtocol::Game => {
            if filter.skip_raw(raw) {
                return Ok(false);
            }
            let mut packet = deserialize_packet::<ClientboundGamePacket>(stream)?;
            if !filter.keep(&mut packet) {
                return Ok(false);
            }
            if matches!(&packet, ClientboundGamePacket::KeepAlive(_)) {
                filter.keepalives_received = filter.keepalives_received.saturating_add(1);
                filter.last_keepalive_at = Some(Instant::now());
            }
            filter.server_disconnect_received |=
                matches!(&packet, ClientboundGamePacket::Disconnect(_));
            let failed_server = match &packet {
                ClientboundGamePacket::SystemChat(chat) => {
                    let (sender, message) = ChatPacket::System(Arc::new(chat.clone()))
                        .split_sender_and_content();
                    is_failed_server_message(sender.as_deref(), &message)
                }
                ClientboundGamePacket::DisguisedChat(chat) => {
                    is_failed_server_message(
                        Some(&chat.chat_type.name.to_string()), &chat.message.to_string(),
                    )
                }
                _ => false,
            };
            if failed_server || matches!(&packet, ClientboundGamePacket::Disconnect(_)) {
                filter.server_tooltip_text = Some(crate::server_message_details::packet_tooltip(raw));
            }
            if failed_server && !filter.diagnostics_reported {
                // Capture the old server's state before later packets in
                // this batch can configure or spawn the fallback world.
                emit(&OutEvent::BehaviorLog {
                    message: diagnostics_message(ecs, entity, filter),
                });
                filter.diagnostics_reported = true;
            }
            let callback = needs_callback(&packet);
            game::process_packet(ecs, entity, &packet);
            if callback {
                // ContainerPlugin also consumes content events; preserve those.
                ecs.write_message(game::ReceiveGamePacketEvent {
                    entity,
                    packet: Arc::new(packet),
                });
            }
        }
        ConnectionProtocol::Login => {
            filter.ignored.clear();
            let packet = Arc::new(deserialize_packet::<ClientboundLoginPacket>(stream)?);
            filter.server_disconnect_received |=
                matches!(&*packet, ClientboundLoginPacket::LoginDisconnect(_));
            login::process_packet(ecs, entity, &packet);
            ecs.write_message(login::ReceiveLoginPacketEvent { entity, packet });
        }
        ConnectionProtocol::Configuration => {
            filter.ignored.clear();
            let packet = Arc::new(deserialize_packet::<ClientboundConfigPacket>(stream)?);
            filter.server_disconnect_received |=
                matches!(&*packet, ClientboundConfigPacket::Disconnect(_));
            if filter.server_disconnect_received {
                filter.server_tooltip_text = Some(crate::server_message_details::packet_tooltip(raw));
            }
            if matches!(&*packet, ClientboundConfigPacket::KeepAlive(_)) {
                filter.keepalives_received = filter.keepalives_received.saturating_add(1);
                filter.last_keepalive_at = Some(Instant::now());
            }
            config::process_packet(ecs, entity, &packet);
            ecs.write_message(config::ReceiveConfigPacketEvent { entity, packet });
        }
        ConnectionProtocol::Handshake | ConnectionProtocol::Status => {
            unreachable!("AFK reader before login")
        }
    }
    Ok(true)
}

fn transport_failure_reason(
    ecs: &World,
    entity: Entity,
    filter: &ItemFilter,
    fallback: String,
) -> String {
    ecs.get::<RawConnection>(entity)
        .and_then(RawConnection::network_diagnostics)
        .or(filter.last_transport)
        .and_then(|stats| stats.writer_error)
        .map_or(fallback, |error| format!("TCP-Schreibfehler: {error}"))
}

fn disconnect(ecs: &mut World, entity: Entity, filter: &mut ItemFilter, reason: String) {
    if let Some(stats) = ecs
        .get::<RawConnection>(entity)
        .and_then(RawConnection::network_diagnostics)
    {
        filter.last_transport = Some(stats);
    }
    // Removing the connection drops its writer/stream, and the standard
    // DisconnectPlugin cleans up player/world components and emits Event::Disconnect.
    ecs.entity_mut(entity).remove::<RawConnection>();
    ecs.write_message(DisconnectEvent {
        entity,
        reason: Some(reason.into()),
    });
}

fn read_packets(ecs: &mut World) {
    let entities: Vec<_> = ecs
        .query_filtered::<Entity, With<RawConnection>>()
        .iter(ecs)
        .collect();
    for entity in entities {
        let mut filter = ecs
            .entity_mut(entity)
            .take::<ItemFilter>()
            .unwrap_or_default();
        let mut injected: VecDeque<_> = std::mem::take(
            &mut ecs
                .get_mut::<RawConnection>(entity)
                .unwrap()
                .injected_clientbound_packets,
        )
        .into();
        let started = Instant::now();
        let mut applied = 0;
        for _ in 0..MAX_SCANNED_PACKETS_PER_UPDATE {
            if applied >= MAX_PACKETS_PER_UPDATE
                || started.elapsed() >= READ_BUDGET
                || filter.server_disconnect_received
            {
                break;
            }
            let Some(mut connection) = ecs.get_mut::<RawConnection>(entity) else {
                break;
            };
            let read = if let Some(raw) = injected.pop_front() {
                Ok(Some(raw))
            } else if let Some(network) = connection.net_conn() {
                network.try_read()
            } else {
                break;
            };
            drop(connection);
            match read {
                Ok(Some(raw)) => match process_packet(ecs, entity, &raw, &mut filter) {
                    Ok(true) => applied += 1,
                    Ok(false) => {}
                    Err(error) => {
                        applied += 1;
                        let detail = match &*error {
                            ReadPacketError::ReadPacketId { source } => format!("{source:?}"),
                            _ => error.to_string(),
                        };
                        filter.warn(format!(
                            "AFK: ungültiges Serverpaket ({} Bytes, Status {:?}): {detail}",
                            raw.len(),
                            ecs.get::<RawConnection>(entity).map(|c| c.state)
                        ));
                    }
                },
                Ok(None) => break,
                Err(error) => {
                    let closed = matches!(
                        *error,
                        ReadPacketError::IoError { .. } | ReadPacketError::ConnectionClosed
                    );
                    if !closed {
                        filter.warn(format!(
                            "AFK: Fehler beim Lesen eines Serverpakets: {error}"
                        ));
                    }
                    if closed {
                        filter.record_error(&error.to_string());
                        let reason = transport_failure_reason(
                            ecs, entity, &filter, format!("TCP-Lesefehler: {error}"),
                        );
                        disconnect(ecs, entity, &mut filter, reason);
                    }
                    break;
                }
            }
        }
        if let Some(mut connection) = ecs.get_mut::<RawConnection>(entity) {
            // Preserve order and unread data when yielding. Poll the writer even
            // if incoming packets are still waiting: commands must get out.
            connection.injected_clientbound_packets = injected.into();
            let writer_closed = !filter.server_disconnect_received
                && connection
                    .net_conn()
                    .is_some_and(|network| network.poll_writer().is_some());
            filter.last_transport = connection.network_diagnostics();
            drop(connection);
            if writer_closed {
                let reason = transport_failure_reason(
                    ecs, entity, &filter, "TCP-Schreiber beendet".into(),
                );
                if filter.writer_failed_at.is_none() {
                    filter.writer_failed_at = Some(Instant::now());
                    filter.record_error(&reason);
                }
                if filter.writer_failed_at.is_some_and(|at| at.elapsed() >= WRITER_DRAIN_TIMEOUT) {
                    disconnect(ecs, entity, &mut filter, reason);
                }
            }
        }
        ecs.entity_mut(entity).insert(filter);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use azalea::entity::{inventory::Inventory, EntityKindComponent};
    use azalea::protocol::packets::{game::*, Packet};
    use azalea::registry::builtin::ItemKind;
    use azalea::test_utils::simulation::{
        default_login_packet, make_basic_add_entity, SentPackets, Simulation,
    };
    use azalea::world::WorldName;
    use azalea::InConfigState;
    use azalea_inventory::ItemStack;

    fn simulation() -> Simulation {
        simulation_with_mode(crate::protocol::JavaNetworkMode::Optimized)
    }

    fn simulation_with_mode(mode: crate::protocol::JavaNetworkMode) -> Simulation {
        let mut simulation = Simulation::new_with_plugins(
            ConnectionProtocol::Game,
            crate::network_mode::client_plugins(mode),
        );
        simulation.receive_packet(default_login_packet());
        simulation.tick();
        simulation
    }

    fn item_metadata(id: i32) -> ClientboundSetEntityData {
        ClientboundSetEntityData {
            id: id.into(),
            packed_items: azalea::entity::EntityMetadataItems(vec![
                azalea::entity::EntityDataItem {
                    index: 8,
                    value: azalea::entity::EntityDataValue::ItemStack(ItemStack::new(
                        ItemKind::Beef,
                        64,
                    )),
                },
            ]),
        }
    }

    #[test]
    fn proxy_login_and_respawn_each_require_a_fresh_player_loaded_acknowledgement() {
        use azalea::entity::{HasClientLoaded, InLoadedChunk};
        use azalea::loading::player_loaded_packet;
        let mut sim = simulation();
        let sent = SentPackets::new(&mut sim);
        let entity = sim.entity;
        let common = default_login_packet().common;
        let transitions = [
            default_login_packet().into_variant(),
            azalea::test_utils::simulation::make_basic_respawn_packet(
                common.dimension_type,
                common.dimension,
            )
            .into_variant(),
            default_login_packet().into_variant(),
        ];
        for transition in transitions {
            sim.app
                .world_mut()
                .entity_mut(entity)
                .insert((HasClientLoaded, InLoadedChunk));
            game::process_packet(sim.app.world_mut(), entity, &transition);
            assert!(sim.app.world().get::<HasClientLoaded>(entity).is_none());
            assert!(sim.app.world().get::<InLoadedChunk>(entity).is_none());
            let mut schedule = Schedule::default();
            schedule.add_systems(player_loaded_packet);
            schedule.run(sim.app.world_mut());
            assert!(
                sent.next().is_none(),
                "do not acknowledge an unloaded destination"
            );
            sim.app.world_mut().entity_mut(entity).insert(InLoadedChunk);
            schedule.run(sim.app.world_mut());
            schedule.run(sim.app.world_mut());
            let mut packets = Vec::new();
            while let Some(packet) = sent.next() {
                packets.push(packet);
            }
            assert_eq!(
                packets
                    .iter()
                    .filter(|p| matches!(p, ServerboundGamePacket::PlayerLoaded(_)))
                    .count(),
                1
            );
        }
    }

    #[test]
    fn empty_frames_do_not_break_the_next_inventory_packet_or_bundle_delimiter() {
        let mut sim = simulation();
        for _ in 0..20 {
            sim.app
                .world_mut()
                .get_mut::<RawConnection>(sim.entity)
                .unwrap()
                .injected_clientbound_packets
                .push(Vec::new().into_boxed_slice());
        }
        sim.receive_packet(ClientboundBundleDelimiter);
        sim.receive_packet(ClientboundContainerSetSlot {
            container_id: 0,
            state_id: 5,
            slot: 9,
            item_stack: ItemStack::new(ItemKind::Beef, 64),
        });
        sim.receive_packet(ClientboundBundleDelimiter);
        sim.tick();
        let filter = sim.app.world().get::<ItemFilter>(sim.entity).unwrap();
        assert_eq!(filter.empty_payloads, 20);
        assert!(filter.last_warning_at.is_none());
        assert_eq!(
            sim.app
                .world()
                .get::<Inventory>(sim.entity)
                .unwrap()
                .inventory_menu
                .slot(9)
                .unwrap()
                .count(),
            64
        );
    }

    #[test]
    fn empty_frames_preserve_server_replies_over_fragmented_compressed_encrypted_tcp() {
        use azalea::protocol::connect::{Connection, RawReadConnection, RawWriteConnection};
        use azalea::protocol::write::{encode_to_network_packet, serialize_packet};
        use tokio::io::AsyncWriteExt;
        use tokio::net::{TcpListener, TcpStream};

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for mode in [
            crate::protocol::JavaNetworkMode::Optimized,
            crate::protocol::JavaNetworkMode::Standard,
        ] {
            for threshold in [None, Some(1), Some(64)] {
                for encrypted in [false, true] {
                    let mut sim = simulation_with_mode(mode);
                    runtime.block_on(async {
                        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                        let (socket, accepted) = tokio::join!(
                            TcpStream::connect(listener.local_addr().unwrap()),
                            listener.accept(),
                        );
                        let socket = socket.unwrap();
                        let (server, _) = accepted.unwrap();
                        socket.set_nodelay(true).unwrap();
                        server.set_nodelay(true).unwrap();
                        let mut server = Connection::new_from_stream(server).await.unwrap().login();
                        if let Some(threshold) = threshold {
                            server.set_compression_threshold(threshold as i32);
                        }
                        let (read_stream, write_stream) = socket.into_split();
                        let mut connection = RawConnection::new(
                            RawReadConnection {
                                read_stream,
                                buffer: Cursor::new(Vec::new()),
                                compression_threshold: threshold,
                                dec_cipher: None,
                            },
                            RawWriteConnection {
                                write_stream,
                                compression_threshold: threshold,
                                enc_cipher: None,
                            },
                            ConnectionProtocol::Game,
                        );
                        if encrypted {
                            let key = *b"1234567890123456";
                            server.set_encryption_key(key);
                            connection.net_conn().unwrap().set_encryption_key(key);
                        }
                        sim.app
                            .world_mut()
                            .entity_mut(sim.entity)
                            .insert(connection);
                        let packets: [ClientboundGamePacket; 9] = [
                            ClientboundKeepAlive { id: 42 }.into_variant(),
                            ClientboundPing { id: 44 }.into_variant(),
                            ClientboundPlayerPosition {
                                id: 45,
                                change: azalea::protocol::common::movements::PositionMoveRotation {
                                    pos: azalea::Vec3::ZERO,
                                    delta: azalea::Vec3::ZERO,
                                    look_direction: azalea::entity::LookDirection::new(0.0, 0.0),
                                },
                                relative: Default::default(),
                            }
                            .into_variant(),
                            ClientboundChunkBatchStart.into_variant(),
                            ClientboundChunkBatchFinished { batch_size: 1 }.into_variant(),
                            ClientboundBundleDelimiter.into_variant(),
                            ClientboundContainerSetSlot {
                                container_id: 0,
                                state_id: 7,
                                slot: 9,
                                item_stack: ItemStack::new(ItemKind::Beef, 64),
                            }
                            .into_variant(),
                            ClientboundBundleDelimiter.into_variant(),
                            ClientboundKeepAlive { id: 43 }.into_variant(),
                        ];
                        let mut bytes = Vec::new();
                        let mut bundle_close_offset = 0;
                        for (index, packet) in packets.iter().enumerate() {
                            if index == 7 {
                                bundle_close_offset = bytes.len();
                            }
                            bytes.extend(encode_to_network_packet(
                                &[],
                                threshold,
                                &mut server.writer.raw.enc_cipher,
                            ));
                            bytes.extend(encode_to_network_packet(
                                &serialize_packet(packet).unwrap(),
                                threshold,
                                &mut server.writer.raw.enc_cipher,
                            ));
                        }
                        // Force the client to retain incomplete lengths, encrypted
                        // frames and zlib streams across separate socket reads.
                        for (offset, byte) in bytes.into_iter().enumerate() {
                            server
                                .writer
                                .raw
                                .write_stream
                                .write_all(&[byte])
                                .await
                                .unwrap();
                            tokio::time::sleep(Duration::from_millis(1)).await;
                            sim.tick();
                            if offset < bundle_close_offset {
                                assert_eq!(
                                    sim.component::<Inventory>().inventory_menu.slot(9).unwrap().count(),
                                    0,
                                    "partial bundle became visible over TCP: {mode:?}, {threshold:?}, encrypted={encrypted}"
                                );
                            }
                        }
                        for _ in 0..10 {
                            tokio::time::sleep(Duration::from_millis(1)).await;
                            sim.tick();
                        }
                        let replies = tokio::time::timeout(Duration::from_secs(3), async {
                            let mut keepalives = Vec::new();
                            let mut pongs = Vec::new();
                            let mut teleports = Vec::new();
                            let mut batches = 0;
                            while keepalives.len() + pongs.len() + teleports.len() + batches < 5 {
                                let raw = server.reader.raw.read().await.unwrap();
                                let packet: ServerboundGamePacket =
                                    deserialize_packet(&mut Cursor::new(raw.as_ref())).unwrap();
                                match packet {
                                    ServerboundGamePacket::KeepAlive(p) => keepalives.push(p.id),
                                    ServerboundGamePacket::Pong(p) => pongs.push(p.id),
                                    ServerboundGamePacket::AcceptTeleportation(p) => {
                                        teleports.push(p.id)
                                    }
                                    ServerboundGamePacket::ChunkBatchReceived(_) => batches += 1,
                                    _ => {}
                                }
                            }
                            (keepalives, pongs, teleports, batches)
                        })
                        .await
                        .expect("empty frames must not prevent required server replies");
                        assert_eq!(
                            replies,
                            (vec![42, 43], vec![44], vec![45], 1),
                            "threshold={threshold:?}, encrypted={encrypted}"
                        );
                        if mode == crate::protocol::JavaNetworkMode::Optimized {
                            let filter = sim.app.world().get::<ItemFilter>(sim.entity).unwrap();
                            assert_eq!(filter.empty_payloads, packets.len() as u64);
                            assert!(filter.last_warning_at.is_none());
                            assert_eq!(filter.keepalives_received, 2);
                            assert!(filter.last_keepalive_at.is_some());
                        }
                        let stats = sim
                            .app
                            .world()
                            .get::<RawConnection>(sim.entity)
                            .unwrap()
                            .network_diagnostics()
                            .unwrap();
                        assert_eq!(stats.keepalives_enqueued, 2);
                        assert_eq!(stats.keepalives_written, 2);
                        assert_eq!(stats.completed_bundles, 1);
                        assert_eq!(stats.pending_bundle_packets, None);
                        assert_eq!(
                            sim.app
                                .world()
                                .get::<Inventory>(sim.entity)
                                .unwrap()
                                .inventory_menu
                                .slot(9)
                                .unwrap()
                                .count(),
                            64
                        );
                        server.writer.raw.write_stream.shutdown().await.unwrap();
                        for _ in 0..50 {
                            tokio::time::sleep(Duration::from_millis(1)).await;
                            sim.tick();
                            if sim.app.world().get::<RawConnection>(sim.entity).is_none() {
                                break;
                            }
                        }
                        assert!(sim.app.world().get::<RawConnection>(sim.entity).is_none());
                        if mode == crate::protocol::JavaNetworkMode::Optimized {
                            let filter = sim.app.world().get::<ItemFilter>(sim.entity).unwrap();
                            assert_eq!(filter.last_transport.unwrap().keepalives_written, 2);
                            let diagnostic =
                                diagnostics_message(sim.app.world(), sim.entity, filter);
                            assert!(diagnostic.contains("Keepalive erhalten 2"));
                            assert!(diagnostic.contains("an TCP übergeben 2"));
                            assert_eq!(filter.read_errors, 1);
                        }
                    });
                }
            }
        }
    }

    #[test]
    fn continuous_fragmented_tcp_reclaims_consumed_read_buffer_bytes() {
        use azalea::protocol::connect::{Connection, RawReadConnection, RawWriteConnection};
        use azalea::protocol::write::{encode_to_network_packet, serialize_packet};
        use tokio::io::AsyncWriteExt;
        use tokio::net::{TcpListener, TcpStream};

        // Every write ends inside the next packet, so the buffer never becomes
        // completely empty. Retaining the consumed prefix would grow forever.
        const PACKETS: usize = 8192;
        const BATCH: usize = 256;
        const MAX_CONSUMED_BYTES: usize = 64 * 1024;
        let _sim = simulation(); // Initialize Azalea's I/O task pool.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all().build().unwrap();
        for threshold in [None, Some(1), Some(64)] {
            for encrypted in [false, true] {
                runtime.block_on(async {
                    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let (socket, accepted) = tokio::join!(
                        TcpStream::connect(listener.local_addr().unwrap()), listener.accept(),
                    );
                    let (server, _) = accepted.unwrap();
                    let mut server = Connection::new_from_stream(server).await.unwrap().login();
                    let (read_stream, write_stream) = socket.unwrap().into_split();
                    let mut connection = RawConnection::new(
                        RawReadConnection {
                            read_stream, buffer: Cursor::new(Vec::new()),
                            compression_threshold: threshold, dec_cipher: None,
                        },
                        RawWriteConnection {
                            write_stream, compression_threshold: threshold, enc_cipher: None,
                        },
                        ConnectionProtocol::Game,
                    );
                    if encrypted {
                        let key = *b"1234567890123456";
                        server.set_encryption_key(key);
                        connection.net_conn().unwrap().set_encryption_key(key);
                    }
                    let mut bytes = Vec::new();
                    let mut ends = Vec::new();
                    let mut lengths = Vec::new();
                    for id in 0..=PACKETS {
                        let frame = encode_to_network_packet(
                            &serialize_packet(&ClientboundKeepAlive { id: id as u64 }.into_variant()).unwrap(),
                            threshold, &mut server.writer.raw.enc_cipher,
                        );
                        lengths.push(frame.len());
                        bytes.extend(frame);
                        ends.push(bytes.len());
                    }
                    let mut sent = 0;
                    let mut received = 0;
                    for target in (BATCH..=PACKETS).step_by(BATCH) {
                        let end = ends[target] - 1;
                        server.writer.raw.write_stream.write_all(&bytes[sent..end]).await.unwrap();
                        sent = end;
                        let deadline = Instant::now() + Duration::from_secs(3);
                        loop {
                            assert!(Instant::now() < deadline, "fragmented TCP must make progress");
                            match connection.net_conn().unwrap().try_read().unwrap() {
                                Some(raw) => {
                                    let packet: ClientboundGamePacket =
                                        deserialize_packet(&mut Cursor::new(raw.as_ref())).unwrap();
                                    assert!(matches!(packet, ClientboundGamePacket::KeepAlive(p) if p.id == received as u64));
                                    received += 1;
                                }
                                None => {
                                    let stats = connection.network_diagnostics().unwrap();
                                    if received == target && stats.buffered_bytes == lengths[target] - 1 {
                                        assert!(stats.read_buffer_bytes <= MAX_CONSUMED_BYTES + lengths[target],
                                            "consumed TCP data retained: {} bytes, threshold={threshold:?}, encrypted={encrypted}", stats.read_buffer_bytes);
                                        break;
                                    }
                                    tokio::time::sleep(Duration::from_millis(1)).await;
                                }
                            }
                        }
                    }
                    // Complete the retained tail to verify compaction preserved
                    // its length prefix, payload and cipher position.
                    server.writer.raw.write_stream.write_all(&bytes[sent..]).await.unwrap();
                    tokio::time::timeout(Duration::from_secs(3), async {
                        loop {
                            if let Some(raw) = connection.net_conn().unwrap().try_read().unwrap() {
                                let packet: ClientboundGamePacket =
                                    deserialize_packet(&mut Cursor::new(raw.as_ref())).unwrap();
                                assert!(matches!(packet, ClientboundGamePacket::KeepAlive(p) if p.id == PACKETS as u64));
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(1)).await;
                        }
                    }).await.unwrap();
                });
            }
        }
    }

    #[test]
    fn finished_writer_does_not_discard_a_buffered_server_kick() {
        use azalea::protocol::connect::{RawReadConnection, RawWriteConnection};
        use azalea::protocol::write::{encode_to_network_packet, serialize_packet};
        use tokio::net::{TcpListener, TcpStream};

        let mut sim = simulation();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all().build().unwrap();
        runtime.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let (socket, accepted) = tokio::join!(
                TcpStream::connect(listener.local_addr().unwrap()), listener.accept(),
            );
            let (_server, _) = accepted.unwrap();
            let (read_stream, write_stream) = socket.unwrap().into_split();
            let mut bytes = Vec::new();
            for _ in 0..=MAX_PACKETS_PER_UPDATE {
                bytes.extend(encode_to_network_packet(
                    &serialize_packet(&ClientboundChunkBatchStart.into_variant()).unwrap(),
                    None, &mut None,
                ));
            }
            let kick = ClientboundDisconnect { reason: "actual server kick reason".into() };
            bytes.extend(encode_to_network_packet(
                &serialize_packet(&kick.into_variant()).unwrap(), None, &mut None,
            ));
            let mut connection = RawConnection::new(
                RawReadConnection {
                    read_stream, buffer: Cursor::new(bytes),
                    compression_threshold: None, dec_cipher: None,
                },
                RawWriteConnection { write_stream, compression_threshold: None, enc_cipher: None },
                ConnectionProtocol::Game,
            );
            // Deterministically end only the writer while the reader still has
            // more frames than the per-update quota, including the kick packet.
            connection.net_conn().unwrap().writer_task =
                azalea::bevy_tasks::IoTaskPool::get().spawn(async {});
            sim.app.world_mut().entity_mut(sim.entity).insert(connection);
            tokio::time::sleep(Duration::from_millis(10)).await;
            let mut reasons = Vec::new();
            for _ in 0..50 {
                sim.tick();
                reasons.extend(sim.app.world_mut().resource_mut::<Messages<DisconnectEvent>>()
                    .drain().map(|event| event.reason.map(|reason| reason.to_string())));
                if sim.app.world().get::<RawConnection>(sim.entity).is_none() { break; }
                let mut connection = sim.app.world_mut().get_mut::<RawConnection>(sim.entity).unwrap();
                let network = connection.net_conn().unwrap();
                assert_eq!(network.poll_writer(), Some(()));
                assert_eq!(network.poll_writer(), Some(()));
                drop(connection);
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            assert_eq!(reasons, vec![Some("actual server kick reason".into())]);
            assert!(sim.app.world().get::<RawConnection>(sim.entity).is_none());
        });
    }

    #[test]
    fn socket_write_error_is_retained_and_failed_writer_drain_is_bounded() {
        use azalea::protocol::connect::{RawReadConnection, RawWriteConnection};
        use tokio::io::AsyncWriteExt;
        use tokio::net::{TcpListener, TcpStream};

        let mut sim = simulation();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all().build().unwrap();
        runtime.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let (socket, accepted) = tokio::join!(
                TcpStream::connect(listener.local_addr().unwrap()), listener.accept(),
            );
            let (server, _) = accepted.unwrap();
            let (read_stream, mut write_stream) = socket.unwrap().into_split();
            // Fail a real socket write deterministically, while leaving its
            // reader and peer alive. There is no server kick packet to recover.
            write_stream.shutdown().await.unwrap();
            let mut connection = RawConnection::new(
                RawReadConnection {
                    read_stream, buffer: Cursor::new(Vec::new()),
                    compression_threshold: None, dec_cipher: None,
                },
                RawWriteConnection { write_stream, compression_threshold: None, enc_cipher: None },
                ConnectionProtocol::Game,
            );
            connection.write(ServerboundKeepAlive { id: 123 }).unwrap();
            tokio::time::timeout(Duration::from_secs(3), async {
                while connection.net_conn().unwrap().poll_writer().is_none() {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }).await.expect("a failed socket writer must finish");
            let stats = connection.network_diagnostics().unwrap();
            let error = stats.writer_error.expect("keep the actual I/O error");
            assert_eq!(error.packet_name, "keep_alive");
            assert_eq!(stats.keepalives_enqueued, 1);
            assert_eq!(stats.keepalives_written, 0);
            sim.app.world_mut().entity_mut(sim.entity).insert(connection);
            sim.tick();
            assert!(sim.app.world().get::<RawConnection>(sim.entity).is_some());
            assert!(sim.app.world_mut().resource_mut::<Messages<DisconnectEvent>>().drain().next().is_none());
            let mut filter = sim.app.world_mut().get_mut::<ItemFilter>(sim.entity).unwrap();
            assert!(filter.writer_failed_at.is_some());
            filter.writer_failed_at = Some(Instant::now() - WRITER_DRAIN_TIMEOUT - Duration::from_millis(1));
            drop(filter);
            sim.tick();
            assert!(sim.app.world().get::<RawConnection>(sim.entity).is_none());
            let reasons: Vec<_> = sim.app.world_mut().resource_mut::<Messages<DisconnectEvent>>()
                .drain().map(|event| event.reason.map(|reason| reason.to_string())).collect();
            assert_eq!(reasons, vec![Some(format!("TCP-Schreibfehler: {error}"))]);
            let filter = sim.app.world().get::<ItemFilter>(sim.entity).unwrap();
            assert!(diagnostics_message(sim.app.world(), sim.entity, filter).contains(&error.to_string()));
            drop(server);
        });
    }

    #[test]
    fn truncated_packet_id_is_diagnosed_without_losing_the_next_frame() {
        let mut sim = simulation();
        sim.app
            .world_mut()
            .get_mut::<RawConnection>(sim.entity)
            .unwrap()
            .injected_clientbound_packets
            .push(vec![0x80].into_boxed_slice());
        sim.receive_packet(ClientboundContainerSetSlot {
            container_id: 0,
            state_id: 6,
            slot: 9,
            item_stack: ItemStack::new(ItemKind::Beef, 32),
        });
        sim.tick();
        let filter = sim.app.world().get::<ItemFilter>(sim.entity).unwrap();
        assert_eq!(
            filter.empty_payloads, 0,
            "do not confuse an incomplete ID with an empty packet"
        );
        assert!(filter.last_warning_at.is_some());
        assert_eq!(
            sim.app
                .world()
                .get::<Inventory>(sim.entity)
                .unwrap()
                .inventory_menu
                .slot(9)
                .unwrap()
                .count(),
            32
        );
    }

    #[test]
    fn dense_item_packets_yield_and_preserve_inventory_updates_and_commands() {
        let mut simulation = simulation();
        let commands = SentPackets::new(&mut simulation);
        for id in 1..=10_000 {
            simulation.receive_packet(make_basic_add_entity(
                EntityKind::Item,
                id,
                azalea::Vec3::ZERO,
            ));
            simulation.receive_packet(item_metadata(id));
            simulation.receive_packet(ClientboundMoveEntityPos {
                entity_id: id.into(),
                delta: Default::default(),
                on_ground: true,
            });
            if id % 50 == 0 {
                // Picking up items is server-authoritative. These packets must
                // still arrive while all dropped entity visuals are omitted.
                simulation.receive_packet(ClientboundContainerSetSlot {
                    container_id: 0,
                    state_id: id as u32,
                    slot: 9,
                    item_stack: ItemStack::new(ItemKind::Beef, 32),
                });
            }
        }
        let started = Instant::now();
        simulation.tick();
        let remaining = simulation
            .app
            .world()
            .get::<RawConnection>(simulation.entity)
            .unwrap()
            .injected_clientbound_packets
            .len();
        assert!(
            remaining >= 30_200 - MAX_SCANNED_PACKETS_PER_UPDATE,
            "yield instead of draining the entire flood"
        );
        // Send through the same native behavior queue the console uses.
        let config = serde_json::from_value(serde_json::json!({
            "host": "localhost", "port": 25565, "auth_type": "offline",
            "username": "Bot", "cache_dir": "", "autosell_enabled": true,
        }))
        .unwrap();
        let mut behavior = crate::behaviors::BehaviorState::new(&config);
        let client = azalea::Client {
            entity: simulation.entity,
            ecs: Arc::new(parking_lot::RwLock::new(std::mem::take(
                simulation.app.world_mut(),
            ))),
        };
        behavior.enqueue_chat(&client, "/home farm".into());
        behavior.on_control_event(&client);
        *simulation.app.world_mut() = std::mem::take(&mut *client.ecs.write());
        simulation.tick();
        let mut home_sent = false;
        while let Some(packet) = commands.next() {
            if matches!(packet, ServerboundGamePacket::ChatCommand(command) if command.command == "home farm")
            {
                home_sent = true;
            }
        }
        assert!(
            home_sent,
            "manual command must get out with an incoming backlog"
        );
        assert!(!simulation
            .app
            .world()
            .get::<RawConnection>(simulation.entity)
            .unwrap()
            .injected_clientbound_packets
            .is_empty());
        let mut frames = 2;
        while !simulation
            .app
            .world()
            .get::<RawConnection>(simulation.entity)
            .unwrap()
            .injected_clientbound_packets
            .is_empty()
        {
            simulation.tick();
            frames += 1;
            assert!(frames < 1_000, "backlog must keep making progress");
        }
        let world = simulation.app.world_mut();
        let items = world
            .query::<&EntityKindComponent>()
            .iter(world)
            .filter(|kind| ***kind == EntityKind::Item)
            .count();
        assert_eq!(items, 0);
        assert_eq!(
            world
                .get::<ItemFilter>(simulation.entity)
                .unwrap()
                .ignored
                .len(),
            10_000
        );
        assert_eq!(
            world
                .get::<Inventory>(simulation.entity)
                .unwrap()
                .inventory_menu
                .slot(9)
                .unwrap(),
            &ItemStack::new(ItemKind::Beef, 32)
        );
        eprintln!(
            "30,200 farm packets, {frames} bounded updates: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn sell_and_home_reach_a_real_socket_while_compressed_item_packets_are_waiting() {
        use azalea::protocol::connect::{RawReadConnection, RawWriteConnection};
        use azalea::protocol::read::read_raw_packet;
        use azalea::protocol::write::{encode_to_network_packet, serialize_packet};
        use tokio::io::AsyncWriteExt;
        use tokio::net::{TcpListener, TcpStream};

        let mut simulation = simulation();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let (socket, accepted) = tokio::join!(
                TcpStream::connect(listener.local_addr().unwrap()), listener.accept(),
            );
            let (server, _) = accepted.unwrap();
            let (mut server_reader, mut server_writer) = server.into_split();
            let (read_stream, write_stream) = socket.unwrap().into_split();
            let connection = RawConnection::new(
                RawReadConnection { read_stream, buffer: Cursor::new(Vec::new()), compression_threshold: Some(64), dec_cipher: None },
                RawWriteConnection { write_stream, compression_threshold: Some(64), enc_cipher: None },
                ConnectionProtocol::Game,
            );
            simulation.app.world_mut().entity_mut(simulation.entity).insert(connection);
            let config = serde_json::from_value(serde_json::json!({
                "host": "localhost", "port": 25565, "auth_type": "offline",
                "username": "Bot", "cache_dir": "", "autosell_enabled": true,
                "autosell_interval_seconds": 5.0,
            })).unwrap();
            let mut behavior = crate::behaviors::BehaviorState::new(&config);
            let client = azalea::Client {
                entity: simulation.entity,
                ecs: Arc::new(parking_lot::RwLock::new(std::mem::take(simulation.app.world_mut()))),
            };
            behavior.on_spawn(&client);
            *simulation.app.world_mut() = std::mem::take(&mut *client.ecs.write());
            tokio::time::sleep(Duration::from_millis(2100)).await;
            let mut items = vec![ItemStack::Empty; 63];
            items[27] = ItemStack::new(ItemKind::Beef, 64);
            let mut packets: Vec<ClientboundGamePacket> = vec![
                ClientboundOpenScreen { container_id: 7, menu_type: azalea::registry::builtin::MenuKind::Generic9x3, title: "Items verkaufen".into() }.into_variant(),
                ClientboundContainerSetContent { container_id: 7, state_id: 18, items, carried_item: ItemStack::Empty }.into_variant(),
            ];
            for id in 1..=10_000 {
                packets.push(make_basic_add_entity(EntityKind::Item, id, azalea::Vec3::ZERO).into_variant());
                packets.push(item_metadata(id).into_variant());
            }
            // An empty compressed frame must not disturb the next GUI frame.
            let mut bytes = encode_to_network_packet(&[], Some(64), &mut None).to_vec();
            for packet in packets {
                bytes.extend(encode_to_network_packet(&serialize_packet(&packet).unwrap(), Some(64), &mut None));
            }
            // Keep producing while the client handles packets and sends commands.
            // A large blocking write would itself wait for the client to drain TCP.
            let producer = tokio::spawn(async move { server_writer.write_all(&bytes).await.unwrap(); });
            // Wait for socket readiness, rather than assume the reactor has
            // observed the server's write after a single task yield.
            for _ in 0..20 {
                tokio::time::sleep(Duration::from_millis(1)).await;
                simulation.tick();
                if simulation.app.world().get::<Inventory>(simulation.entity).unwrap().id == 7 {
                    break;
                }
            }
            assert_eq!(simulation.app.world().get::<Inventory>(simulation.entity).unwrap().id, 7);
            assert_eq!(simulation.app.world().get::<ItemFilter>(simulation.entity).unwrap().empty_payloads, 1);
            let callbacks: Vec<_> = simulation.app.world_mut().resource_mut::<Messages<game::ReceiveGamePacketEvent>>()
                .drain().collect();
            let client = azalea::Client {
                entity: simulation.entity,
                ecs: Arc::new(parking_lot::RwLock::new(std::mem::take(simulation.app.world_mut()))),
            };
            for event in callbacks {
                match &*event.packet {
                    ClientboundGamePacket::OpenScreen(packet) => behavior.on_menu_open(packet.container_id, packet.title.to_string()),
                    ClientboundGamePacket::ContainerSetContent(packet) => behavior.on_container_content(&client, packet),
                    _ => {}
                }
            }
            behavior.on_tick(&client);
            behavior.enqueue_chat(&client, "/home farm".into());
            behavior.on_control_event(&client);
            *simulation.app.world_mut() = std::mem::take(&mut *client.ecs.write());
            simulation.tick();
            assert!(simulation.app.world().get::<ItemFilter>(simulation.entity).unwrap().ignored.len() < 10_000,
                "commands must run before the incoming item flood has been drained");
            let relevant = tokio::time::timeout(Duration::from_secs(3), async {
                let mut buffer = Cursor::new(Vec::new());
                let mut relevant = Vec::new();
                loop {
                    let raw = read_raw_packet(&mut server_reader, &mut buffer, Some(64), &mut None).await.unwrap();
                    let packet = deserialize_packet::<ServerboundGamePacket>(&mut Cursor::new(raw.as_ref())).unwrap();
                    let home = matches!(&packet, ServerboundGamePacket::ChatCommand(command) if command.command == "home farm");
                    if matches!(&packet, ServerboundGamePacket::ContainerClick(_) | ServerboundGamePacket::ContainerClose(_) | ServerboundGamePacket::ChatCommand(_)) {
                        relevant.push(packet);
                    }
                    if home { break relevant }
                }
            }).await.expect("sell and home must get through during an item flood");
            assert_eq!(relevant.len(), 3, "one click, one close, then home: {relevant:?}");
            assert!(matches!(&relevant[0], ServerboundGamePacket::ContainerClick(packet) if packet.slot_num == 27 && packet.state_id == 18));
            assert!(matches!(&relevant[1], ServerboundGamePacket::ContainerClose(packet) if packet.container_id == 7));
            producer.abort();
        });
    }

    #[test]
    fn sustained_item_traffic_does_not_delay_menu_or_inventory_replies() {
        let mut simulation = simulation();
        for id in 1..=1_024 {
            simulation.receive_packet(make_basic_add_entity(
                EntityKind::Item,
                id,
                azalea::Vec3::ZERO,
            ));
        }
        while !simulation
            .app
            .world()
            .get::<RawConnection>(simulation.entity)
            .unwrap()
            .injected_clientbound_packets
            .is_empty()
        {
            simulation.tick();
        }
        for frame in 1..=100 {
            // 2,048 irrelevant packets EACH update, followed by an urgent GUI
            // reply. The former 256-packet limit accumulates a permanent queue.
            for id in 1..=1_024 {
                simulation.receive_packet(item_metadata(id));
                simulation.receive_packet(ClientboundMoveEntityPos {
                    entity_id: id.into(),
                    delta: Default::default(),
                    on_ground: true,
                });
            }
            simulation.receive_packet(ClientboundOpenScreen {
                container_id: frame,
                menu_type: azalea::registry::builtin::MenuKind::Generic9x3,
                title: "Items verkaufen".into(),
            });
            let mut items = vec![ItemStack::Empty; 63];
            items[27] = ItemStack::new(ItemKind::Beef, 64);
            simulation.receive_packet(ClientboundContainerSetContent {
                container_id: frame,
                state_id: frame as u32,
                items,
                carried_item: ItemStack::Empty,
            });
            // Permit a slow test machine a few bounded updates to catch up.
            // Even two updates exceed the old reader's total packet capacity.
            for _ in 0..2 {
                simulation.tick();
            }
            let inventory = simulation
                .app
                .world()
                .get::<Inventory>(simulation.entity)
                .unwrap();
            assert_eq!(
                inventory.id, frame,
                "menu response delayed at frame {frame}"
            );
            assert_eq!(
                inventory.menu().slot(27).unwrap(),
                &ItemStack::new(ItemKind::Beef, 64)
            );
            assert!(
                simulation
                    .app
                    .world()
                    .get::<RawConnection>(simulation.entity)
                    .unwrap()
                    .injected_clientbound_packets
                    .is_empty(),
                "sustained item traffic must not accumulate a backlog at frame {frame}"
            );
        }
    }

    #[test]
    fn item_filter_preserves_other_entities_and_cleans_up_reused_ids() {
        let mut filter = ItemFilter::default();
        let mut item =
            make_basic_add_entity(EntityKind::Item, 12, azalea::Vec3::ZERO).into_variant();
        assert!(!filter.keep(&mut item));
        let mut mob =
            make_basic_add_entity(EntityKind::Zombie, 13, azalea::Vec3::ZERO).into_variant();
        assert!(filter.keep(&mut mob));
        let mut removal = ClientboundRemoveEntities {
            entity_ids: vec![12.into(), 13.into()],
        }
        .into_variant();
        assert!(filter.keep(&mut removal));
        assert!(
            matches!(removal, ClientboundGamePacket::RemoveEntities(packet) if packet.entity_ids == vec![13.into()])
        );
        assert!(filter.ignored.is_empty());
        assert!(!filter.keep(&mut item));
        let mut replacement =
            make_basic_add_entity(EntityKind::OakBoat, 12, azalea::Vec3::ZERO).into_variant();
        assert!(filter.keep(&mut replacement));
        assert!(filter.ignored.is_empty());
    }

    #[test]
    fn world_and_configuration_transitions_clear_item_ids_in_packet_order() {
        let mut simulation = simulation();
        simulation.receive_packet(make_basic_add_entity(
            EntityKind::Item,
            12,
            azalea::Vec3::ZERO,
        ));
        simulation.tick();
        assert_eq!(
            simulation
                .app
                .world()
                .get::<ItemFilter>(simulation.entity)
                .unwrap()
                .ignored
                .len(),
            1
        );
        // Configuration changes in the SAME batch as the item spawn must not
        // leave the reader decoding subsequent configuration packets as game.
        simulation.receive_packet(make_basic_add_entity(
            EntityKind::Item,
            13,
            azalea::Vec3::ZERO,
        ));
        simulation.receive_packet(ClientboundStartConfiguration);
        simulation
            .receive_packet(azalea::protocol::packets::config::ClientboundKeepAlive { id: 123 });
        simulation.tick();
        assert!(simulation.has_component::<InConfigState>());
        assert!(simulation
            .app
            .world()
            .get::<ItemFilter>(simulation.entity)
            .unwrap()
            .ignored
            .is_empty());
        simulation
            .receive_packet(azalea::protocol::packets::config::ClientboundFinishConfiguration);
        simulation.receive_packet(default_login_packet());
        simulation.tick();
        assert!(simulation.has_component::<WorldName>());
        assert!(simulation.has_component::<azalea::InGameState>());
        assert!(simulation
            .app
            .world()
            .get::<ItemFilter>(simulation.entity)
            .unwrap()
            .ignored
            .is_empty());
    }

    #[test]
    fn fallback_diagnostics_preserve_tooltip_text_from_the_wire() {
        use azalea::buf::AzBufVar;
        use simdnbt::owned::{BaseNbt, NbtCompound};

        let message = "Verbindung zum vorherigen Server verloren – du wurdest auf einen anderen Server verschoben.";
        let reason = "Timed out waiting for teleport confirmation";
        for (hover_key, value_key) in [("hover_event", "value"), ("hoverEvent", "contents")] {
            for sender in [None, Some("HugoSMP")] {
                let caption =
                    sender.map_or_else(|| message.to_owned(), |name| format!("<{name}> {message}"));
                let mut tooltip = NbtCompound::new();
                tooltip.insert("action", "show_text");
                tooltip.insert(value_key, reason);
                let mut content = NbtCompound::new();
                content.insert("text", caption.as_str());
                content.insert(hover_key, tooltip);
                let mut raw = Vec::new();
                ClientboundSystemChat {
                    content: message.into(),
                    overlay: false,
                }
                .into_variant()
                .id()
                .azalea_write_var(&mut raw)
                .unwrap();
                BaseNbt::new("", content).write_unnamed(&mut raw);
                raw.push(0); // Not an action-bar overlay.
                let mut sim = simulation();
                sim.app
                    .world_mut()
                    .get_mut::<RawConnection>(sim.entity)
                    .unwrap()
                    .injected_clientbound_packets
                    .push(raw.into_boxed_slice());
                sim.tick();
                let filter = sim.app.world().get::<ItemFilter>(sim.entity).unwrap();
                assert!(filter.diagnostics_reported);
                assert!(
                    diagnostics_message(sim.app.world(), sim.entity, filter).contains(reason),
                    "a reason in the server's tooltip must survive chat flattening"
                );
            }
        }
    }

    #[test]
    fn game_and_configuration_disconnects_preserve_tooltip_text() {
        use simdnbt::owned::{BaseNbt, NbtCompound};

        let message = "Disconnected by the server";
        for state in [ConnectionProtocol::Game, ConnectionProtocol::Configuration] {
            let mut tooltip = NbtCompound::new();
            tooltip.insert("action", "show_text");
            tooltip.insert("value", "actual additional reason");
            let mut content = NbtCompound::new();
            content.insert("text", message);
            content.insert("hover_event", tooltip);
            let packet_id = match state {
                ConnectionProtocol::Game => ClientboundDisconnect {
                    reason: message.into(),
                }
                .into_variant()
                .id(),
                ConnectionProtocol::Configuration => {
                    azalea::protocol::packets::config::ClientboundDisconnect {
                        reason: message.into(),
                    }
                    .into_variant()
                    .id()
                }
                _ => unreachable!(),
            };
            let mut raw = Vec::new();
            packet_id.azalea_write_var(&mut raw).unwrap();
            BaseNbt::new("", content).write_unnamed(&mut raw);
            let mut sim = simulation();
            sim.app
                .world_mut()
                .get_mut::<RawConnection>(sim.entity)
                .unwrap()
                .state = state;
            let mut filter = ItemFilter::default();
            assert!(process_packet(sim.app.world_mut(), sim.entity, &raw, &mut filter).unwrap());
            assert!(filter.server_disconnect_received);
            assert!(diagnostics_message(sim.app.world(), sim.entity, &filter)
                .contains("actual additional reason"));
        }
    }

    #[test]
    fn fallback_diagnostics_capture_the_previous_world_and_ignore_player_quotes() {
        let message = "Verbindung zum vorherigen Server verloren – du wurdest auf einen anderen Server verschoben.";
        assert!(!is_failed_server_message(Some("Steve"), message));
        assert!(is_failed_server_message(Some("§6HugoSMP"), &format!("§c{message}§r")));
        let mut sim = simulation();
        sim.receive_packet(ClientboundSystemChat {
            content: format!("Steve: {message}").into(), overlay: false,
        });
        sim.tick();
        assert!(!sim.app.world().get::<ItemFilter>(sim.entity).unwrap().diagnostics_reported);
        assert!(sim.app.world().get::<ItemFilter>(sim.entity).unwrap().server_tooltip_text.is_none());
        sim.receive_packet(ClientboundKeepAlive { id: 123 });
        sim.receive_packet(ClientboundSystemChat {
            content: format!("§c{message}§r").into(), overlay: false,
        });
        sim.receive_packet(ClientboundStartConfiguration);
        sim.receive_packet(azalea::protocol::packets::config::ClientboundKeepAlive { id: 456 });
        sim.tick();
        let filter = sim.app.world().get::<ItemFilter>(sim.entity).unwrap();
        assert!(filter.diagnostics_reported);
        assert_eq!(filter.keepalives_received, 2);
        assert_eq!(filter.last_protocol, Some(ConnectionProtocol::Configuration));
        assert_eq!(filter.read_errors, 0);
    }

    #[test]
    fn menus_and_disconnects_survive_the_filtered_reader() {
        let mut simulation = simulation();
        simulation.receive_packet(ClientboundOpenScreen {
            container_id: 7,
            menu_type: azalea::registry::builtin::MenuKind::Generic9x3,
            title: "Items verkaufen".into(),
        });
        let mut slots = vec![ItemStack::Empty; 63];
        slots[27] = ItemStack::new(ItemKind::Beef, 64);
        simulation.receive_packet(ClientboundContainerSetContent {
            container_id: 7,
            state_id: 18,
            items: slots,
            carried_item: ItemStack::Empty,
        });
        simulation.tick();
        assert_eq!(
            simulation
                .app
                .world()
                .get::<Inventory>(simulation.entity)
                .unwrap()
                .id,
            7
        );
        assert_eq!(
            simulation
                .app
                .world()
                .get::<Inventory>(simulation.entity)
                .unwrap()
                .menu()
                .slot(27)
                .unwrap(),
            &ItemStack::new(ItemKind::Beef, 64)
        );
        let callbacks: Vec<_> = simulation
            .app
            .world_mut()
            .resource_mut::<Messages<game::ReceiveGamePacketEvent>>()
            .drain()
            .collect();
        assert!(callbacks.iter().any(|event| matches!(
            &*event.packet,
            ClientboundGamePacket::ContainerSetContent(_)
        )));
        simulation.receive_packet(ClientboundDisconnect {
            reason: "test disconnect".into(),
        });
        simulation.tick();
        assert!(!simulation.has_component::<RawConnection>());
        assert!(!simulation.has_component::<azalea::InGameState>());
    }
}
