//! Independent wire fixtures audited against Mojang's official 26.2 client.
//! See vendor/README.md for the reference JAR, methods and reproduction steps.

use azalea::ecs::system::RunSystemOnce;
use azalea::entity::{HasClientLoaded, LookDirection, Physics, Position};
use azalea::protocol::packets::{ConnectionProtocol, PROTOCOL_VERSION, Packet, game::*};
use azalea::protocol::write::serialize_packet;
use azalea::test_utils::simulation::{SentPackets, Simulation, default_login_packet};

use crate::{network_mode::client_plugins, protocol::JavaNetworkMode};

fn simulation(mode: JavaNetworkMode) -> (Simulation, SentPackets) {
    let mut sim = Simulation::new_with_plugins(ConnectionProtocol::Game, client_plugins(mode));
    sim.receive_packet(default_login_packet());
    sim.update();
    let sent = SentPackets::new(&mut sim);
    (sim, sent)
}

fn receive_wire(sim: &mut Simulation, bytes: Vec<u8>) {
    sim.with_component_mut::<azalea::connection::RawConnection>(|connection| {
        connection.injected_clientbound_packets.push(bytes.into());
    });
    sim.update();
}

fn rotation_fixture(yaw: f32) -> Vec<u8> {
    let mut bytes = vec![0x49];
    bytes.extend(yaw.to_be_bytes());
    bytes.push(0);
    bytes.extend((-5.0_f32).to_be_bytes());
    bytes.push(0);
    bytes
}

#[test]
fn both_readers_apply_direct_player_inventory_updates_to_the_open_menu() {
    use azalea::entity::inventory::Inventory;
    use azalea::registry::builtin::{ItemKind, MenuKind};
    use azalea_inventory::ItemStack;
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, _) = simulation(mode);
        sim.receive_packet(ClientboundOpenScreen {
            container_id: 7,
            menu_type: MenuKind::Generic9x3,
            title: "Items verkaufen".into(),
        });
        sim.receive_packet(ClientboundContainerSetContent {
            container_id: 7,
            state_id: 18,
            items: vec![ItemStack::Empty; 63],
            carried_item: ItemStack::Empty,
        });
        sim.update();
        for (slot, player_slot, container_slot) in [
            (0, 36, Some(54)),
            (8, 44, Some(62)),
            (9, 9, Some(27)),
            (35, 35, Some(53)),
            (36, 8, None),
            (39, 5, None),
            (40, 45, None),
        ] {
            sim.receive_packet(ClientboundSetPlayerInventory {
                slot,
                contents: ItemStack::new(ItemKind::Beef, 32),
            });
            sim.update();
            let inventory = sim.component::<Inventory>();
            assert_eq!(
                inventory.inventory_menu.slot(player_slot).unwrap().count(),
                32,
                "{mode:?}: direct inventory slot {slot}"
            );
            if let Some(slot) = container_slot {
                assert_eq!(inventory.menu().slot(slot).unwrap().count(), 32);
            }
            assert_eq!(
                inventory.state_id, 18,
                "direct player updates do not change the container revision"
            );
        }
        sim.receive_packet(ClientboundSetPlayerInventory {
            slot: 9,
            contents: ItemStack::Empty,
        });
        sim.update();
        assert!(sim
            .component::<Inventory>()
            .menu()
            .slot(27)
            .unwrap()
            .is_empty());
    }
}

#[test]
fn opening_a_new_menu_resets_the_old_menus_revision_and_carried_stack() {
    use azalea::entity::inventory::Inventory;
    use azalea::registry::builtin::{ItemKind, MenuKind};
    use azalea_inventory::ItemStack;
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, _) = simulation(mode);
        sim.receive_packet(ClientboundContainerSetContent {
            container_id: 0,
            state_id: 77,
            items: vec![ItemStack::Empty; 46],
            carried_item: ItemStack::new(ItemKind::Beef, 32),
        });
        sim.update();
        assert_eq!(sim.component::<Inventory>().state_id, 77);
        for (session, id) in [7, 8, 8].into_iter().enumerate() {
            sim.receive_packet(ClientboundOpenScreen {
                container_id: id,
                menu_type: MenuKind::Generic9x3,
                title: "Items verkaufen".into(),
            });
            sim.update();
            assert_eq!(
                sim.component::<azalea::inventory::MenuSession>().0,
                session as u64 + 1
            );
            assert_eq!(sim.component::<Inventory>().state_id, 0);
            assert!(sim.component::<Inventory>().carried.is_empty());
            sim.receive_packet(ClientboundContainerSetContent {
                container_id: id,
                state_id: 18,
                items: vec![ItemStack::Empty; 63],
                carried_item: ItemStack::new(ItemKind::Beef, 1),
            });
            sim.update();
        }
    }
}

#[test]
fn direct_cursor_updates_are_used_by_the_next_actual_click_packet() {
    use azalea::entity::inventory::Inventory;
    use azalea::registry::builtin::{ItemKind, MenuKind};
    use azalea_inventory::{operations::QuickMoveClick, ItemStack};
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, sent) = simulation(mode);
        sim.receive_packet(ClientboundOpenScreen {
            container_id: 7,
            menu_type: MenuKind::Generic9x3,
            title: "Items verkaufen".into(),
        });
        let mut items = vec![ItemStack::Empty; 63];
        items[27] = ItemStack::new(ItemKind::Cobblestone, 64);
        sim.receive_packet(ClientboundContainerSetContent {
            container_id: 7,
            state_id: 18,
            items,
            carried_item: ItemStack::Empty,
        });
        sim.receive_packet(ClientboundSetCursorItem {
            contents: ItemStack::new(ItemKind::Beef, 3),
        });
        sim.update();
        assert_eq!(sim.component::<Inventory>().carried.count(), 3);
        sim.app
            .world_mut()
            .trigger(azalea::inventory::ContainerClickEvent {
                entity: sim.entity,
                window_id: 7,
                operation: QuickMoveClick::Left { slot: 27 }.into(),
            });
        sim.app.world_mut().flush();
        let Some(ServerboundGamePacket::ContainerClick(click)) = sent.next() else {
            panic!("expected a real click packet");
        };
        assert_eq!(click.state_id, 18);
        assert_eq!(click.carried_item.0.as_ref().unwrap().count, 3);
        assert_eq!(click.carried_item.0.as_ref().unwrap().kind, ItemKind::Beef);
        sim.receive_packet(ClientboundSetCursorItem {
            contents: ItemStack::Empty,
        });
        sim.update();
        assert!(sim.component::<Inventory>().carried.is_empty());
        assert_eq!(sim.component::<Inventory>().state_id, 18);
    }
}

#[test]
fn both_readers_apply_split_bundles_only_after_the_closing_delimiter() {
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, sent) = simulation(mode);
        let initial_direction = sim.component::<LookDirection>();
        receive_wire(&mut sim, vec![0]);
        receive_wire(&mut sim, rotation_fixture(20.0));
        for _ in 0..3 {
            sim.update();
        }
        assert_eq!(
            sim.component::<LookDirection>(),
            initial_direction,
            "{mode:?}: partial bundles must not change the world between updates"
        );
        sent.expect_empty();
        // Empty framed payloads are not bundle delimiters.
        receive_wire(&mut sim, vec![]);
        sent.expect_empty();
        receive_wire(&mut sim, vec![0]);
        assert_eq!(sim.component::<LookDirection>().y_rot(), 20.0);
        assert_eq!(
            wire(&sent.next().expect("acknowledge after the complete bundle")),
            movement_bytes(0x20, None, Some([20.0, -5.0]), 0)
        );
        sent.expect_empty();
        // The collector must return to normal immediately after closing.
        receive_wire(&mut sim, rotation_fixture(25.0));
        assert_eq!(sim.component::<LookDirection>().y_rot(), 25.0);
        assert!(matches!(
            sent.next(),
            Some(ServerboundGamePacket::MovePlayerRot(_))
        ));
    }
}

#[test]
fn a_bundle_larger_than_the_afk_update_quota_is_applied_as_one_batch() {
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, sent) = simulation(mode);
        let initial_direction = sim.component::<LookDirection>();
        sim.with_component_mut::<azalea::connection::RawConnection>(|connection| {
            connection.injected_clientbound_packets.push(vec![0].into());
            connection
                .injected_clientbound_packets
                .push(rotation_fixture(20.0).into());
            for id in 0..300_u32 {
                let mut ping = vec![0x3d];
                ping.extend(id.to_be_bytes());
                connection.injected_clientbound_packets.push(ping.into());
            }
        });
        for _ in 0..32 {
            sim.update();
        }
        assert_eq!(
            sim.component::<LookDirection>(),
            initial_direction,
            "{mode:?}"
        );
        sent.expect_empty();
        receive_wire(&mut sim, vec![0]);
        assert_eq!(sim.component::<LookDirection>().y_rot(), 20.0);
        assert!(matches!(
            sent.next(),
            Some(ServerboundGamePacket::MovePlayerRot(_))
        ));
        for id in 0..300_u32 {
            let mut expected = vec![0x2d];
            expected.extend(id.to_be_bytes());
            assert_eq!(
                wire(
                    &sent
                        .next()
                        .expect("all bundled pings in the closing update")
                ),
                expected
            );
        }
        sent.expect_empty();
    }
}

#[test]
fn both_readers_commit_bundled_inventory_and_control_replies_in_wire_order() {
    use azalea::entity::inventory::Inventory;
    use azalea::registry::builtin::ItemKind;
    use azalea_inventory::ItemStack;

    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, sent) = simulation(mode);
        receive_wire(&mut sim, vec![0]);
        receive_wire(&mut sim, rotation_fixture(10.0));
        receive_wire(
            &mut sim,
            serialize_packet(
                &ClientboundContainerSetSlot {
                    container_id: 0,
                    state_id: 5,
                    slot: 9,
                    item_stack: ItemStack::new(ItemKind::Beef, 64),
                }
                .into_variant(),
            )
            .unwrap()
            .into_vec(),
        );
        let mut keepalive = vec![0x2c];
        keepalive.extend(u64::MAX.to_be_bytes());
        receive_wire(&mut sim, keepalive);
        receive_wire(&mut sim, rotation_fixture(15.0));
        assert_eq!(
            sim.component::<Inventory>()
                .inventory_menu
                .slot(9)
                .unwrap()
                .count(),
            0,
            "{mode:?}"
        );
        sent.expect_empty();
        receive_wire(&mut sim, vec![0]);
        assert_eq!(
            sim.component::<Inventory>()
                .inventory_menu
                .slot(9)
                .unwrap()
                .count(),
            64
        );
        assert_eq!(sim.component::<Inventory>().state_id, 5);
        assert_eq!(
            wire(&sent.next().unwrap()),
            movement_bytes(0x20, None, Some([10.0, -5.0]), 0)
        );
        let mut expected = vec![0x1c];
        expected.extend(u64::MAX.to_be_bytes());
        assert_eq!(wire(&sent.next().unwrap()), expected);
        assert_eq!(
            wire(&sent.next().unwrap()),
            movement_bytes(0x20, None, Some([15.0, -5.0]), 0)
        );
        sent.expect_empty();
        // Adjacent empty bundles must not retain data or change state.
        for _ in 0..4 {
            receive_wire(&mut sim, vec![0]);
        }
        receive_wire(&mut sim, rotation_fixture(30.0));
        assert_eq!(
            wire(&sent.next().unwrap()),
            movement_bytes(0x20, None, Some([30.0, -5.0]), 0)
        );
        sent.expect_empty();
    }
}

#[test]
fn both_readers_accept_the_vanilla_bundle_limit_without_counting_empty_frames() {
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, sent) = simulation(mode);
        sim.with_component_mut::<azalea::connection::RawConnection>(|connection| {
            connection.injected_clientbound_packets.push(vec![0].into());
            for id in 0..4096_u32 {
                let mut ping = vec![0x3d];
                ping.extend(id.to_be_bytes());
                connection.injected_clientbound_packets.push(ping.into());
                if id % 100 == 0 {
                    connection.injected_clientbound_packets.push(vec![].into());
                }
            }
        });
        for _ in 0..64 {
            sim.update();
        }
        assert!(
            sim.app
                .world()
                .get::<azalea::connection::RawConnection>(sim.entity)
                .unwrap()
                .is_alive()
        );
        sent.expect_empty();
        receive_wire(&mut sim, vec![0]);
        for id in 0..4096_u32 {
            assert!(
                matches!(sent.next(), Some(ServerboundGamePacket::Pong(p)) if p.id == id),
                "{mode:?}, {id}"
            );
        }
        sent.expect_empty();
    }
}

#[test]
fn both_readers_reject_invalid_bundles_without_applying_their_partial_contents() {
    use azalea::connection::RawConnection;
    use azalea::disconnect::DisconnectEvent;
    use azalea::ecs::message::Messages;

    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        for rejection in ["too many", "terminal", "delimiter", "packet ID"] {
            let (mut sim, sent) = simulation(mode);
            receive_wire(&mut sim, vec![0]);
            receive_wire(&mut sim, rotation_fixture(20.0));
            sim.with_component_mut::<RawConnection>(|connection| {
                match rejection {
                    "too many" => {
                        // The held rotation already uses one of the 4096 slots.
                        for id in 0..4096_u32 {
                            let mut ping = vec![0x3d];
                            ping.extend(id.to_be_bytes());
                            connection.injected_clientbound_packets.push(ping.into());
                        }
                    }
                    "terminal" => connection.injected_clientbound_packets.push(
                        serialize_packet(&ClientboundStartConfiguration.into_variant()).unwrap(),
                    ),
                    "delimiter" => connection
                        .injected_clientbound_packets
                        .push(vec![0, 42].into()),
                    "packet ID" => connection
                        .injected_clientbound_packets
                        .push(vec![0x80; 5].into()),
                    _ => unreachable!(),
                }
                // Must not resume an invalid bundle and apply its held rotation.
                connection.injected_clientbound_packets.push(vec![0].into());
            });
            let mut reasons = Vec::new();
            for _ in 0..64 {
                sim.update();
                reasons.extend(
                    sim.app
                        .world_mut()
                        .resource_mut::<Messages<DisconnectEvent>>()
                        .drain()
                        .filter_map(|event| event.reason.map(|reason| reason.to_string())),
                );
                if sim.app.world().get::<RawConnection>(sim.entity).is_none() {
                    break;
                }
            }
            assert!(
                sim.app.world().get::<RawConnection>(sim.entity).is_none(),
                "{mode:?}, {rejection}"
            );
            assert_eq!(reasons.len(), 1, "{mode:?}, {rejection}");
            assert!(reasons[0].contains("ungültiges Paket-Bundle"));
            sent.expect_empty();
        }
    }
}

#[test]
fn both_readers_continue_control_packets_after_an_invalid_packet_in_a_complete_bundle() {
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, sent) = simulation(mode);
        receive_wire(&mut sim, vec![0]);
        // A truncated particle packet, followed by a valid control packet.
        let particle = ClientboundLevelParticles {
            override_limiter: false,
            always_show: false,
            pos: azalea::Vec3::ZERO,
            x_dist: 0.0,
            y_dist: 0.0,
            z_dist: 0.0,
            max_speed: 0.0,
            count: 0,
            particle: Default::default(),
        };
        let encoded = serialize_packet(&particle.into_variant()).unwrap();
        receive_wire(&mut sim, vec![encoded[0]]);
        let mut keepalive = vec![0x2c];
        keepalive.extend(42_u64.to_be_bytes());
        receive_wire(&mut sim, keepalive);
        sent.expect_empty();
        receive_wire(&mut sim, vec![0]);
        assert!(matches!(sent.next(), Some(ServerboundGamePacket::KeepAlive(p)) if p.id == 42));
        sent.expect_empty();
    }
}

fn wire(packet: &ServerboundGamePacket) -> Vec<u8> {
    serialize_packet(packet).unwrap().into_vec()
}

fn movement_bytes(
    id: u8,
    position: Option<[f64; 3]>,
    rotation: Option<[f32; 2]>,
    flags: u8,
) -> Vec<u8> {
    let mut bytes = vec![id];
    for value in position.into_iter().flatten() {
        bytes.extend(value.to_be_bytes());
    }
    for value in rotation.into_iter().flatten() {
        bytes.extend(value.to_be_bytes());
    }
    bytes.push(flags);
    bytes
}

#[test]
fn outgoing_control_bytes_match_official_26_2_ids_and_field_widths() {
    assert_eq!(
        PROTOCOL_VERSION, 776,
        "Re-audit fixtures when changing Minecraft version"
    );
    for (id, encoded) in [
        (0, vec![0]),
        (127, vec![127]),
        (128, vec![128, 1]),
        (16_384, vec![128, 128, 1]),
        (u32::MAX, vec![255, 255, 255, 255, 15]),
    ] {
        let mut expected = vec![0x00];
        expected.extend(encoded);
        assert_eq!(
            wire(&ServerboundAcceptTeleportation { id }.into_variant()),
            expected
        );
    }
    for id in [0, 0x0102_0304_0506_0708, 0x8000_0000_0000_0001, u64::MAX] {
        let mut expected = vec![0x1c];
        expected.extend(id.to_be_bytes());
        assert_eq!(wire(&ServerboundKeepAlive { id }.into_variant()), expected);
    }
    for id in [0, 0x0102_0304, 0x8000_0001, u32::MAX] {
        let mut expected = vec![0x2d];
        expected.extend(id.to_be_bytes());
        assert_eq!(wire(&ServerboundPong { id }.into_variant()), expected);
    }
    assert_eq!(wire(&ServerboundClientTickEnd.into_variant()), [0x0d]);
    for flags in 0..=3 {
        let move_flags = azalea::protocol::common::movements::MoveFlags {
            on_ground: flags & 1 != 0,
            horizontal_collision: flags & 2 != 0,
        };
        assert_eq!(
            wire(&ServerboundMovePlayerStatusOnly { flags: move_flags }.into_variant()),
            [0x21, flags]
        );
        assert_eq!(
            wire(
                &ServerboundMovePlayerPos {
                    pos: azalea::Vec3::new(-12.5, 70.0, 30.25),
                    flags: move_flags,
                }
                .into_variant()
            ),
            movement_bytes(0x1e, Some([-12.5, 70.0, 30.25]), None, flags)
        );
        assert_eq!(
            wire(
                &ServerboundMovePlayerRot {
                    look_direction: LookDirection::new(370.0, -15.0),
                    flags: move_flags,
                }
                .into_variant()
            ),
            movement_bytes(0x20, None, Some([370.0, -15.0]), flags)
        );
        assert_eq!(
            wire(
                &ServerboundMovePlayerPosRot {
                    pos: azalea::Vec3::new(-12.5, 70.0, 30.25),
                    look_direction: LookDirection::new(370.0, -15.0),
                    flags: move_flags,
                }
                .into_variant()
            ),
            movement_bytes(
                0x1f,
                Some([-12.5, 70.0, 30.25]),
                Some([370.0, -15.0]),
                flags
            )
        );
    }
}

#[test]
fn both_readers_echo_high_bit_keepalive_and_ping_ids_without_narrowing() {
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, sent) = simulation(mode);
        let mut keepalive = vec![0x2c];
        keepalive.extend(0x8000_0000_0102_0304_u64.to_be_bytes());
        receive_wire(&mut sim, keepalive.clone());
        keepalive[0] = 0x1c;
        assert_eq!(wire(&sent.next().unwrap()), keepalive);
        let mut ping = vec![0x3d];
        ping.extend(0x8000_0102_u32.to_be_bytes());
        receive_wire(&mut sim, ping.clone());
        ping[0] = 0x2d;
        assert_eq!(wire(&sent.next().unwrap()), ping);
        sent.expect_empty();
    }
}

#[test]
fn both_readers_answer_official_rotation_packets_immediately() {
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        for (yaw, pitch, relative_y, relative_x, expected) in [
            (20.0, -5.0, false, false, [20.0, -5.0]),
            (20.0, -5.0, true, false, [370.0, -5.0]),
            (20.0, -5.0, false, true, [20.0, 25.0]),
            (20.0, -5.0, true, true, [370.0, 25.0]),
            (20.125, -5.125, false, false, [20.125, -5.125]),
            (20.0, 385.0, false, false, [20.0, 25.0]),
            (20.0, 375.0, false, true, [20.0, 45.0]),
            (f32::INFINITY, -5.0, false, false, [350.0, -5.0]),
            (20.0, f32::NAN, false, false, [20.0, 30.0]),
        ] {
            let (mut sim, sent) = simulation(mode);
            sim.with_component_mut::<LookDirection>(|direction| {
                *direction = LookDirection::new(350.0, 30.0)
            });
            sim.with_component_mut::<Physics>(|physics| {
                physics.set_on_ground(true);
                physics.horizontal_collision = true;
            });
            // Official order: yaw Float, relative-y Bool, pitch Float, relative-x Bool.
            let mut bytes = vec![0x49];
            bytes.extend(yaw.to_be_bytes());
            bytes.push(u8::from(relative_y));
            bytes.extend(pitch.to_be_bytes());
            bytes.push(u8::from(relative_x));
            receive_wire(&mut sim, bytes);
            let direction = sim.component::<LookDirection>();
            assert_eq!([direction.y_rot(), direction.x_rot()], expected, "{mode:?}");
            // Vanilla acknowledges forced rotations with both flags false, even on ground.
            assert_eq!(
                wire(
                    &sent
                        .next()
                        .expect("rotation acknowledgement before next game tick")
                ),
                movement_bytes(0x20, None, Some(expected), 0)
            );
            sent.expect_empty();
        }
    }
}

#[test]
fn both_readers_preserve_relative_teleport_and_acknowledgement_order() {
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, sent) = simulation(mode);
        sim.with_component_mut::<Position>(|position| {
            **position = azalea::Vec3::new(10.0, 64.0, 20.0)
        });
        sim.with_component_mut::<LookDirection>(|direction| {
            *direction = LookDirection::new(350.0, 30.0)
        });
        sim.with_component_mut::<Physics>(|physics| {
            physics.velocity = azalea::Vec3::new(1.0, 2.0, 3.0)
        });
        let mut bytes = vec![0x48, 0x80, 0x01]; // teleport 128 as VarInt
        for value in [2.0_f64, 70.0, 30.0, 4.0, 5.0, 6.0] {
            bytes.extend(value.to_be_bytes());
        }
        bytes.extend(20.0_f32.to_be_bytes());
        bytes.extend((-15.0_f32).to_be_bytes());
        bytes.extend(0x89_u32.to_be_bytes()); // relative X, yaw, delta Z
        receive_wire(&mut sim, bytes);
        assert_eq!(
            **sim.app.world().get::<Position>(sim.entity).unwrap(),
            azalea::Vec3::new(12.0, 70.0, 30.0)
        );
        assert_eq!(
            sim.component::<Physics>().velocity,
            azalea::Vec3::new(4.0, 5.0, 9.0)
        );
        assert_eq!(wire(&sent.next().unwrap()), [0x00, 0x80, 0x01]);
        assert_eq!(
            wire(&sent.next().unwrap()),
            movement_bytes(0x1f, Some([12.0, 70.0, 30.0]), Some([370.0, -15.0]), 0)
        );
        sent.expect_empty();
    }
}

#[test]
fn stationary_clients_report_each_collision_transition_once() {
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, sent) = simulation(mode);
        sim.app
            .world_mut()
            .entity_mut(sim.entity)
            .insert(HasClientLoaded);
        for (index, flags) in [0_u8, 2, 3, 1, 0].into_iter().enumerate() {
            sim.with_component_mut::<Physics>(|physics| {
                // Repeated collision calculations must not replace the last *sent* state.
                physics.set_on_ground(flags & 1 != 0);
                physics.set_on_ground(flags & 1 != 0);
                physics.horizontal_collision = flags & 2 != 0;
            });
            sim.app
                .world_mut()
                .run_system_once(azalea::movement::send_position)
                .unwrap();
            if index == 0 {
                sent.expect_empty();
                continue;
            }
            assert_eq!(
                wire(&sent.next().expect("changed movement flags")),
                [0x21, flags],
                "{mode:?}"
            );
            sim.app
                .world_mut()
                .run_system_once(azalea::movement::send_position)
                .unwrap();
            sent.expect_empty();
        }
    }
}

#[test]
fn movement_packets_update_flag_history_and_keep_the_twenty_tick_heartbeat() {
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, sent) = simulation(mode);
        sim.app
            .world_mut()
            .entity_mut(sim.entity)
            .insert(HasClientLoaded);
        sim.with_component_mut::<Position>(|position| {
            **position = azalea::Vec3::new(1.0, 0.0, 0.0)
        });
        sim.with_component_mut::<Physics>(|physics| {
            physics.set_on_ground(true);
            physics.horizontal_collision = true;
        });
        sim.app
            .world_mut()
            .run_system_once(azalea::movement::send_position)
            .unwrap();
        assert_eq!(
            wire(&sent.next().unwrap()),
            movement_bytes(0x1e, Some([1.0, 0.0, 0.0]), None, 3)
        );
        for _ in 0..19 {
            sim.app
                .world_mut()
                .run_system_once(azalea::movement::send_position)
                .unwrap();
            sent.expect_empty();
        }
        sim.app
            .world_mut()
            .run_system_once(azalea::movement::send_position)
            .unwrap();
        assert_eq!(
            wire(&sent.next().unwrap()),
            movement_bytes(0x1e, Some([1.0, 0.0, 0.0]), None, 3)
        );
        sim.with_component_mut::<LookDirection>(|direction| {
            *direction = LookDirection::new(45.0, 10.0)
        });
        sim.with_component_mut::<Physics>(|physics| physics.horizontal_collision = false);
        sim.app
            .world_mut()
            .run_system_once(azalea::movement::send_position)
            .unwrap();
        assert_eq!(
            wire(&sent.next().unwrap()),
            movement_bytes(0x20, None, Some([45.0, 10.0]), 1)
        );
        sim.app
            .world_mut()
            .run_system_once(azalea::movement::send_position)
            .unwrap();
        sent.expect_empty();
    }
}

#[test]
fn world_changes_reset_periodic_flag_history() {
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, _) = simulation(mode);
        let common = default_login_packet().common;
        for transition in [
            azalea::test_utils::simulation::make_basic_respawn_packet(
                common.dimension_type,
                common.dimension,
            )
            .into_variant(),
            default_login_packet().into_variant(),
        ] {
            sim.with_component_mut::<azalea::movement::LastSentMovementFlags>(|last| {
                last.0.on_ground = true;
                last.0.horizontal_collision = true;
            });
            sim.receive_packet(transition);
            sim.update();
            assert_eq!(
                sim.component::<azalea::movement::LastSentMovementFlags>().0,
                Default::default()
            );
        }
    }
}

#[test]
fn malformed_cosmetic_server_data_does_not_interrupt_controls_in_either_reader() {
    for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
        let (mut sim, sent) = simulation(mode);
        // Packet 0x56 from the reported log, including an incomplete packet and
        // a valid NBT compound with no supported text component.
        for bytes in [vec![0x56], vec![0x56, 10, 0, 0]] {
            match mode {
                JavaNetworkMode::Optimized => {
                    let mut filter = crate::afk_network::ItemFilter::default();
                    assert!(crate::afk_network::process_single_packet(
                        sim.app.world_mut(), sim.entity, &bytes, &mut filter,
                    ).is_ok(), "cosmetic NBT must not become a read error");
                }
                JavaNetworkMode::Standard => {
                    assert!(azalea::connection::handle_raw_packet(
                        sim.app.world_mut(), &bytes, sim.entity, ConnectionProtocol::Game,
                        &mut Default::default(),
                    ).is_ok(), "cosmetic NBT must not become a read error");
                }
            }
            receive_wire(&mut sim, bytes);
            receive_wire(&mut sim, vec![0x2c, 0, 0, 0, 0, 0, 0, 0, 42]);
            assert_eq!(wire(&sent.next().unwrap()), [0x1c, 0, 0, 0, 0, 0, 0, 0, 42]);
            sent.expect_empty();
        }
    }
}
