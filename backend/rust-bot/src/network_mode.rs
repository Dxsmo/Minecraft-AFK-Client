//! Select one network reader while retaining the same protocol and client plugins.

use azalea::app::{PluginGroup, PluginGroupBuilder};

use crate::{afk_network::AfkNetworkPlugin, protocol::JavaNetworkMode};

pub(crate) fn client_plugins(mode: JavaNetworkMode) -> PluginGroupBuilder {
    let plugins = azalea::DefaultPlugins.build();
    match mode {
        JavaNetworkMode::Optimized => plugins
            .disable::<azalea::connection::ConnectionPlugin>()
            .add(AfkNetworkPlugin),
        JavaNetworkMode::Standard => plugins,
    }
}

pub(crate) fn startup_message(mode: JavaNetworkMode) -> &'static str {
    match mode {
        JavaNetworkMode::Optimized => "AFK-Netzwerk aktiv: Item-Pakete vor Dekodierung gefiltert, separate Limits für Item-Fluten und Spielaktionen",
        JavaNetworkMode::Standard => "Java-Netzwerk: Standardmodus (Azalea), AFK-Paketfilter deaktiviert",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use azalea::entity::{inventory::Inventory, EntityKindComponent};
    use azalea::protocol::packets::{game::*, ConnectionProtocol};
    use azalea::registry::builtin::{EntityKind, ItemKind};
    use azalea::test_utils::simulation::{
        default_login_packet, make_basic_add_entity, SentPackets, Simulation,
    };
    use azalea_inventory::ItemStack;

    #[test]
    fn standard_preserves_items_and_both_modes_process_inventory_and_control_packets() {
        for mode in [JavaNetworkMode::Optimized, JavaNetworkMode::Standard] {
            let mut sim =
                Simulation::new_with_plugins(ConnectionProtocol::Game, client_plugins(mode));
            sim.receive_packet(default_login_packet());
            sim.tick();
            let sent = SentPackets::new(&mut sim);
            sim.receive_packet(make_basic_add_entity(
                EntityKind::Item,
                12,
                azalea::Vec3::ZERO,
            ));
            sim.receive_packet(ClientboundContainerSetSlot {
                container_id: 0,
                state_id: 5,
                slot: 9,
                item_stack: ItemStack::new(ItemKind::Beef, 64),
            });
            sim.receive_packet(ClientboundKeepAlive { id: 123 });
            sim.receive_packet(ClientboundPing { id: 44 });
            sim.tick();
            let world = sim.app.world_mut();
            let items = world
                .query::<&EntityKindComponent>()
                .iter(world)
                .filter(|kind| ***kind == EntityKind::Item)
                .count();
            assert_eq!(items, usize::from(mode == JavaNetworkMode::Standard));
            assert_eq!(
                world
                    .get::<Inventory>(sim.entity)
                    .unwrap()
                    .inventory_menu
                    .slot(9)
                    .unwrap()
                    .count(),
                64
            );
            let mut keepalives = Vec::new();
            let mut pongs = Vec::new();
            while let Some(packet) = sent.next() {
                match packet {
                    ServerboundGamePacket::KeepAlive(p) => keepalives.push(p.id),
                    ServerboundGamePacket::Pong(p) => pongs.push(p.id),
                    _ => {}
                }
            }
            assert_eq!(keepalives, [123]);
            assert_eq!(pongs, [44]);
        }
    }

    #[test]
    fn old_configs_default_to_optimized_and_explicit_standard_is_accepted() {
        let mut json = serde_json::json!({
            "host": "localhost", "port": 25565, "auth_type": "offline",
            "username": "Bot", "cache_dir": "",
        });
        let config: crate::protocol::Config = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(config.java_network_mode, JavaNetworkMode::Optimized);
        json["java_network_mode"] = "standard".into();
        let config: crate::protocol::Config = serde_json::from_value(json).unwrap();
        assert_eq!(config.java_network_mode, JavaNetworkMode::Standard);
    }
}
