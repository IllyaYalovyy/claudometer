//! The applet: panel strip, popup, settings page, and the refresh driver
//! for timers, in-flight requests, and manual refreshes. Everything
//! shown comes from the pure models in `model.rs`; this file only maps them
//! onto libcosmic widgets and wires messages.
//!
//! Performance notes: fetches run as tokio tasks on the applet's executor
//! thread and never block the UI; the panel strip is a handful of tiny
//! SVGs that the renderer rasterizes once per distinct state; the 1 s
//! footer tick only exists while the popup is open.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use cosmic::app::Core;
use cosmic::applet::padded_control;
use cosmic::cosmic_config;
use cosmic::iced::alignment::{Horizontal, Vertical};
use cosmic::iced::widget::progress_bar;
use cosmic::iced::{
    Border, Color, Length, Limits, Subscription,
    platform_specific::shell::wayland::commands::popup::{destroy_popup, get_popup},
    time,
    window::Id,
};
use cosmic::widget;
use cosmic::{Action, Application, Element, Task};
use tokio::sync::Mutex;

use crate::config::{
    self, APP_ID, CRITICAL_PERCENT_MAX, CRITICAL_PERCENT_MIN, REFRESH_INTERVALS_SEC, Settings,
    TimeAppletConfig, WARNING_PERCENT_MAX, WARNING_PERCENT_MIN, refresh_interval_label,
};
use crate::marks::{self, CLAUDE_COLOR, CODEX_COLOR, MARK_SIZE, METER_HEIGHT, METER_WIDTH, Mark};
use crate::model::{self, Options, State, indicator_model, menu_model};
use crate::now_ms;
use crate::scheduler::{Backoff, Event, needs_refresh};
use crate::source::{FetchOutput, MultiSource, RefreshFailed, Snapshot};

/// §5: opening the popup refreshes if the last fetch is older than 15 s.
const OPEN_REFRESH_MAX_AGE_MS: i64 = 15_000;

/// §4.1: the viewport is fixed so data can never resize it.
const POPUP_WIDTH: f32 = 320.0;
const POPUP_MAX_HEIGHT: f32 = 640.0;
/// Height the scrolling body is capped at; the footer stays reachable below.
const MAX_BODY_HEIGHT: f32 = 500.0;

/// §3.1 geometry in logical pixels at the 16 px reference size.
const UNIT_GAP: f32 = 4.0;
const PROVIDER_GAP: f32 = 12.0;

/// Footer icons, bundled as original artwork so the popup does not depend on
/// whichever icon theme the panel can see.
const REFRESH_ICON: &[u8] = include_bytes!("../data/icons/refresh-symbolic.svg");
const SETTINGS_ICON: &[u8] = include_bytes!("../data/icons/settings-symbolic.svg");

/// §4.2: the bar track is the foreground at low opacity.
const TRACK_ALPHA: f32 = 0.25;
/// Secondary text (reset rows, notes, freshness) sits at 70% foreground.
const DIM_TEXT_ALPHA: f32 = 0.7;

#[derive(Debug, Clone)]
pub enum Message {
    TogglePopup,
    PopupClosed(Id),
    /// The background poll timer fired.
    Tick,
    /// The 1 s footer clock while the popup is open.
    FooterTick,
    Fetched(u64, FetchOutput),
    /// The §4.4 refresh button.
    RefreshNow,
    ToggleSettings,
    WarningChanged(u32),
    CriticalChanged(u32),
    IntervalSelected(u32),
    ReenableRefresh,
    /// The config store changed (our own write echoes back too).
    SettingsChanged(Settings),
    ClockFormatChanged(bool),
    Surface(cosmic::surface::Action),
}

pub struct Window {
    core: Core,
    popup: Option<Id>,
    settings_open: bool,

    config: Option<cosmic_config::Config>,
    settings: Settings,
    clock24: bool,
    /// The G1 tripwire latch, shared with the Claude source.
    refresh_disabled: Arc<AtomicBool>,

    source: Arc<Mutex<MultiSource>>,
    snapshot: Option<Snapshot>,
    /// Driver-side completion time of the last fetch (the §5 menu-open age).
    fetched_at: Option<i64>,
    last_refresh_failed: RefreshFailed,

    backoff: Backoff,
    /// Bumped to restart the poll timer from "now" (after each fetch and on
    /// cadence changes), so the next tick is one delay after completion.
    timer_epoch: u64,
    generation: u64,
    in_flight: bool,
    refetch_queued: bool,
    manual_queued: bool,
    manual_in_flight: bool,
}

impl Application for Window {
    type Executor = cosmic::SingleThreadExecutor;
    type Flags = ();
    type Message = Message;

    const APP_ID: &'static str = APP_ID;

    fn core(&self) -> &Core {
        &self.core
    }

    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }

    fn init(core: Core, _flags: Self::Flags) -> (Self, Task<Action<Message>>) {
        let config = config::open();
        let settings = config::load(config.as_ref());
        let refresh_disabled = Arc::new(AtomicBool::new(settings.refresh_path_disabled));
        let mut window = Window {
            core,
            popup: None,
            settings_open: false,
            clock24: config::load_clock24(),
            refresh_disabled: Arc::clone(&refresh_disabled),
            source: Arc::new(Mutex::new(MultiSource::new(refresh_disabled))),
            snapshot: None,
            fetched_at: None,
            last_refresh_failed: RefreshFailed::default(),
            backoff: Backoff::initial(settings.refresh_interval_seconds),
            timer_epoch: 0,
            generation: 0,
            in_flight: false,
            refetch_queued: false,
            manual_queued: false,
            manual_in_flight: false,
            settings,
            config,
        };
        // Honest pre-fetch rendering is the unavailable state (no snapshot),
        // never 0%; the first fetch lands right after start.
        let task = window.run_fetch();
        (window, task)
    }

    fn on_close_requested(&self, id: Id) -> Option<Message> {
        Some(Message::PopupClosed(id))
    }

    fn subscription(&self) -> Subscription<Message> {
        let mut subscriptions = vec![
            poll_timer(self.backoff.delay_sec, self.timer_epoch),
            cosmic_config::config_subscription::<u64, Settings>(
                0,
                APP_ID.into(),
                config::CONFIG_VERSION,
            )
            .map(|update| Message::SettingsChanged(update.config)),
            cosmic_config::config_subscription::<u64, TimeAppletConfig>(
                1,
                config::TIME_APPLET_ID.into(),
                1,
            )
            .map(|update| Message::ClockFormatChanged(update.config.military_time)),
        ];
        // §4.4: the freshness line live-updates only while the popup is open.
        if self.popup.is_some() {
            subscriptions.push(time::every(Duration::from_secs(1)).map(|_| Message::FooterTick));
        }
        Subscription::batch(subscriptions)
    }

    fn update(&mut self, message: Message) -> Task<Action<Message>> {
        match message {
            Message::TogglePopup => {
                if let Some(popup) = self.popup.take() {
                    return destroy_popup(popup);
                }
                let Some(parent) = self.core.main_window_id() else {
                    return Task::none();
                };
                self.settings_open = false;
                let new_id = Id::unique();
                self.popup.replace(new_id);
                let mut popup_settings = self
                    .core
                    .applet
                    .get_popup_settings(parent, new_id, None, None, None);
                popup_settings.positioner.size_limits = popup_limits();
                let mut tasks = vec![get_popup(popup_settings)];
                // §5: implicit refresh on open, not a manual one — the
                // sources' own gates decide any spawn and no spinner runs.
                if needs_refresh(self.fetched_at, now_ms(), OPEN_REFRESH_MAX_AGE_MS) {
                    tasks.push(self.run_fetch());
                }
                return Task::batch(tasks);
            }
            Message::PopupClosed(id) => {
                if Some(id) == self.popup {
                    self.popup = None;
                }
            }
            Message::Tick => {
                // A tick during a fetch is simply skipped; the next one comes.
                if !self.in_flight {
                    return self.run_fetch();
                }
            }
            Message::FooterTick => {}
            Message::Fetched(generation, output) => {
                if generation != self.generation {
                    return Task::none();
                }
                self.in_flight = false;
                self.manual_in_flight = false;
                let event = if output.snapshot.has_error() {
                    Event::Failure
                } else {
                    Event::Success
                };
                self.backoff = self.backoff.next(event);
                self.last_refresh_failed = output.last_refresh_failed;
                self.snapshot = Some(output.snapshot);
                self.fetched_at = Some(now_ms());
                // Persist the tripwire state across restarts.
                if output.claude_refresh_disabled && !self.settings.refresh_path_disabled {
                    self.settings.refresh_path_disabled = true;
                    config::save(self.config.as_ref(), &self.settings);
                }
                if self.refetch_queued {
                    self.refetch_queued = false;
                    return self.run_fetch();
                }
                self.timer_epoch += 1;
            }
            Message::RefreshNow => {
                if self.manual_pending() {
                    return Task::none();
                }
                // §6: manual refresh resets the backoff before the outcome.
                self.backoff = self.backoff.next(Event::Manual);
                self.manual_queued = true;
                return self.run_fetch();
            }
            Message::ToggleSettings => self.settings_open = !self.settings_open,
            Message::WarningChanged(value) => {
                let next = self.settings.clone().with_warning(value);
                self.apply_settings(next);
                config::save(self.config.as_ref(), &self.settings);
            }
            Message::CriticalChanged(value) => {
                let next = self.settings.clone().with_critical(value);
                self.apply_settings(next);
                config::save(self.config.as_ref(), &self.settings);
            }
            Message::IntervalSelected(seconds) => {
                let mut next = self.settings.clone();
                next.refresh_interval_seconds = seconds;
                self.apply_settings(next);
                config::save(self.config.as_ref(), &self.settings);
            }
            Message::ReenableRefresh => {
                let mut next = self.settings.clone();
                next.refresh_path_disabled = false;
                self.apply_settings(next);
                config::save(self.config.as_ref(), &self.settings);
            }
            Message::SettingsChanged(settings) => self.apply_settings(settings),
            Message::ClockFormatChanged(military) => self.clock24 = military,
            Message::Surface(action) => {
                return cosmic::task::message(cosmic::Action::Cosmic(
                    cosmic::app::Action::Surface(action),
                ));
            }
        }
        Task::none()
    }

    /// The panel strip: one mark + vertical meter per provider (§3.1).
    fn view(&self) -> Element<'_, Message> {
        let model = indicator_model(self.snapshot.as_ref(), now_ms(), &self.options());
        let horizontal = self.core.applet.is_horizontal();
        let (icon_size, _) = self.core.applet.suggested_size(true);
        let scale = f32::from(icon_size) / MARK_SIZE;
        let strip = self.strip(&model, scale, horizontal);

        let (pad_major, pad_minor) = self.core.applet.suggested_padding(true);
        let (hpad, vpad) = if horizontal {
            (pad_major, pad_minor)
        } else {
            (pad_minor, pad_major)
        };
        let button = widget::button::custom(strip)
            .padding([f32::from(vpad), f32::from(hpad)])
            .class(cosmic::theme::Button::AppletIcon)
            .on_press(Message::TogglePopup);
        // §8: the full story rides on the tooltip, independent of the meters.
        self.core
            .applet
            .applet_tooltip(
                button,
                model.accessible_name,
                self.popup.is_some(),
                Message::Surface,
                self.core.main_window_id(),
            )
            .into()
    }

    fn view_window(&self, _id: Id) -> Element<'_, Message> {
        let content = if self.settings_open {
            self.settings_view()
        } else {
            self.usage_view()
        };
        self.core
            .applet
            .popup_container(padded_control(content))
            .limits(popup_limits())
            .into()
    }

    /// Every COSMIC applet paints its surface transparent and lets
    /// `popup_container` draw the panel itself.
    fn style(&self) -> Option<cosmic::iced::theme::Style> {
        Some(cosmic::applet::style())
    }
}

impl Window {
    fn options(&self) -> Options {
        Options {
            warning_at: f64::from(self.settings.warning_percent),
            critical_at: f64::from(self.settings.critical_percent),
            stale_after_ms: self.settings.stale_after_ms(),
            clock24: self.clock24,
            last_refresh_failed: self.last_refresh_failed,
        }
    }

    /// True from an explicit user refresh until the fetch answering it
    /// delivers its snapshot — the refresh button's busy state (#20).
    fn manual_pending(&self) -> bool {
        self.manual_queued || self.manual_in_flight
    }

    /// Start a fetch unless one is running, in which case one more runs when
    /// it completes rather than racing two fetches.
    fn run_fetch(&mut self) -> Task<Action<Message>> {
        if self.in_flight {
            self.refetch_queued = true;
            return Task::none();
        }
        self.in_flight = true;
        let manual = std::mem::take(&mut self.manual_queued);
        self.manual_in_flight = manual;
        self.generation += 1;
        let generation = self.generation;
        let source = Arc::clone(&self.source);
        let now = now_ms();
        Task::perform(
            async move { source.lock().await.fetch(now, manual).await },
            move |output| Message::Fetched(generation, output).into(),
        )
    }

    /// §7: changes apply live. A cadence change rebases the backoff and
    /// restarts the timer; a tripwire change is mirrored into the source.
    fn apply_settings(&mut self, settings: Settings) {
        let settings = settings.normalized();
        if settings == self.settings {
            return;
        }
        if settings.refresh_interval_seconds != self.settings.refresh_interval_seconds {
            self.backoff = self.backoff.rebased(settings.refresh_interval_seconds);
            self.timer_epoch += 1;
        }
        if settings.refresh_path_disabled != self.settings.refresh_path_disabled {
            self.refresh_disabled
                .store(settings.refresh_path_disabled, Ordering::Relaxed);
        }
        self.settings = settings;
    }

    fn theme_colors(&self) -> ThemeColors {
        let theme = self.core.system_theme();
        let cosmic = theme.cosmic();
        ThemeColors {
            foreground: cosmic.background(theme.transparent).on.into(),
            accent: cosmic.accent_color().into(),
            warning: cosmic.warning_color().into(),
            destructive: cosmic.destructive_color().into(),
        }
    }

    /// The mark/meter pairs. Horizontal panels lay the pairs side by side;
    /// vertical panels stack each pair (mark over meter) and the pairs.
    fn strip<'a>(
        &self,
        model: &model::IndicatorModel,
        scale: f32,
        horizontal: bool,
    ) -> Element<'a, Message> {
        let colors = self.theme_colors();
        let units: Vec<Element<'a, Message>> = model
            .items
            .iter()
            .map(|item| {
                let mark = marks::mark_handle(item.mark, mark_color(item.mark), item.opacity);
                let meter = marks::meter_handle(
                    item.percent.map(|p| p.round().clamp(0.0, 100.0) as u8),
                    colors.meter(item.meter_state),
                    item.opacity,
                );
                let mark: Element<'a, Message> = widget::svg(mark)
                    .width(Length::Fixed(MARK_SIZE * scale))
                    .height(Length::Fixed(MARK_SIZE * scale))
                    .into();
                let meter: Element<'a, Message> = widget::svg(meter)
                    .width(Length::Fixed((METER_WIDTH * scale).round()))
                    .height(Length::Fixed(METER_HEIGHT * scale))
                    .into();
                if horizontal {
                    widget::Row::with_children(vec![mark, meter])
                        .spacing(UNIT_GAP * scale)
                        .align_y(Vertical::Center)
                        .into()
                } else {
                    widget::Column::with_children(vec![mark, meter])
                        .spacing(UNIT_GAP * scale)
                        .align_x(Horizontal::Center)
                        .into()
                }
            })
            .collect();
        if horizontal {
            widget::Row::with_children(units)
                .spacing(PROVIDER_GAP * scale)
                .align_y(Vertical::Center)
                .into()
        } else {
            widget::Column::with_children(units)
                .spacing(PROVIDER_GAP * scale)
                .align_x(Horizontal::Center)
                .into()
        }
    }

    /// The §4 dropdown: promoted lines, notice, grouped sections, footer.
    fn usage_view(&self) -> Element<'_, Message> {
        let model = menu_model(self.snapshot.as_ref(), now_ms(), &self.options());
        let colors = self.theme_colors();
        let dim = with_alpha(colors.foreground, DIM_TEXT_ALPHA);

        let mut body = widget::Column::new().spacing(0).width(Length::Fill);
        let mut blocks: Vec<Element<'_, Message>> = Vec::new();

        if !model.promoted.is_empty() {
            let mut promoted = widget::Column::new().spacing(4).padding([6, 0]);
            for line in &model.promoted {
                promoted = promoted.push(
                    widget::text::body(line.clone())
                        .class(cosmic::theme::Text::Color(colors.destructive))
                        .width(Length::Fill),
                );
            }
            blocks.push(promoted.into());
        }
        if let Some(notice) = &model.notice {
            blocks.push(
                widget::Column::new()
                    .spacing(4)
                    .padding([6, 0])
                    .push(widget::text::body(notice.headline.clone()).width(Length::Fill))
                    .push(
                        widget::text::body(notice.detail.clone())
                            .class(cosmic::theme::Text::Color(dim))
                            .width(Length::Fill),
                    )
                    .into(),
            );
        }
        for group in &model.groups {
            blocks.push(self.group_view(group, &colors, dim));
        }
        for (index, block) in blocks.into_iter().enumerate() {
            if index > 0 {
                body = body.push(widget::divider::horizontal::default());
            }
            body = body.push(block);
        }

        widget::Column::new()
            .spacing(8)
            .width(Length::Fill)
            .push(
                widget::container(widget::scrollable(body).spacing(8))
                    .max_height(MAX_BODY_HEIGHT)
                    .width(Length::Fill),
            )
            .push(widget::divider::horizontal::default())
            .push(self.footer(&model.footer, &colors, dim))
            .into()
    }

    fn group_view<'a>(
        &self,
        group: &model::Group,
        colors: &ThemeColors,
        dim: Color,
    ) -> Element<'a, Message> {
        let mark: Element<'a, Message> =
            widget::svg(marks::mark_handle(group.mark, mark_color(group.mark), 1.0))
                .width(Length::Fixed(MARK_SIZE))
                .height(Length::Fixed(MARK_SIZE))
                .into();
        let heading = widget::container(
            widget::Row::new()
                .spacing(6)
                .align_y(Vertical::Center)
                .push(mark)
                .push(widget::text::heading(group.title)),
        )
        .width(Length::Fill)
        .align_x(Horizontal::Center)
        .padding([6, 0, 2, 0]);

        let mut column = widget::Column::new().width(Length::Fill).push(heading);
        for section in &group.sections {
            if let Some(bucket) = &section.bucket_title {
                column = column.push(
                    widget::container(widget::text::heading(bucket.clone()).width(Length::Fill))
                        .padding([8, 0, 0, 0]),
                );
            }
            let track = with_alpha(colors.foreground, TRACK_ALPHA);
            let bar_row = widget::Row::new()
                .spacing(8)
                .align_y(Vertical::Center)
                .push(bar(section.percent, colors.bar(section.bar_state), track))
                .push(
                    widget::text::body(section.percent_text.clone())
                        .width(Length::Fixed(42.0))
                        .align_x(Horizontal::Right),
                );
            let mut block = widget::Column::new()
                .spacing(7)
                .width(Length::Fill)
                .padding([7, 0, 9, 0])
                .push(
                    widget::text::body(section.title.clone())
                        .font(cosmic::font::semibold())
                        .width(Length::Fill),
                )
                .push(bar_row);
            if let Some(reset) = &section.reset_text {
                block = block.push(
                    widget::text::body(reset.clone())
                        .class(cosmic::theme::Text::Color(dim))
                        .width(Length::Fill),
                );
            }
            column = column.push(block);
        }
        if let Some(note) = &group.note {
            column = column.push(
                widget::container(
                    widget::text::caption(note.clone())
                        .class(cosmic::theme::Text::Color(dim))
                        .width(Length::Fill),
                )
                .padding([2, 0, 7, 0]),
            );
        }
        column.into()
    }

    /// §4.4 footer: freshness left, refresh and settings buttons right.
    fn footer<'a>(
        &self,
        footer: &model::Footer,
        colors: &ThemeColors,
        dim: Color,
    ) -> Element<'a, Message> {
        let freshness = widget::text::caption(footer.freshness_text.clone())
            .class(cosmic::theme::Text::Color(if footer.stale {
                colors.warning
            } else {
                dim
            }))
            .width(Length::Fill);
        let refresh =
            widget::button::icon(widget::icon::from_svg_bytes(REFRESH_ICON).symbolic(true))
                .on_press_maybe((!self.manual_pending()).then_some(Message::RefreshNow));
        let gear = widget::button::icon(widget::icon::from_svg_bytes(SETTINGS_ICON).symbolic(true))
            .selected(self.settings_open)
            .on_press(Message::ToggleSettings);
        widget::Row::new()
            .spacing(4)
            .align_y(Vertical::Center)
            .push(freshness)
            .push(refresh)
            .push(gear)
            .into()
    }

    /// §7 preferences, inline: thresholds and cadence, plus the tripwire
    /// re-arm when it has fired.
    fn settings_view(&self) -> Element<'_, Message> {
        let s = &self.settings;
        let colors = self.theme_colors();
        let dim = with_alpha(colors.foreground, DIM_TEXT_ALPHA);
        let thresholds = widget::settings::section()
            .title("Thresholds")
            .add(widget::settings::item(
                "Warning at",
                widget::spin_button(
                    format!("{}%", s.warning_percent),
                    s.warning_percent,
                    1,
                    WARNING_PERCENT_MIN,
                    WARNING_PERCENT_MAX,
                    Message::WarningChanged,
                ),
            ))
            .add(widget::settings::item(
                "Critical at",
                widget::spin_button(
                    format!("{}%", s.critical_percent),
                    s.critical_percent,
                    1,
                    CRITICAL_PERCENT_MIN,
                    CRITICAL_PERCENT_MAX,
                    Message::CriticalChanged,
                ),
            ));

        let intervals: Vec<Element<'_, Message>> = REFRESH_INTERVALS_SEC
            .into_iter()
            .map(|seconds| {
                let selected = seconds == s.refresh_interval_seconds;
                widget::button::custom(widget::text::caption(refresh_interval_label(seconds)))
                    .padding([4, 8])
                    .class(if selected {
                        cosmic::theme::Button::Suggested
                    } else {
                        cosmic::theme::Button::Standard
                    })
                    .on_press(Message::IntervalSelected(seconds))
                    .into()
            })
            .collect();
        // Five choices do not fit beside a label at this width, so they wrap
        // under their label instead of being clipped.
        let refresh = widget::settings::section().title("Refresh").add(
            widget::Column::new()
                .spacing(8)
                .width(Length::Fill)
                .push(widget::text::body("Interval"))
                .push(widget::flex_row(intervals).row_spacing(4).column_spacing(4)),
        );

        let mut column = widget::Column::new()
            .spacing(12)
            .width(Length::Fill)
            .push(thresholds)
            .push(refresh);
        if s.refresh_path_disabled {
            column = column.push(
                widget::Column::new()
                    .spacing(8)
                    .push(
                        widget::text::caption(
                            "The Claude CLI refresh path is off: a refresh could not prove it \
                             made no model calls, so only the local cache is read. Re-enable \
                             it only once you have verified the cause.",
                        )
                        .class(cosmic::theme::Text::Color(dim))
                        .width(Length::Fill),
                    )
                    .push(
                        widget::button::standard("Re-enable refresh")
                            .on_press(Message::ReenableRefresh),
                    ),
            );
        }
        let model = menu_model(self.snapshot.as_ref(), now_ms(), &self.options());
        column
            .push(widget::divider::horizontal::default())
            .push(self.footer(&model.footer, &colors, dim))
            .into()
    }
}

struct ThemeColors {
    foreground: Color,
    accent: Color,
    warning: Color,
    destructive: Color,
}

impl ThemeColors {
    /// §3.3 meter colors: accent normally, theme warning/error otherwise,
    /// foreground for the slashed unavailable track.
    fn meter(&self, state: State) -> Color {
        match state {
            State::Normal | State::Stale => self.accent,
            State::Warning => self.warning,
            State::Critical | State::LimitHit => self.destructive,
            State::Unavailable => self.foreground,
        }
    }

    /// §4.2 bar fill: foreground normally, state colors when that window
    /// crosses the thresholds.
    fn bar(&self, state: State) -> Color {
        match state {
            State::Warning => self.warning,
            State::Critical | State::LimitHit => self.destructive,
            _ => self.foreground,
        }
    }
}

fn mark_color(mark: Mark) -> Color {
    match mark {
        Mark::Claude => CLAUDE_COLOR,
        Mark::Codex => CODEX_COLOR,
    }
}

fn with_alpha(color: Color, alpha: f32) -> Color {
    Color { a: alpha, ..color }
}

/// §4.2 progress bar: ~6 px rounded track + fill.
fn bar<'a>(percent: f64, fill: Color, track: Color) -> Element<'a, Message> {
    progress_bar::ProgressBar::new(0.0..=100.0, percent.clamp(0.0, 100.0) as f32)
        .girth(6.0)
        .length(Length::Fill)
        .class(cosmic::theme::ProgressBar::custom(move |_theme| {
            progress_bar::Style {
                background: track.into(),
                bar: fill.into(),
                border: Border {
                    radius: 3.0.into(),
                    ..Border::default()
                },
            }
        }))
        .into()
}

fn popup_limits() -> Limits {
    Limits::NONE
        .min_width(POPUP_WIDTH)
        .max_width(POPUP_WIDTH)
        .max_height(POPUP_MAX_HEIGHT)
}

/// The background poll: one tick every `delay_sec`, restarted whenever the
/// `epoch` changes so a tick is always measured from the last completion.
fn poll_timer(delay_sec: u32, epoch: u64) -> Subscription<Message> {
    Subscription::run_with((delay_sec.max(1), epoch), |(delay_sec, _)| {
        let delay = Duration::from_secs(u64::from(*delay_sec));
        cosmic::iced::futures::stream::unfold((), move |()| async move {
            tokio::time::sleep(delay).await;
            Some((Message::Tick, ()))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmic::Renderer;
    use cosmic::iced::advanced::layout::Node;
    use cosmic::iced::advanced::widget::Tree;
    use cosmic::iced::{Pixels, Rectangle, Size};

    use crate::claude::{ClaudeSnapshot, ModelWindow, ProviderError, UsageWindow};
    use crate::codex::{Access, CodexSnapshot, parse_codex_rate_limits};

    const CACHE: &str = include_str!("../tests/fixtures/cached-usage-utilization.json");
    const CODEX: &str = include_str!("../tests/fixtures/codex-rate-limits-result.json");

    fn sample_snapshot(now: i64) -> Snapshot {
        let mut claude = crate::claude::parse_snapshot(
            format!(r#"{{"cachedUsageUtilization": {CACHE}}}"#).as_bytes(),
            now,
        );
        claude.fetched_at = now;
        // Push the reset times into the future relative to `now`.
        if let Some(w) = claude.session.as_mut() {
            w.resets_at = Some(now + 2 * 3_600_000 + 15 * 60_000);
        }
        if let Some(w) = claude.week.as_mut() {
            w.resets_at = Some(now + 3 * 86_400_000);
        }
        for m in &mut claude.week_model {
            m.window.resets_at = Some(now + 3 * 86_400_000);
        }
        let mut codex = parse_codex_rate_limits(&serde_json::from_str(CODEX).unwrap(), now);
        for w in &mut codex.windows {
            w.resets_at = Some(
                now + if w.duration_mins == Some(300.0) {
                    50 * 60_000
                } else {
                    5 * 86_400_000
                },
            );
        }
        Snapshot { claude, codex }
    }

    fn sample_window(snapshot: Option<Snapshot>) -> Window {
        let settings = Settings::default();
        let refresh_disabled = Arc::new(AtomicBool::new(false));
        Window {
            core: Core::default(),
            popup: None,
            settings_open: false,
            config: None,
            clock24: true,
            refresh_disabled: Arc::clone(&refresh_disabled),
            source: Arc::new(Mutex::new(MultiSource::new(refresh_disabled))),
            snapshot,
            fetched_at: None,
            last_refresh_failed: RefreshFailed::default(),
            backoff: Backoff::initial(settings.refresh_interval_seconds),
            timer_epoch: 0,
            generation: 0,
            in_flight: false,
            refetch_queued: false,
            manual_queued: false,
            manual_in_flight: false,
            settings,
        }
    }

    fn renderer() -> Renderer {
        Renderer::Secondary(iced_tiny_skia::Renderer::new(
            cosmic::font::default(),
            Pixels(14.0),
        ))
    }

    fn layout(element: Element<'_, Message>, width: f32) -> Node {
        let mut element = element;
        let mut tree = Tree::new(element.as_widget());
        let limits = cosmic::iced::advanced::layout::Limits::NONE
            .max_width(width)
            .width(Length::Shrink);
        element
            .as_widget_mut()
            .layout(&mut tree, &renderer(), &limits)
    }

    /// The inner width a popup body gets: the fixed popup width less
    /// `padded_control`'s horizontal padding.
    fn body_width() -> f32 {
        POPUP_WIDTH - f32::from(cosmic::theme::spacing().space_m) * 2.0
    }

    #[test]
    fn popup_width_never_follows_the_data() {
        let now = 1_784_959_900_803;
        let mut snapshot = sample_snapshot(now);
        snapshot.claude.week_model.push(ModelWindow {
            model: "An Extremely Long Model Display Name That Keeps Going".into(),
            window: UsageWindow {
                percent: 12.0,
                resets_at: Some(now + 99_999_999),
            },
        });
        for w in &mut snapshot.codex.windows {
            if w.limit_name.is_some() {
                w.limit_name = Some("GPT-9.9-Codex-Superduper-Extended-Edition".into());
            }
        }
        let window = sample_window(Some(snapshot));
        let node = layout(window.usage_view(), body_width());
        assert!(node.size().width <= body_width(), "{}", node.size().width);
        let settings = layout(window.settings_view(), body_width());
        assert!(
            settings.size().width <= body_width(),
            "{}",
            settings.size().width
        );
    }

    #[test]
    fn strip_has_a_fixed_footprint_in_every_state() {
        let now = 1_784_959_900_803;
        let states = [
            None,
            Some(sample_snapshot(now)),
            Some(Snapshot {
                claude: ClaudeSnapshot::failed(now, ProviderError::NotInstalled),
                codex: CodexSnapshot::failed(now, ProviderError::NotAuthenticated, None),
            }),
        ];
        let mut widths = Vec::new();
        for snapshot in states {
            let window = sample_window(snapshot);
            let model = indicator_model(window.snapshot.as_ref(), now, &window.options());
            let node = layout(window.strip(&model, 1.0, true), f32::INFINITY);
            widths.push(node.size().width);
        }
        // mark + gap + meter, twice, plus the provider gap: 16+4+9+12+16+4+9.
        assert!(widths.iter().all(|w| (*w - 70.0).abs() < 0.5), "{widths:?}");
    }

    #[test]
    fn apply_settings_rebases_cadence_and_mirrors_the_tripwire() {
        let mut window = sample_window(None);
        window.backoff = window.backoff.next(Event::Failure).next(Event::Failure);
        assert_eq!(window.backoff.delay_sec, 120);
        let epoch = window.timer_epoch;
        window.apply_settings(Settings {
            refresh_interval_seconds: 300,
            refresh_path_disabled: true,
            ..Settings::default()
        });
        assert_eq!(
            window.backoff,
            Backoff {
                base_sec: 300,
                failures: 2,
                delay_sec: 300
            }
        );
        assert_eq!(window.timer_epoch, epoch + 1);
        assert!(window.refresh_disabled.load(Ordering::Relaxed));
        // An unchanged echo from the store is a no-op.
        window.apply_settings(window.settings.clone());
        assert_eq!(window.timer_epoch, epoch + 1);
    }

    #[test]
    fn manual_refresh_is_busy_until_its_fetch_lands() {
        let mut window = sample_window(None);
        window.in_flight = true;
        window.generation = 1;
        let _ = window.update(Message::RefreshNow);
        assert!(window.manual_pending());
        assert!(window.refetch_queued);
        // A poll result for the in-flight fetch does not clear the manual
        // request; the queued manual fetch starts instead.
        let output = FetchOutput {
            snapshot: sample_snapshot(5),
            last_refresh_failed: RefreshFailed::default(),
            claude_refresh_disabled: false,
        };
        let _ = window.update(Message::Fetched(1, output));
        assert!(window.in_flight);
        assert!(window.manual_pending());
        assert!(!window.refetch_queued);
    }

    /// Draws `element` at `width` with the tiny-skia renderer and writes a
    /// PAM image (`magick x.pam x.png` converts it).
    fn render(element: Element<'_, Message>, width: f32, path: &std::path::Path) {
        use cosmic::iced::advanced::Layout;
        use cosmic::iced::advanced::renderer::{Headless, Style};
        use cosmic::iced::mouse::Cursor;

        let mut element = element;
        let mut tree = Tree::new(element.as_widget());
        let mut renderer = renderer();
        // A finite width fills it (the popup); an infinite one lets the
        // element take its natural size (the panel strip).
        let limits = if width.is_finite() {
            cosmic::iced::advanced::layout::Limits::new(
                Size::new(width, 0.0),
                Size::new(width, 2000.0),
            )
        } else {
            cosmic::iced::advanced::layout::Limits::new(Size::ZERO, Size::new(2000.0, 2000.0))
        };
        let node = element
            .as_widget_mut()
            .layout(&mut tree, &renderer, &limits);
        let size = node.size();
        let theme = cosmic::Theme::dark();
        let on = theme.cosmic().background(false).on;
        element.as_widget().draw(
            &tree,
            &mut renderer,
            &theme,
            &Style {
                icon_color: on.into(),
                text_color: on.into(),
                scale_factor: 1.0,
            },
            Layout::new(&node),
            Cursor::Unavailable,
            &Rectangle::with_size(size),
        );
        let Renderer::Secondary(renderer) = &mut renderer else {
            unreachable!("the test renderer is tiny-skia")
        };
        let (w, h) = (size.width.ceil() as u32, size.height.ceil() as u32);
        let background = Color::from(theme.cosmic().background(false).base);
        let pixels = renderer.screenshot(Size::new(w, h), 1.0, background);
        let mut file =
            format!("P7\nWIDTH {w}\nHEIGHT {h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n")
                .into_bytes();
        file.extend(pixels);
        std::fs::write(path, file).unwrap();
    }

    /// Renders the states that matter for review into
    /// `$CLAUDOMETER_RENDER_DIR`. Ignored by default because it produces
    /// images for a person to look at rather than asserting anything:
    ///
    /// ```sh
    /// CLAUDOMETER_RENDER_DIR=/tmp/render cargo test render_states -- --ignored
    /// ```
    #[test]
    #[ignore]
    fn render_states() {
        let dir = std::path::PathBuf::from(
            std::env::var("CLAUDOMETER_RENDER_DIR").expect("set CLAUDOMETER_RENDER_DIR"),
        );
        std::fs::create_dir_all(&dir).unwrap();
        let now = now_ms();
        let width = body_width();

        let window = sample_window(Some(sample_snapshot(now)));
        render(
            padded_control(window.usage_view()).into(),
            POPUP_WIDTH,
            &dir.join("popup.pam"),
        );
        let mut settings = sample_window(Some(sample_snapshot(now)));
        settings.settings_open = true;
        settings.settings.refresh_path_disabled = true;
        render(
            padded_control(settings.settings_view()).into(),
            POPUP_WIDTH,
            &dir.join("settings.pam"),
        );

        let mut degraded = sample_snapshot(now);
        degraded.codex = CodexSnapshot::failed(now, ProviderError::NotInstalled, None);
        degraded.claude.session.as_mut().unwrap().percent = 100.0;
        degraded.claude.week.as_mut().unwrap().percent = 85.0;
        let window = sample_window(Some(degraded));
        render(
            padded_control(window.usage_view()).into(),
            POPUP_WIDTH,
            &dir.join("popup-degraded.pam"),
        );

        let mut denied = sample_snapshot(now);
        denied.codex.access = Access::Denied;
        denied.claude.fetched_at = now - 25 * 60_000;
        let window = sample_window(Some(denied));
        render(
            padded_control(window.usage_view()).into(),
            POPUP_WIDTH,
            &dir.join("popup-denied-stale.pam"),
        );

        let window = sample_window(None);
        render(
            padded_control(window.usage_view()).into(),
            POPUP_WIDTH,
            &dir.join("popup-empty.pam"),
        );

        // The panel strip in several states, at 1x and 2x (a 32 px panel).
        let strips: Vec<(&str, Option<Snapshot>)> = vec![
            ("strip-normal", Some(sample_snapshot(now))),
            ("strip-empty", None),
            ("strip-warning", {
                let mut s = sample_snapshot(now);
                s.claude.week.as_mut().unwrap().percent = 83.0;
                s.codex.windows[0].percent = 97.0;
                Some(s)
            }),
            ("strip-stale", {
                let mut s = sample_snapshot(now);
                s.claude.fetched_at = now - 30 * 60_000;
                Some(s)
            }),
        ];
        for (name, snapshot) in strips {
            let window = sample_window(snapshot);
            let model = indicator_model(window.snapshot.as_ref(), now, &window.options());
            for scale in [1.0, 2.0] {
                let strip = widget::container(window.strip(&model, scale, true)).padding(8);
                render(
                    strip.into(),
                    f32::INFINITY,
                    &dir.join(format!("{name}-{scale}x.pam")),
                );
            }
        }
        let _ = width;
    }
}
