//! Preserve failure-message tooltips before Azalea discards their NBT styling.

use std::io::Cursor;

use azalea::{buf::AzBufVar, FormattedText};
use simdnbt::{
    borrow::{NbtCompound, NbtList, NbtTag},
    FromNbtTag,
};

const MAX_PACKET_BYTES: usize = 128 * 1024;
const MAX_TEXT_CHARS: usize = 1024;
const MAX_DEPTH: usize = 16;
const MAX_NODES: usize = 256;

/// Only call for packets whose first field is an NBT text component, after
/// checking for a trusted server-loss announcement or game/config disconnect.
/// Login disconnects use JSON rather than this NBT format.
pub(crate) fn packet_tooltip(raw: &[u8]) -> String {
    let extract = || {
        if raw.len() > MAX_PACKET_BYTES {
            return None;
        }
        let mut stream = Cursor::new(raw);
        u32::azalea_read_var(&mut stream).ok()?;
        let Some(nbt) = simdnbt::borrow::read_optional_tag(&mut stream).ok()? else {
            return Some(Vec::new());
        };
        // The normal chat parser ignores hover data, so check its depth/size
        // before passing that previously unparsed subtree to the text renderer.
        let mut remaining = MAX_NODES;
        if !bounded_tag(nbt.as_tag(), 0, &mut remaining) {
            return None;
        }
        let mut texts = Vec::new();
        collect_tag(nbt.as_tag(), &mut texts);
        Some(texts)
    };
    match extract() {
        None => "Zusatztext konnte nicht gelesen werden".into(),
        Some(texts) if texts.is_empty() => "kein Textzusatz in dieser Servermeldung".into(),
        Some(texts) => texts.join(" | ").chars().take(MAX_TEXT_CHARS).collect(),
    }
}

fn bounded_tag(tag: NbtTag<'_, '_>, depth: usize, remaining: &mut usize) -> bool {
    if let Some(compound) = tag.compound() {
        return bounded_compound(compound, depth, remaining);
    }
    if let Some(list) = tag.list() {
        return bounded_list(list, depth, remaining);
    }
    if depth > MAX_DEPTH || *remaining == 0 {
        return false;
    }
    *remaining -= 1;
    true
}

fn bounded_compound(compound: NbtCompound<'_, '_>, depth: usize, remaining: &mut usize) -> bool {
    if depth > MAX_DEPTH || *remaining == 0 {
        return false;
    }
    *remaining -= 1;
    compound
        .iter()
        .all(|(_, child)| bounded_tag(child, depth + 1, remaining))
}

fn bounded_list(list: NbtList<'_, '_>, depth: usize, remaining: &mut usize) -> bool {
    if depth > MAX_DEPTH || *remaining == 0 {
        return false;
    }
    *remaining -= 1;
    if let Some(compounds) = list.compounds() {
        return compounds
            .into_iter()
            .all(|compound| bounded_compound(compound, depth + 1, remaining));
    }
    if let Some(lists) = list.lists() {
        return lists
            .into_iter()
            .all(|list| bounded_list(list, depth + 1, remaining));
    }
    true
}

fn collect_tag(tag: NbtTag<'_, '_>, texts: &mut Vec<String>) {
    if let Some(compound) = tag.compound() {
        collect_compound(compound, texts);
    } else if let Some(list) = tag.list() {
        collect_list(list, texts);
    }
}

fn collect_list(list: NbtList<'_, '_>, texts: &mut Vec<String>) {
    if let Some(compounds) = list.compounds() {
        for compound in compounds {
            collect_compound(compound, texts);
        }
    } else if let Some(lists) = list.lists() {
        for list in lists {
            collect_list(list, texts);
        }
    }
}

fn collect_compound(compound: NbtCompound<'_, '_>, texts: &mut Vec<String>) {
    for key in ["hover_event", "hoverEvent"] {
        if let Some(hover) = compound.compound(key) {
            if hover
                .string("action")
                .is_some_and(|action| action.to_str() == "show_text")
            {
                if let Some(value) = hover.get("value").or_else(|| hover.get("contents")) {
                    if let Some(text) = FormattedText::from_nbt_tag(value) {
                        let text: String = text
                            .to_string()
                            .chars()
                            .take(MAX_TEXT_CHARS)
                            .map(|c| {
                                if c.is_control() || c.is_whitespace() {
                                    ' '
                                } else {
                                    c
                                }
                            })
                            .collect();
                        let text = text.trim().to_owned();
                        if !text.is_empty() && !texts.contains(&text) {
                            texts.push(text);
                        }
                    } else {
                        let text = "Zusatztext konnte nicht gelesen werden".to_owned();
                        if !texts.contains(&text) {
                            texts.push(text);
                        }
                    }
                }
            }
        }
    }
    // Tooltips may belong to a nested visible component or translation arg.
    // Click commands, item NBT and entity metadata are not failure details.
    for key in ["extra", "with", ""] {
        if let Some(child) = compound.get(key) {
            collect_tag(child, texts);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use simdnbt::owned::{BaseNbt, NbtCompound};

    fn packet(content: NbtCompound) -> Vec<u8> {
        let mut raw = vec![0]; // Packet ID; callers check the packet kind.
        BaseNbt::new("", content).write_unnamed(&mut raw);
        raw
    }

    fn tooltip(key: &str, value_key: &str, text: &str) -> NbtCompound {
        let mut hover = NbtCompound::new();
        hover.insert("action", "show_text");
        hover.insert(value_key, text);
        let mut content = NbtCompound::new();
        content.insert("text", "fallback");
        content.insert(key, hover);
        content
    }

    #[test]
    fn nested_legacy_and_modern_tooltips_are_flattened_and_deduplicated() {
        let mut content = NbtCompound::new();
        content.insert("text", "fallback");
        content.insert(
            "extra",
            vec![tooltip("hover_event", "value", "Kick: timed out")],
        );
        content.insert(
            "with",
            vec![tooltip("hoverEvent", "contents", "Kick: timed out")],
        );
        assert_eq!(packet_tooltip(&packet(content)), "Kick: timed out");
    }

    #[test]
    fn click_and_item_metadata_do_not_become_server_failure_details() {
        let mut event = NbtCompound::new();
        event.insert("action", "show_item");
        event.insert("value", "irrelevant item data");
        let mut content = NbtCompound::new();
        content.insert("text", "fallback");
        content.insert("hover_event", event.clone());
        event.insert("action", "run_command");
        event.insert("value", "/some-command");
        content.insert("click_event", event);
        assert_eq!(
            packet_tooltip(&packet(content)),
            "kein Textzusatz in dieser Servermeldung"
        );
    }

    #[test]
    fn malformed_deep_and_large_details_are_bounded() {
        assert_eq!(
            packet_tooltip(&[0, 0]),
            "kein Textzusatz in dieser Servermeldung"
        );
        let long = format!("{}\n{}", "ä".repeat(700), "b".repeat(700));
        let text = packet_tooltip(&packet(tooltip("hover_event", "value", &long)));
        assert_eq!(text.chars().count(), MAX_TEXT_CHARS);
        assert!(!text.contains('\n'));
        let mut content = tooltip("hover_event", "value", "nested reason");
        for _ in 0..24 {
            let mut outer = NbtCompound::new();
            outer.insert("text", "");
            outer.insert("extra", vec![content]);
            content = outer;
        }
        assert_eq!(
            packet_tooltip(&packet(content)),
            "Zusatztext konnte nicht gelesen werden"
        );
        assert_eq!(
            packet_tooltip(&[0, 10]),
            "Zusatztext konnte nicht gelesen werden"
        );
        assert_eq!(
            packet_tooltip(&vec![0; MAX_PACKET_BYTES + 1]),
            "Zusatztext konnte nicht gelesen werden"
        );
    }
}
