//! Persistent mouse input. Only a settings change releases a held button.
use azalea::{Client, InGameState};
use azalea::core::{direction::Direction, hit_result::HitResult};
use azalea::entity::{inventory::Inventory, metadata::AbstractLivingUsingItem};
use azalea::interact::StartUseItemQueued;
use azalea::mining::{LeftClickMine, StopMiningBlockEvent};
use azalea::packet::game::SendGamePacketEvent;
use azalea::protocol::packets::game::{s_interact::InteractionHand, s_player_action::{Action, ServerboundPlayerAction}};
use crate::protocol::AutoButton;

#[derive(Default)]
pub struct HeldButton {
    applied: AutoButton,
    use_requested: bool,
    use_delay: u8,
}

#[cfg(test)]
mod tests {
    use super::*;
    use azalea::ecs::{prelude::*, world::World};
    use azalea::protocol::packets::game::ServerboundGamePacket;
    use parking_lot::{Mutex, RwLock};
    use std::sync::Arc;

    #[test]
    fn held_input_survives_unloaded_worlds_and_only_settings_changes_release_use() {
        let mut world = World::new();
        let entity = world.spawn((InGameState, Inventory::default())).id();
        let releases = Arc::new(Mutex::new(0));
        let captured = releases.clone();
        world.add_observer(move |event: On<SendGamePacketEvent>| {
            if let ServerboundGamePacket::PlayerAction(action) = &event.packet {
                if action.action == Action::ReleaseUseItem { *captured.lock() += 1; }
            }
        });
        let bot = Client { entity, ecs: Arc::new(RwLock::new(world)) };
        let mut held = HeldButton::default();
        held.tick(&bot, AutoButton::Right, true);
        assert!(bot.component::<StartUseItemQueued>().is_ok());
        bot.ecs.write().entity_mut(entity).remove::<StartUseItemQueued>()
            .insert(AbstractLivingUsingItem(true));
        for _ in 0..100 { held.tick(&bot, AutoButton::Right, true); }
        assert!(bot.component::<StartUseItemQueued>().is_err(), "ongoing item use must not be restarted");
        for _ in 0..100 { held.tick(&bot, AutoButton::Right, false); }
        assert_eq!(*releases.lock(), 0, "world loading must never release use");
        held.tick(&bot, AutoButton::Left, true);
        assert_eq!(*releases.lock(), 1);
        assert!(bot.component::<LeftClickMine>().is_ok());
        for _ in 0..100 { held.tick(&bot, AutoButton::Left, false); }
        assert!(bot.component::<LeftClickMine>().is_ok());
        bot.ecs.write().entity_mut(entity).remove::<LeftClickMine>();
        held.tick(&bot, AutoButton::Left, true);
        assert!(bot.component::<LeftClickMine>().is_ok(), "input removed during a world transition is restored");
        held.tick(&bot, AutoButton::Off, true);
        assert!(bot.component::<LeftClickMine>().is_err());
        assert!(bot.component::<StartUseItemQueued>().is_err());
    }
}

impl HeldButton {
    pub fn tick(&mut self, bot: &Client, mode: AutoButton, ready: bool) {
        if self.applied != mode {
            let mining = bot.is_mining();
            let mut ecs = bot.ecs.write();
            if let Ok(mut entity) = ecs.get_entity_mut(bot.entity) {
                entity.remove::<(LeftClickMine, StartUseItemQueued)>();
            }
            if self.applied == AutoButton::Left && mining {
                ecs.write_message(StopMiningBlockEvent { entity: bot.entity });
            }
            if self.applied == AutoButton::Right && self.use_requested && ecs.get::<InGameState>(bot.entity).is_some() {
                ecs.trigger(SendGamePacketEvent::new(bot.entity, ServerboundPlayerAction {
                    action: Action::ReleaseUseItem, pos: azalea::BlockPos::ZERO,
                    direction: Direction::Down, seq: 0,
                }));
            }
            self.applied = mode;
            self.use_requested = false;
            self.use_delay = 0;
        }
        if !ready || mode == AutoButton::Off { return; }
        // An open menu consumes gameplay clicks, but never changes the desired
        // held input. It resumes in-world automatically once the menu closes.
        if bot.component::<Inventory>().is_ok_and(|inventory| inventory.id != 0) { return; }
        match mode {
            AutoButton::Left => {
                if bot.component::<LeftClickMine>().is_err() { bot.left_click_mine(true); }
                if let Ok(HitResult::Entity(target)) = bot.hit_result() {
                    if !bot.has_attack_cooldown() { bot.attack(target.entity); }
                }
            }
            AutoButton::Right => {
                self.use_delay = self.use_delay.saturating_sub(1);
                if self.use_delay == 0 && !bot.component::<AbstractLivingUsingItem>().is_ok_and(|using| using.0) {
                    bot.ecs.write().entity_mut(bot.entity).insert(StartUseItemQueued {
                        hand: InteractionHand::MainHand, force_block: None,
                    });
                    self.use_requested = true;
                    self.use_delay = 4; // Vanilla's held-use delay, not a release.
                }
            }
            AutoButton::Off => {}
        }
    }
}
