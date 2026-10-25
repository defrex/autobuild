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
            "/builds/{}?{query}",
            url::form_urlencoded::byte_serialize(slug.as_bytes()).collect::<String>()
        ),
        None => format!("/?{query}"),
    }
}
#[derive(Clone)]
pub struct HomePage {
    pub snapshot: Snapshot,
    rows: Vec<RowView>,
    summary: String,
    markdown: String,
}
#[derive(Clone)]
struct RowView {
    row: Value,
    href: String,
    depth: String,
    landing: Value,
    steps: Vec<StepView>,
}
#[derive(Clone)]
struct StepView {
    value: Value,
    timer: String,
    accumulated: String,
    running: String,
}
impl HomePage {
    pub fn new(snapshot: Snapshot) -> Self {
        let rows = snapshot
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
                                    super::duration(
                                        ms + since
                                            .map(|since| {
                                                chrono::Utc::now().timestamp_millis() - since
                                            })
                                            .unwrap_or(0),
                                    )
                                })
                                .unwrap_or_default(),
                            accumulated: elapsed.unwrap_or(0).to_string(),
                            running: since.map(|n| n.to_string()).unwrap_or_default(),
                        }
                    })
                    .collect();
                RowView {
                    row: row.clone(),
                    href: link(
                        snapshot.project.as_deref().unwrap_or_default(),
                        Some(text(&row["slug"])),
                    ),
                    depth: row["depth"].as_u64().unwrap_or(0).to_string(),
                    landing: proa_server::dashboard::landing::policy(&row["landing"]),
                    steps,
                }
            })
            .collect();
        let summary = format!(
            "{} builds · {} needs you",
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
            summary,
            markdown: lines.join("\n\n"),
        }
    }
}
struct Rows<'a>(&'a HomePage);
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
                    {text(&step["label"])}
                    <span class="slack">{text(&step["qualifier"])}</span>
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
                <p class="question">"! "{text(question)}</p>
            }
            .render(cx)?;
        }
        Ok(())
    }
}
impl<L: DataLoader> WebRenderSync<L> for Rows<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        for view in &self.0.rows {
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
                            {text(&row["target"])}
                            " · landing "
                            {text(&view.landing)}
                        </p>
                        <ol class="steps" aria-label="Pipeline steps">{Steps(&view.steps)}</ol>
                        <p class="diagnostic">
                            {text(&row["dispatch"])}
                            {text(&row["abortProgress"])}
                            {text(&row["error"])}
                        </p>
                        {Questions(&row["blockers"])}
                    </div>
                    <span class="build-status m" data-status={text(&row["status"])}>
                        {text(&row["status"])}
                    </span>
                </article>
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
                {if s.settings.is_object() {Some(html_sync!{
                    <div class="control-line" data-controls>
                        <span>"Intake "{if s.settings["drained"]==true{"OFF"}else{"ON"}}</span>
                        <span>"Harvest "{if s.settings["harvestPaused"]==true{"OFF"}else{"ON"}}</span>
                    </div>
                })}else{None}}
                <p class="slack">
                    {s.error.as_deref().unwrap_or(if s.projects.is_empty(){"No projects configured."}else if s.rows.is_empty(){"No active builds."}else{self.summary.as_str()})}
                </p>
                <div data-build-list>{Rows(&self)}</div>
                <p class="legend">
                    <span data-state="done">"[x] done"</span>
                    "　"
                    <span data-state="current">"[>] happening now"</span>
                    "　"
                    <span data-state="provisional">"[~] in progress or retried"</span>
                    "　"
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
async fn load(state: AppState, project: Option<String>) -> Snapshot {
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
    let page = HomePage::new(load(state, selection.project).await);
    let project = page.snapshot.project.clone();
    let html = RouteResponse::ssr(RootDocument {
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
