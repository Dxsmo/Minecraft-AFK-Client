//! Independent wire fixtures audited against Mojang's official 26.2 client.
//! See vendor/README.md for the reference JAR, methods and reproduction steps.

use azalea::ecs::system::RunSystemOnce;
use azalea::entity::{HasClientLoaded, LookDirection, Physics, Position};
use azalea::protocol::packets::{game::*, ConnectionProtocol, Packet, PROTOCOL_VERSION};
use azalea::protocol::write::serialize_packet;
use azalea::test_utils::simulation::{default_login_packet, SentPackets, Simulation};

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
