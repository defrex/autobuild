use crate::{error::AppError, layouts::RootDocument};
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::IntoResponse,
};
use proa_core::{
    DataLoader, LoadError, LoadKey, LoadRequest, LoadValue, MdRenderSync, RenderBuffer, WebContext,
    WebRenderSync, WriteBuf, WriteError,
};
use proa_framework_axum::{explicit_markdown, negotiate, MarkdownAlternate, RouteResponse};
use proa_macros::html_sync;
use proa_server::{app::AppState, dashboard::model::array, data::dashboard::Snapshot};
use serde_json::Value;
use std::sync::Arc;
pub fn text(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}
pub fn link(project: &str, slug: Option<&str>) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("project", project)
        .finish();
    match slug {
        Some(slug) => format!(
            "/dashboard/builds/{}?{query}",
            url::form_urlencoded::byte_serialize(slug.as_bytes()).collect::<String>()
        ),
        None => format!("/?{query}"),
    }
}
#[derive(Clone)]
pub struct HomePage {
    pub snapshot: Snapshot,
    rows: Vec<RowView>,
    branch_indices: Vec<Vec<usize>>,
    roots: Vec<usize>,
    summary: String,
    markdown: String,
    controls: super::controls::ControlState,
}
#[derive(Clone)]
struct RowView {
    row: Value,
    href: String,
    depth: String,
    landing: Value,
    target_label: String,
    steps: Vec<StepView>,
    pr_href: String,
    pr_label: String,
    ceiling: String,
    child_counts: String,
    messages: Vec<MessageView>,
}
#[derive(Clone)]
struct MessageView {
    lines: Vec<String>,
    more: String,
}
impl MessageView {
    fn new(message: &str) -> Self {
        let mut previous_blank = false;
        let lines: Vec<String> = message
            .split('\n')
            .map(|s| s.trim_end_matches('\r'))
            .filter(|line| {
                let blank = line.trim().is_empty();
                let keep = !blank || !previous_blank;
                previous_blank = blank;
                keep
            })
            .map(str::to_owned)
            .collect();
        let remaining = lines.len().saturating_sub(3);
        Self {
            lines: lines.into_iter().take(3).collect(),
            more: if remaining == 0 {
                String::new()
            } else {
                format!(
                    "... {remaining} more {} — View details",
                    if remaining == 1 { "row" } else { "rows" }
                )
            },
        }
    }
}
#[derive(Clone)]
struct StepView {
    value: Value,
    timer: String,
    accumulated: String,
    running: String,
}
impl HomePage {
    pub fn with_controls(mut self, controls: super::controls::ControlState) -> Self {
        self.controls = controls;
        self
    }
    pub fn new(snapshot: Snapshot) -> Self {
        let rows: Vec<RowView> = snapshot
            .rows
            .iter()
            .map(|row| {
                let steps = array(row["integrationRow"].get("steps").unwrap_or(&row["steps"]))
                    .iter()
                    .map(|step| {
                        let elapsed = step["timing"]["accumulatedMs"].as_i64();
                        let since = step["timing"]["runningSince"].as_i64();
                        StepView {
                            value: step.clone(),
                            timer: elapsed
                                .map(|ms| {
                                    let value = super::duration(
                                        ms + since
                                            .map(|since| {
                                                chrono::Utc::now().timestamp_millis() - since
                                            })
                                            .unwrap_or(0),
                                    );
                                    if step["count"].as_i64().is_some_and(|count| count > 1) {
                                        format!("{value}/{}", step["count"])
                                    } else {
                                        value
                                    }
                                })
                                .unwrap_or_default(),
                            accumulated: elapsed.unwrap_or(0).to_string(),
                            running: since.map(|n| n.to_string()).unwrap_or_default(),
                        }
                    })
                    .collect();
                let pr_url = text(&row["pr"]["url"]);
                let pr_href = url::Url::parse(pr_url)
                    .ok()
                    .filter(|u| matches!(u.scheme(), "http" | "https"))
                    .map(|u| u.to_string())
                    .unwrap_or_default();
                let number = pr_url
                    .rsplit('/')
                    .next()
                    .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()));
                let pr_label = if row["pr"].is_object() {
                    format!(
                        "PR {}{}",
                        number.map(|n| format!("#{n} ")).unwrap_or_default(),
                        text(&row["pr"]["state"])
                    )
                } else {
                    String::new()
                };
                let ceilings = &row["reviewRoundCeilings"];
                let values: Vec<String> =
                    [("plan", &ceilings["plan"]), ("code", &ceilings["code"])]
                        .into_iter()
                        .filter(|(_, v)| !v.is_null())
                        .map(|(k, v)| format!("{k} {v}"))
                        .collect();
                let counts = &row["integrationRow"]["children"];
                let child_counts = if row["integrationRow"].is_object() {
                    if counts["known"] == true {
                        format!(
                            "{}/{} merged · {} building · {} queued",
                            counts["landed"], counts["total"], counts["building"], counts["queued"]
                        )
                    } else {
                        "children unknown".into()
                    }
                } else {
                    String::new()
                };
                let messages = row["setupError"]
                    .as_str()
                    .into_iter()
                    .chain(array(&row["blockers"]).iter().filter_map(Value::as_str))
                    .map(MessageView::new)
                    .collect();
                RowView {
                    pr_href,
                    pr_label,
                    ceiling: if values.is_empty() {
                        String::new()
                    } else {
                        format!("review round ceiling: {}", values.join(", "))
                    },
                    child_counts,
                    messages,
                    row: row.clone(),
                    href: link(
                        snapshot.project.as_deref().unwrap_or_default(),
                        Some(text(&row["slug"])),
                    ),
                    depth: row["depth"].as_u64().unwrap_or(0).to_string(),
                    landing: proa_server::dashboard::landing::policy(&row["landing"]),
                    target_label: {
                        let suffix = row["integrationRow"]["parentDistance"]
                            .as_str()
                            .or(row["targetDistance"].as_str())
                            .unwrap_or("+?");
                        format!(
                            "{}{}{}",
                            text(&row["target"]),
                            if suffix.is_empty() { "" } else { " " },
                            suffix
                        )
                    },
                    steps,
                }
            })
            .collect();
        let mut children = vec![Vec::new(); rows.len()];
        let mut roots = Vec::new();
        let mut stack = Vec::<usize>::new();
        for (index, row) in rows.iter().enumerate() {
            let depth = row.row["depth"].as_u64().unwrap_or(0) as usize;
            while stack.len() > depth {
                stack.pop();
            }
            if let Some(parent) = stack.last() {
                children[*parent].push(index);
            } else {
                roots.push(index);
            }
            stack.push(index);
        }
        let summary = format!(
            "{} builds · {} need you",
            snapshot.rows.len(),
            snapshot
                .rows
                .iter()
                .filter(|r| r["status"] == "blocked")
                .count()
        );
        let mut lines = vec![
            "# Builds".to_owned(),
            snapshot.project.clone().unwrap_or_default(),
        ];
        if let Some(error) = &snapshot.error {
            lines.push(error.clone());
        }
        for row in &snapshot.rows {
            lines.push(format!(
                "{}: {}\n{}",
                text(&row["slug"]),
                text(&row["status"]),
                row["steps"]
            ));
        }
        Self {
            snapshot,
            rows,
            branch_indices: children,
            roots,
            summary,
            markdown: lines.join("\n\n"),
            controls: super::controls::ControlState::default(),
        }
    }
}
struct Reasons<'a>(&'a Value);
struct Rows<'a> {
    page: &'a HomePage,
    indices: &'a [usize],
}
struct RowNode<'a> {
    page: &'a HomePage,
    index: usize,
}
pub struct Steps<'a>(&'a [StepView]);
pub struct Questions<'a>(pub &'a Value);
impl<L: DataLoader> WebRenderSync<L> for Steps<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        for view in self.0 {
            let step = &view.value;
            let state = text(&step["state"]);
            let glyph = match state {
                "done" => "[x]",
                "current" => "[>]",
                "provisional" => "[~]",
                _ => "[ ]",
            };
            html_sync! {
                <li data-state={state}>
                    <span aria-hidden="true">{glyph}</span>
                    " "
                    {text(&step["label"])}
                    " "
                    <span class="slack">{text(&step["qualifier"])}</span>
                    " "
                    <span
                        class="slack"
                        data-elapsed={view.accumulated.as_str()}
                        data-since={view.running.as_str()}
                    >
                        {view.timer.as_str()}
                    </span>
                    <span class="sr-only">{state}</span>
                </li>
            }
            .render(cx)?;
        }
        Ok(())
    }
}
impl<L: DataLoader> WebRenderSync<L> for Questions<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        for question in array(self.0) {
            html_sync! {
                <p class="question full-question" data-store-text>"! "{text(question)}</p>
            }
            .render(cx)?;
        }
        Ok(())
    }
}
struct RowTokens<'a>(&'a RowView);
impl<L: DataLoader> WebRenderSync<L> for RowTokens<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        if !self.0.pr_label.is_empty() {
            if self.0.pr_href.is_empty() {
                html_sync! {
                    <p class="build-tokens">{self.0.pr_label.as_str()}</p>
                }
                .render(cx)?;
            } else {
                html_sync! {
                    <p class="build-tokens">
                        <a class="m" href={self.0.pr_href.as_str()} rel="noreferrer">
                            {self.0.pr_label.as_str()}
                        </a>
                    </p>
                }
                .render(cx)?;
            }
        }
        let row = &self.0.row;
        if row["alsoPaused"] == true {
            html_sync! {
                <p class="build-tokens slack">"(paused)"</p>
            }
            .render(cx)?;
        }
        if row["draining"] == true {
            html_sync! {
                <p class="build-tokens slack">"(draining)"</p>
            }
            .render(cx)?;
        }
        Ok(())
    }
}
struct Messages<'a> {
    views: &'a [MessageView],
    href: &'a str,
}
impl<L: DataLoader> WebRenderSync<L> for Messages<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        for message in self.views {
            html_sync! {
                <aside class="message-alert" data-message-preview data-store-text>
                    {MessageLines(&message.lines)}
                    {if message.more.is_empty(){None}else{Some(html_sync! {
                        <a href={self.href}>{message.more.as_str()}</a>
                    })}}
                </aside>
            }
            .render(cx)?;
        }
        Ok(())
    }
}
struct MessageLines<'a>(&'a [String]);
impl<L: DataLoader> WebRenderSync<L> for MessageLines<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        for (index, line) in self.0.iter().enumerate() {
            html_sync! {
                <p>{if index==0{"! "}else{""}}{line.as_str()}</p>
            }
            .render(cx)?;
        }
        Ok(())
    }
}
impl<L: DataLoader> WebRenderSync<L> for Rows<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        for index in self.indices {
            RowNode {
                page: self.page,
                index: *index,
            }
            .render(cx)?;
        }
        Ok(())
    }
}
impl<L: DataLoader> WebRenderSync<L> for RowNode<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        let view = &self.page.rows[self.index];

        let row = &view.row;
        let slug = text(&row["slug"]);
        html_sync! {
            <article class="build-row" data-build={slug} data-depth={view.depth.as_str()}>
                <a class="build-id" href={view.href.as_str()}>
                    {row["ticketId"].as_str().unwrap_or(slug)}
                </a>
                <div class="build-body">
                    <a class="build-title" href={view.href.as_str()}>
                        {row["collectionIdentity"]["title"].as_str().unwrap_or(slug)}
                    </a>
                    <p class="build-meta">
                        <span class="m">{slug}</span>
                        " · "
                        {text(&row["kind"])}
                        " · target "
                        {view.target_label.as_str()}
                        " · merge "
                        {text(&view.landing)}
                    </p>
                    {RowTokens(view)}
                    <p class="diagnostic slack" data-ceilings>{view.ceiling.as_str()}</p>
                    <ol class="steps" aria-label="Pipeline steps">{Steps(&view.steps)}</ol>
                    {Reasons(&row["steps"])}
                    <p class="diagnostic" data-store-text>
                        {text(&row["dispatch"])}
                        {text(&row["abortProgress"])}
                        {text(&row["error"])}
                    </p>
                    <p class="diagnostic slack" data-child-counts>{view.child_counts.as_str()}</p>
                    {Messages{views:&view.messages,href:view.href.as_str()}}
                </div>
                <span class="build-status m" data-status={text(&row["status"])}>
                    {text(&row["status"])}
                </span>
            </article>
        }
        .render(cx)?;

        if !self.page.branch_indices[self.index].is_empty() {
            html_sync! {
                <div class="tree-children" data-tree-children>
                    {Rows{page:self.page,indices:&self.page.branch_indices[self.index]}}
                </div>
            }
            .render(cx)?;
        }
        Ok(())
    }
}
impl<L: DataLoader> WebRenderSync<L> for HomePage {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        let s = &self.snapshot;
        html_sync!{
            <main class="page" data-page="builds" data-live="dashboard">
                <h1 class="sr-only">"Builds"</h1>
                {if s.settings.is_object() {Some(super::controls::RepositoryControls {
                    state: &self.controls,
                    project: s.project.as_deref().unwrap_or_default(),
                    intake: s.settings["intake"] != false,
                    harvest: s.settings["harvest"]["paused"] != true,
                    harvest_state: &s.settings["harvest"],
                    dismissed_through: s.settings["dismissedThrough"].as_i64().unwrap_or(0),
                    pause: s.rows.iter().any(|r|r["status"]=="running"),
                    resume: s.rows.iter().any(|r|r["status"]=="paused"),
                })}else{None}}
                <p class="slack">
                    {s.error.as_deref().unwrap_or(if s.projects.is_empty(){"No projects configured."}else if s.rows.is_empty(){"No active builds."}else{self.summary.as_str()})}
                </p>
                <div data-build-list>{Rows{page:&self,indices:&self.roots}}</div>
                <p class="legend">
                    <span data-state="done">"[x] done"</span>
                    " "
                    <span data-state="current">"[>] happening now"</span>
                    " "
                    <span data-state="provisional">"[~] in progress or retried"</span>
                    " "
                    <span class="slack">"[ ] not started"</span>
                </p>
                <p class="slack" data-live-status role="status"></p>
            </main>
        }.render(cx)
    }
}
impl<L: DataLoader, B: WriteBuf> MdRenderSync<L, B> for HomePage {
    #[proa_macros::content(
        skip,
        reason = "The semantic Markdown snapshot deliberately omits HTML navigation and legend controls"
    )]
    fn render_md(self, cx: &mut WebContext<L, B>) -> Result<(), WriteError> {
        cx.output_mut().extend(self.markdown.as_bytes())
    }
}
#[derive(Default, serde::Deserialize)]
pub struct Selection {
    pub project: Option<String>,
}
struct SnapshotLoader {
    state: AppState,
    project: Option<String>,
}
impl DataLoader for SnapshotLoader {
    async fn load(&self, _request: &LoadRequest) -> Result<LoadValue, LoadError> {
        let snapshot = match &self.state.data {
            None => Snapshot::unavailable("No data store configured."),
            Some(reader) => reader
                .dashboard_snapshot(self.project.as_deref())
                .await
                .unwrap_or_else(|e| Snapshot::unavailable(&e.to_string())),
        };
        Ok(LoadValue::typed(snapshot))
    }
}
pub(crate) async fn load(state: AppState, project: Option<String>) -> Snapshot {
    let resolver =
        proa_stream::DataResolver::request_scope(Arc::new(SnapshotLoader { state, project }));
    let cx = proa_core::SendWebContext::with_loader_buffer(RenderBuffer::new(), resolver);
    cx.load_typed::<Snapshot>(LoadKey::named("dashboard", "snapshot"))
        .await
        .map(|s| s.as_ref().clone())
        .unwrap_or_else(|_| Snapshot::unavailable("Dashboard read failed."))
}
pub async fn handler(
    State(state): State<AppState>,
    Query(selection): Query<Selection>,
    axum::Extension(viewer): axum::Extension<crate::auth::Viewer>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let page = HomePage::new(load(state, selection.project).await)
        .with_controls(super::controls::ControlState::signed_in(viewer.clone()));
    let project = page.snapshot.project.clone();
    let builds_href = project
        .as_deref()
        .map(|project| link(project, None))
        .unwrap_or_else(|| "/".into());
    let html = RouteResponse::ssr(RootDocument {
        builds_href,
        title: "Builds · Proa server",
        project,
        projects: page.snapshot.projects.clone(),
        content: page.clone(),
        viewer: Some(viewer),
    });
    Ok(negotiate(
        &headers,
        html,
        page,
        MarkdownAlternate::new("/index.md"),
    )?)
}
pub async fn markdown(
    State(state): State<AppState>,
    Query(selection): Query<Selection>,
) -> Result<impl IntoResponse, AppError> {
    Ok(explicit_markdown(HomePage::new(
        load(state, selection.project).await,
    ))?)
}

impl<L: DataLoader> WebRenderSync<L> for Reasons<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        for step in array(self.0) {
            if let Some(reason) = step["reason"].as_str() {
                html_sync! {
                    <p class="slack" data-step-reason data-store-text>{reason}</p>
                }
                .render(cx)?;
            }
        }
        Ok(())
    }
}
