use azalea_inventory::components::{CustomName, ItemName, Lore};
use azalea_inventory::{ItemStack, Menu};

use crate::protocol::SellMultiplier;

pub fn plain_text(text: &str) -> String {
    let mut chars = text.chars();
    let mut plain = String::new();
    while let Some(c) = chars.next() {
        if c == '§' {
            chars.next();
        } else {
            plain.push(c);
        }
    }
    plain
}

pub fn menu_title(title: &str) -> bool {
    plain_text(title)
        .split_whitespace()
        .collect::<String>()
        .eq_ignore_ascii_case("sellmulti")
}

pub fn chest_menu(menu: &Menu) -> bool {
    matches!(
        menu,
        Menu::Generic9x1 { .. }
            | Menu::Generic9x2 { .. }
            | Menu::Generic9x3 { .. }
            | Menu::Generic9x4 { .. }
            | Menu::Generic9x5 { .. }
            | Menu::Generic9x6 { .. }
    )
}

fn labelled<'a>(line: &'a str, labels: &[&str]) -> Option<&'a str> {
    labels.iter().find_map(|label| {
        let prefix = line.get(..label.len())?;
        if !prefix.eq_ignore_ascii_case(label) {
            return None;
        }
        let rest = line.get(label.len()..)?.trim_start();
        Some(rest.strip_prefix(':').unwrap_or(rest).trim())
    })
}

fn tooltip(name: &str, lore: &[String]) -> Option<SellMultiplier> {
    let name = plain_text(name)
        .replace(['\r', '\n'], " ")
        .trim()
        .to_string();
    if name.is_empty() || name.chars().count() > 256 {
        return None;
    }
    let lines: Vec<String> = lore
        .iter()
        .map(|line| {
            plain_text(line)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect();
    let progress = read_progress(&lines)?;
    for line in &lines {
        let Some(value) = labelled(line, &["Aktueller Multiplikator", "Current multiplier"]) else {
            continue;
        };
        let value = value.trim();
        let Some(number) = value.strip_suffix(['x', 'X', '×']) else {
            continue;
        };
        let pieces: Vec<_> = number.split(['.', ',']).collect();
        if value.len() > 32
            || pieces.len() > 2
            || pieces
                .iter()
                .any(|part| part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()))
        {
            continue;
        }
        return Some(SellMultiplier {
            name,
            multiplier: value.to_string(),
            progress,
        });
    }
    None
}

fn amount(input: &str) -> Option<(String, &str)> {
    let input = input.trim_start();
    let input = input.strip_prefix('$').unwrap_or(input).trim_start();
    if !input.chars().next()?.is_ascii_digit() {
        return None;
    }
    let end = input
        .char_indices()
        .find(|(_, c)| !c.is_ascii_digit() && *c != '.' && *c != ',')
        .map(|(index, _)| index)
        .unwrap_or(input.len());
    let number = &input[..end];
    if number.len() > 32 {
        return None;
    }
    let rest = input[end..].trim_start();
    Some((
        number.to_string(),
        rest.strip_prefix('$').unwrap_or(rest).trim(),
    ))
}

fn money(input: &str) -> Option<f64> {
    let pieces: Vec<_> = input.split(['.', ',']).collect();
    if pieces
        .iter()
        .any(|piece| piece.is_empty() || !piece.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let normalized = match (input.rfind('.'), input.rfind(',')) {
        (Some(dot), Some(comma)) => {
            let decimal = dot.max(comma);
            format!(
                "{}.{}",
                input[..decimal].replace(['.', ','], ""),
                &input[decimal + 1..]
            )
        }
        _ if pieces.len() > 1 && pieces[1..].iter().all(|piece| piece.len() == 3) => {
            pieces.join("")
        }
        _ => input.replace(',', "."),
    };
    let value = normalized.parse::<f64>().ok()?;
    value.is_finite().then_some(value)
}

fn percentage(line: &str) -> Option<String> {
    let prefix = line[..line.find('%')?].trim_end();
    let reverse: String = prefix
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
        .collect();
    let text: String = reverse.chars().rev().collect();
    if text.is_empty() || text.len() > 10 {
        return None;
    }
    let value = text.replace(',', ".").parse::<f64>().ok()?;
    (value.is_finite() && (0.0..=100.0).contains(&value)).then_some(text)
}

fn read_progress(lines: &[String]) -> Option<String> {
    for (index, line) in lines.iter().enumerate() {
        let Some(value) = labelled(line, &["Fortschritt", "Progress"]) else {
            continue;
        };
        let Some((left, right)) = value.split_once('/') else {
            continue;
        };
        let Some((current_text, rest)) = amount(left) else {
            continue;
        };
        if !rest.is_empty() {
            continue;
        }
        let Some((target_text, trailing)) = amount(right) else {
            continue;
        };
        let (Some(current), Some(target)) = (money(&current_text), money(&target_text)) else {
            continue;
        };
        let following = lines[index + 1..]
            .iter()
            .find(|line| !line.is_empty())
            .map(String::as_str)
            .unwrap_or("");
        // The GUI's percentage is authoritative; rounded amounts may differ.
        let percent = percentage(trailing)
            .or_else(|| percentage(following))
            .or_else(|| {
                (target > 0.0)
                    .then(|| format!("{:.0}", (current / target * 100.0).min(100.0).floor()))
            });
        if let Some(percent) = percent {
            return Some(format!("{current_text}$/{target_text}$ - {percent}%"));
        }
    }
    None
}

/** Never read the bottom GUI row or the appended player inventory. */
pub fn read_top_row(slots: &[ItemStack]) -> Option<Vec<SellMultiplier>> {
    if !(45..=90).contains(&slots.len()) || slots.len() % 9 != 0 {
        return None;
    }
    slots[..9]
        .iter()
        .map(|stack| {
            let (name, lore) = item_tooltip(stack);
            tooltip(&name, &lore)
        })
        .collect()
}

pub fn has_multiplier_tooltip(slots: &[ItemStack]) -> bool {
    slots.iter().take(9).any(|stack| {
        let (name, lore) = item_tooltip(stack);
        tooltip(&name, &lore).is_some()
    })
}

fn item_tooltip(stack: &ItemStack) -> (String, Vec<String>) {
    if !stack.is_present() {
        return (String::new(), vec![]);
    }
    let name = stack
        .get_component::<CustomName>()
        .map(|name| name.name.to_string())
        .or_else(|| {
            stack
                .get_component::<ItemName>()
                .map(|name| name.name.to_string())
        })
        .unwrap_or_default();
    let lore = stack
        .get_component::<Lore>()
        .map(|lore| lore.lines.iter().map(|line| line.to_string()).collect())
        .unwrap_or_default();
    (name, lore)
}

pub fn bounded_text(text: &str) -> String {
    plain_text(text)
        .replace(['\r', '\n'], " ")
        .chars()
        .take(160)
        .collect()
}

/// One bounded diagnostic per failed request, including the first unreadable
/// tooltip. Resource-pack glyphs cannot be reconstructed from a visible title.
pub fn describe_top_row(slots: &[ItemStack]) -> String {
    let tooltips: Vec<_> = slots.iter().take(9).map(item_tooltip).collect();
    let readable = tooltips
        .iter()
        .filter(|(name, lore)| tooltip(name, lore).is_some())
        .count();
    let first = tooltips
        .iter()
        .enumerate()
        .find(|(_, (name, lore))| tooltip(name, lore).is_none());
    let detail = first
        .map(|(index, (name, lore))| {
            format!(
                "; Slot {}: Name {:?}, Lore {:?}",
                index + 1,
                bounded_text(name),
                lore.iter()
                    .take(6)
                    .map(|line| bounded_text(line))
                    .collect::<Vec<_>>()
            )
        })
        .unwrap_or_default();
    format!(
        "{} GUI-Slots; Tooltips vollständig {readable}/9{detail}",
        slots.len().saturating_sub(36)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_tooltip_labels_without_colons_and_reports_unreadable_slots() {
        assert_eq!(
            tooltip(
                "Fische",
                &[
                    "§7Aktueller\u{a0}Multiplikator §a1x".into(),
                    "§7Fortschritt $3.695 / $20.000".into(),
                    "████░░░ 18%".into(),
                ]
            )
            .unwrap()
            .progress,
            "3.695$/20.000$ - 18%"
        );
        let mut slots = vec![ItemStack::Empty; 54];
        slots[0] = ItemStack::new(azalea::registry::builtin::ItemKind::Cod, 1)
            .with_component(CustomName {
                name: "Fische".into(),
            })
            .with_component(Lore {
                lines: vec!["Aktueller Multiplikator: 1x".into()],
            });
        let description = describe_top_row(&slots);
        assert!(description.contains("18 GUI-Slots; Tooltips vollständig 0/9"));
        assert!(description.contains("Slot 1: Name \"Fische\""));
        assert!(description.contains("Aktueller Multiplikator: 1x"));
        assert_eq!(bounded_text(&"ä".repeat(500)).chars().count(), 160);
        assert!(read_top_row(&slots[..9]).is_none());
    }

    #[test]
    fn parses_the_screenshot_and_coloured_decimals_with_progress() {
        let result = tooltip(
            "§dFische",
            &[
                "§7Aktueller Multiplikator: §a1x".into(),
                "Fortschritt: $3.695 / $20.000".into(),
                "§e████§8░░░░░░░░░░░░ 18%".into(),
            ],
        )
        .unwrap();
        assert_eq!(result.name, "Fische");
        assert_eq!(result.multiplier, "1x");
        assert_eq!(result.progress, "3.695$/20.000$ - 18%");
        assert_eq!(
            tooltip(
                "Erze",
                &[
                    "Current multiplier: 2.5×".into(),
                    "Progress: 600$/800$ - 67%".into()
                ]
            )
            .unwrap()
            .multiplier,
            "2.5×"
        );
        assert_eq!(
            tooltip(
                "Erze",
                &[
                    "Aktueller Multiplikator: 1,5x".into(),
                    "Fortschritt: $600 / $800".into()
                ]
            )
            .unwrap()
            .multiplier,
            "1,5x"
        );
        assert!(tooltip("Fische", &["Fortschritt: 18%".into()]).is_none());
        assert!(tooltip("", &["Aktueller Multiplikator: 1x".into()]).is_none());
        assert!(tooltip("Fische", &["Aktueller Multiplikator: ???".into()]).is_none());
        assert!(tooltip("Fische", &["Aktueller Multiplikator: 1x".into()]).is_none());
        assert_eq!(
            read_progress(&["Progress: 600$/800$ - 67%".into()]).as_deref(),
            Some("600$/800$ - 67%")
        );
        assert_eq!(
            read_progress(&["Fortschritt: $600 / $800".into()]).as_deref(),
            Some("600$/800$ - 75%")
        );
        assert_eq!(
            read_progress(&["Progress: $3,695 / $20,000".into()]).as_deref(),
            Some("3,695$/20,000$ - 18%")
        );
        assert_eq!(read_progress(&["Fortschritt: $0 / $0".into()]), None);
    }
}
