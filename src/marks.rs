//! Compact provider marks and the vertical quota meter as generated
//! SVG. Both marks
//! are original geometry rather than vendor logos: a warm six-ray bloom for
//! Claude and a teal six-node neural ring for Codex.
//!
//! iced hashes SVG bytes into the handle id, so identical output is
//! rasterized once and cached by the renderer; regenerating these small
//! strings on every view is a few hundred bytes of formatting.

use cosmic::iced::Color;
use cosmic::iced::widget::svg::Handle;

/// Logical footprint of a mark (§3.1: 16 px symbolic-icon size).
pub const MARK_SIZE: f32 = 16.0;
/// Logical footprint of the vertical meter beside a mark.
pub const METER_WIDTH: f32 = 9.0;
pub const METER_HEIGHT: f32 = 16.0;

/// Original warm bloom evoking Claude; original teal ring evoking Codex.
pub const CLAUDE_COLOR: Color = Color::from_rgb(
    0xd9 as f32 / 255.0,
    0x77 as f32 / 255.0,
    0x57 as f32 / 255.0,
);
pub const CODEX_COLOR: Color = Color::from_rgb(
    0x10 as f32 / 255.0,
    0xa3 as f32 / 255.0,
    0x7f as f32 / 255.0,
);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Mark {
    Claude,
    Codex,
}

fn hex(color: Color) -> String {
    let channel = |c: f32| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!(
        "#{:02x}{:02x}{:02x}",
        channel(color.r),
        channel(color.g),
        channel(color.b)
    )
}

fn rays() -> String {
    let center = MARK_SIZE / 2.0;
    let inner = MARK_SIZE * 0.11;
    let outer = MARK_SIZE * 0.39;
    let mut path = String::new();
    for i in 0..6 {
        let angle = i as f32 * std::f32::consts::PI / 3.0;
        let (sin, cos) = angle.sin_cos();
        path.push_str(&format!(
            "M{:.3} {:.3}L{:.3} {:.3}",
            center + cos * inner,
            center + sin * inner,
            center + cos * outer,
            center + sin * outer
        ));
    }
    path
}

fn ring_nodes() -> String {
    let center = MARK_SIZE / 2.0;
    let ring = MARK_SIZE * 0.29;
    let node = MARK_SIZE * 0.072;
    let mut circles = String::new();
    for i in 0..6 {
        let angle = i as f32 * std::f32::consts::PI / 3.0 - std::f32::consts::FRAC_PI_2;
        let (sin, cos) = angle.sin_cos();
        circles.push_str(&format!(
            r#"<circle cx="{:.3}" cy="{:.3}" r="{:.3}"/>"#,
            center + cos * ring,
            center + sin * ring,
            node
        ));
    }
    circles
}

/// A provider mark in `color`, dimmed to `opacity` for the stale and
/// unavailable states (§3.3: whole pair at 55%).
pub fn mark_svg(mark: Mark, color: Color, opacity: f32) -> String {
    let center = MARK_SIZE / 2.0;
    let fill = hex(color);
    let body = match mark {
        Mark::Claude => format!(
            r#"<path d="{}" stroke="{fill}" stroke-width="{:.3}" stroke-linecap="round" fill="none"/><circle cx="{center}" cy="{center}" r="{:.3}" fill="{fill}"/>"#,
            rays(),
            MARK_SIZE * 0.145,
            MARK_SIZE * 0.09
        ),
        Mark::Codex => format!(
            r#"<circle cx="{center}" cy="{center}" r="{:.3}" stroke="{fill}" stroke-width="{:.3}" fill="none"/><g fill="{fill}">{}<circle cx="{center}" cy="{center}" r="{:.3}"/></g>"#,
            MARK_SIZE * 0.29,
            MARK_SIZE * 0.085,
            ring_nodes(),
            MARK_SIZE * 0.075
        ),
    };
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {MARK_SIZE} {MARK_SIZE}" width="{MARK_SIZE}" height="{MARK_SIZE}"><g opacity="{opacity:.2}">{body}</g></svg>"#
    )
}

/// The §3.1 vertical meter: a low-opacity track filled from the bottom to
/// `percent` (whole percent, already bucketed) in `color`; `None` draws the
/// unavailable slash instead of any fill. Never a fabricated 0%.
pub fn meter_svg(percent: Option<u8>, color: Color, opacity: f32) -> String {
    let fill = hex(color);
    let inset = (METER_WIDTH * 0.14).max(1.0);
    let (x, y) = (inset, inset);
    let w = METER_WIDTH - 2.0 * inset;
    let h = METER_HEIGHT - 2.0 * inset;
    let radius = (w / 2.0).min(inset * 1.35);
    let mut body = format!(
        r#"<rect x="{x:.3}" y="{y:.3}" width="{w:.3}" height="{h:.3}" rx="{radius:.3}" fill="{fill}" fill-opacity="0.4"/>"#
    );
    match percent {
        Some(p) if p > 0 => {
            let fill_height = (h * f32::from(p.min(100)) / 100.0).max(2.0);
            let rx = radius.min(fill_height / 2.0);
            body.push_str(&format!(
                r#"<rect x="{x:.3}" y="{:.3}" width="{w:.3}" height="{fill_height:.3}" rx="{rx:.3}" fill="{fill}"/>"#,
                y + h - fill_height
            ));
        }
        Some(_) => {}
        None => {
            body.push_str(&format!(
                r#"<path d="M{x:.3} {:.3}L{:.3} {:.3}" stroke="{fill}" stroke-width="{:.3}" stroke-linecap="round" fill="none"/>"#,
                y + h * 0.72,
                x + w,
                y + h * 0.28,
                (METER_WIDTH * 0.18).max(1.0)
            ));
        }
    }
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {METER_WIDTH} {METER_HEIGHT}" width="{METER_WIDTH}" height="{METER_HEIGHT}"><g opacity="{opacity:.2}">{body}</g></svg>"#
    )
}

pub fn mark_handle(mark: Mark, color: Color, opacity: f32) -> Handle {
    Handle::from_memory(mark_svg(mark, color, opacity).into_bytes())
}

pub fn meter_handle(percent: Option<u8>, color: Color, opacity: f32) -> Handle {
    Handle::from_memory(meter_svg(percent, color, opacity).into_bytes())
}

/// The 16 px symbolic app icon shipped under `data/icons/` for the panel
/// settings list: the bloom mark beside a half-full meter, in `currentColor`.
#[cfg(test)]
pub fn app_icon_svg() -> String {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><g transform="translate(-1.5 0)"><path d="{}" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" fill="none"/><circle cx="8" cy="8" r="1.44"/></g><rect x="12" y="1" width="3.5" height="14" rx="1.5" fill-opacity="0.4"/><rect x="12" y="8" width="3.5" height="7" rx="1.5"/></svg>"#,
        rays()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meter_fill_grows_with_percent_and_unavailable_draws_a_slash() {
        let empty = meter_svg(Some(0), Color::WHITE, 1.0);
        assert_eq!(empty.matches("<rect").count(), 1, "{empty}");
        assert!(!empty.contains("<path"));
        let half = meter_svg(Some(50), Color::WHITE, 1.0);
        assert_eq!(half.matches("<rect").count(), 2);
        assert!(half.contains(r#"height="6.740""#), "{half}");
        let full = meter_svg(Some(100), Color::WHITE, 1.0);
        assert!(full.contains(r#"height="13.480""#), "{full}");
        let unavailable = meter_svg(None, Color::WHITE, 0.55);
        assert_eq!(unavailable.matches("<rect").count(), 1);
        assert!(unavailable.contains("<path"));
        assert!(unavailable.contains(r#"opacity="0.55""#));
    }

    #[test]
    fn marks_carry_their_colors_and_differ() {
        let claude = mark_svg(Mark::Claude, CLAUDE_COLOR, 1.0);
        let codex = mark_svg(Mark::Codex, CODEX_COLOR, 1.0);
        assert!(claude.contains("#d97757"), "{claude}");
        assert!(codex.contains("#10a37f"), "{codex}");
        assert_ne!(claude, codex);
        assert_eq!(codex.matches("<circle").count(), 8);
    }

    #[test]
    fn identical_input_yields_identical_handles() {
        let a = meter_handle(Some(42), CLAUDE_COLOR, 1.0);
        let b = meter_handle(Some(42), CLAUDE_COLOR, 1.0);
        assert_eq!(a.id(), b.id());
        assert_ne!(a.id(), meter_handle(Some(43), CLAUDE_COLOR, 1.0).id());
    }

    #[test]
    fn app_icon_matches_the_shipped_file() {
        let shipped = include_str!(
            "../data/icons/io.github.illyayalovyy.cosmic-ext-applet-claudometer-symbolic.svg"
        );
        assert_eq!(shipped.trim(), app_icon_svg());
    }
}
