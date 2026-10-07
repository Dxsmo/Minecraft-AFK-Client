//! Bounded network work for a stationary AFK client.
//!
//! Azalea's default reader drains the socket until it is empty before running
//! ticks or flushing outgoing packets. Item farms can keep that reader busy.
//! Delegate protocol handling to the pinned Azalea version, but yield between
//! batches and omit dropped-item entities, which the server collects for us.

use std::collections::{HashSet, VecDeque};
use std::io::Cursor;
use std::sync::Arc;
use std::time::{Duration, Instant};

use azalea::app::{App, Plugin, PreUpdate};
use azalea::connection::RawConnection;
use azalea::core::entity_id::MinecraftEntityId;
use azalea::disconnect::DisconnectEvent;
use azalea::ecs as bevy_ecs;
use azalea::ecs::prelude::*;
use azalea::packet::{config, game, login};
use azalea::protocol::packets::{
    config::ClientboundConfigPacket, game::ClientboundGamePacket, login::ClientboundLoginPacket,
    ConnectionProtocol,
};
use azalea::protocol::read::{deserialize_packet, ReadPacketError};
use azalea::registry::builtin::EntityKind;

use crate::{emit, protocol::OutEvent};

const MAX_PACKETS_PER_UPDATE: usize = 256;
const READ_BUDGET: Duration = Duration::from_millis(4);

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
}

impl ItemFilter {
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
        let now = Instant::now();
        if self
            .last_warning_at
            .is_none_or(|at| now.duration_since(at) >= Duration::from_secs(5))
        {
            self.last_warning_at = Some(now);
            emit(&OutEvent::Warning { message });
        }
    }
}

/// The bot handler needs only these raw packet callbacks. Chat, health,
/// keepalive, disconnect, resource packs and world loading are still processed
/// normally by Azalea and emit their own higher-level events.
fn needs_callback(packet: &ClientboundGamePacket) -> bool {
    matches!(
        packet,
        ClientboundGamePacket::OpenScreen(_)
            | ClientboundGamePacket::ContainerSetContent(_)
            | ClientboundGamePacket::ContainerSetSlot(_)
            | ClientboundGamePacket::Respawn(_)
            | ClientboundGamePacket::PlayerPosition(_)
    )
}

fn process_packet(
    ecs: &mut World,
    entity: Entity,
    raw: &[u8],
    filter: &mut ItemFilter,
) -> Result<(), Box<ReadPacketError>> {
    // Re-read the state for EACH packet. Login, compression and configuration
    // transitions in one incoming batch must affect all subsequent packets.
    let Some(connection) = ecs.get::<RawConnection>(entity) else {
        return Ok(());
    };
    let state = connection.state;
    let stream = &mut Cursor::new(raw);
    match state {
        ConnectionProtocol::Game => {
            let mut packet = deserialize_packet::<ClientboundGamePacket>(stream)?;
            if !filter.keep(&mut packet) {
                return Ok(());
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
            login::process_packet(ecs, entity, &packet);
            ecs.write_message(login::ReceiveLoginPacketEvent { entity, packet });
        }
        ConnectionProtocol::Configuration => {
            filter.ignored.clear();
            let packet = Arc::new(deserialize_packet::<ClientboundConfigPacket>(stream)?);
            config::process_packet(ecs, entity, &packet);
            ecs.write_message(config::ReceiveConfigPacketEvent { entity, packet });
        }
        ConnectionProtocol::Handshake | ConnectionProtocol::Status => {
            unreachable!("AFK reader before login")
        }
    }
    Ok(())
}

fn disconnect(ecs: &mut World, entity: Entity) {
    // Removing the connection drops its writer/stream, and the standard
    // DisconnectPlugin cleans up player/world components and emits Event::Disconnect.
    ecs.entity_mut(entity).remove::<RawConnection>();
    ecs.write_message(DisconnectEvent {
        entity,
        reason: None,
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
        for _ in 0..MAX_PACKETS_PER_UPDATE {
            if started.elapsed() >= READ_BUDGET {
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
                Ok(Some(raw)) => {
                    if let Err(error) = process_packet(ecs, entity, &raw, &mut filter) {
                        filter.warn(format!(
                            "AFK: Fehler beim Verarbeiten eines Serverpakets: {error}"
                        ));
                    }
                }
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
                        disconnect(ecs, entity);
                    }
                    break;
                }
            }
        }
        if let Some(mut connection) = ecs.get_mut::<RawConnection>(entity) {
            // Preserve order and unread data when yielding. Poll the writer even
            // if incoming packets are still waiting: commands must get out.
            connection.injected_clientbound_packets = injected.into();
            let writer_closed = connection
                .net_conn()
                .is_some_and(|network| network.poll_writer().is_some());
            drop(connection);
            if writer_closed {
                disconnect(ecs, entity);
            }
        }
        ecs.entity_mut(entity).insert(filter);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use azalea::app::Plugin;
    use azalea::ecs::schedule::ScheduleCleanupPolicy;
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
        let mut simulation = Simulation::new(ConnectionProtocol::Game);
        // Replace the stock reader, retaining Azalea's complete protocol,
        // inventory, movement, disconnect and physics systems in the fixture.
        simulation
            .app
            .world_mut()
            .schedule_scope(PreUpdate, |world, schedule| {
                assert_eq!(
                    schedule
                        .remove_systems_in_set(
                            azalea::connection::read_packets,
                            world,
                            ScheduleCleanupPolicy::RemoveSystemsOnly,
                        )
                        .unwrap(),
                    1
                );
            });
        AfkNetworkPlugin.build(&mut simulation.app);
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
    fn dense_item_packets_yield_and_preserve_inventory_updates_and_commands() {
        let mut simulation = simulation();
        let commands = SentPackets::new(&mut simulation);
        for id in 1..=5_000 {
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
            remaining >= 15_100 - MAX_PACKETS_PER_UPDATE,
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
            5_000
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
            "15,100 farm packets, {frames} bounded updates: {:?}",
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
            let (mut server, _) = accepted.unwrap();
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
            tokio::time::sleep(Duration::from_millis(260)).await;
            let mut items = vec![ItemStack::Empty; 63];
            items[27] = ItemStack::new(ItemKind::Beef, 64);
            let mut packets: Vec<ClientboundGamePacket> = vec![
                ClientboundOpenScreen { container_id: 7, menu_type: azalea::registry::builtin::MenuKind::Generic9x3, title: "Items verkaufen".into() }.into_variant(),
                ClientboundContainerSetContent { container_id: 7, state_id: 18, items, carried_item: ItemStack::Empty }.into_variant(),
            ];
            for id in 1..=2_000 {
                packets.push(make_basic_add_entity(EntityKind::Item, id, azalea::Vec3::ZERO).into_variant());
                packets.push(item_metadata(id).into_variant());
            }
            let mut bytes = Vec::new();
            for packet in packets {
                bytes.extend(encode_to_network_packet(&serialize_packet(&packet).unwrap(), Some(64), &mut None));
            }
            server.write_all(&bytes).await.unwrap();
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
            assert!(simulation.app.world().get::<ItemFilter>(simulation.entity).unwrap().ignored.len() < 2_000,
                "commands must run before the incoming item flood has been drained");
            let relevant = tokio::time::timeout(Duration::from_secs(3), async {
                let mut buffer = Cursor::new(Vec::new());
                let mut relevant = Vec::new();
                loop {
                    let raw = read_raw_packet(&mut server, &mut buffer, Some(64), &mut None).await.unwrap();
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
        });
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
