use super::home::{link, text};
use crate::{app::AppState, layouts::RootDocument, pages::home::Selection};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use proa_core::{DataLoader, WebContext, WebRenderSync, WriteError};
use proa_framework_axum::RouteResponse;
use proa_macros::html_sync;
use proa_server::dashboard::model::array;
use serde_json::Value;
pub struct BuildPage {
    pub value: Value,
    status: String,
    back: String,
    findings: String,
    verify: String,
    observations: String,
    questions: Value,
    frames: Vec<FrameView>,
}
struct Artifacts<'a>(&'a Value);
struct Sessions<'a>(&'a Value);
struct StreamStatus<'a>(&'a Value);
struct FrameView {
    value: Value,
    src: String,
}
struct Frames<'a>(&'a [FrameView]);
impl BuildPage {
    pub fn new(value: Value) -> Self {
        let status = proa_server::dashboard::model::effective_status(&value["state"]);
        let back = link(text(&value["project"]), None);
        let findings =
            serde_json::to_string_pretty(&value["state"]["reviewFindings"]).unwrap_or_default();
        let verify =
            serde_json::to_string_pretty(&value["state"]["verify"]["results"]).unwrap_or_default();
        let observations =
            serde_json::to_string_pretty(&value["state"]["observations"]).unwrap_or_default();
        let questions = Value::Array(
            array(&value["state"]["openEscalations"])
                .iter()
                .map(|e| e["question"].clone())
                .collect(),
        );
        let frames = array(&value["frames"])
            .iter()
            .enumerate()
            .map(|(index, frame)| {
                let query = url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("project", text(&value["project"]))
                    .append_pair("slug", text(&value["record"]["slug"]))
                    .append_pair("index", &index.to_string())
                    .finish();
                FrameView {
                    value: frame.clone(),
                    src: format!("/frame?{query}"),
                }
            })
            .collect();
        Self {
            value,
            status,
            back,
            findings,
            verify,
            observations,
            questions,
            frames,
        }
    }
}
impl<L: DataLoader> WebRenderSync<L> for Artifacts<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        for a in array(self.0) {
            html_sync! {
                <section data-artifact={text(&a["kind"])}>
                    <h2>{text(&a["kind"])}</h2>
                    <pre class="prose" data-store-text>
                        {a["text"].as_str().unwrap_or_else(||text(&a["error"]))}
                    </pre>
                </section>
            }
            .render(cx)?;
        }
        Ok(())
    }
}
impl<L: DataLoader> WebRenderSync<L> for StreamStatus<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        if self.0["stream"].is_string() {
            html_sync! {
                <span data-session-stream>" / stream "{text(&self.0["streamStatus"])}</span>
            }
            .render(cx)?;
        }
        Ok(())
    }
}
impl<L: DataLoader> WebRenderSync<L> for Sessions<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        for s in array(self.0) {
            html_sync! {
                <details data-session={text(&s["id"])}>
                    <summary>
                        {text(&s["phase"])}
                        " · "
                        {text(&s["status"])}
                        " · "
                        {text(&s["runtime"])}
                        {StreamStatus(s)}
                    </summary>
                    <pre class="prose" data-store-text>
                        {s["text"]["text"].as_str().unwrap_or_else(||text(&s["text"]["error"]))}
                    </pre>
                </details>
            }
            .render(cx)?;
        }
        Ok(())
    }
}
impl<L: DataLoader> WebRenderSync<L> for Frames<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        for view in self.0 {
            let frame = &view.value;
            html_sync! {
                <figure data-frame>
                    <img
                        src={view.src.as_str()}
                        alt={frame["caption"].as_str().unwrap_or("Attached verification frame")}
                        loading="lazy"
                    />
                    <figcaption>{text(&frame["caption"])}</figcaption>
                </figure>
            }
            .render(cx)?;
        }
        Ok(())
    }
}
impl<L: DataLoader> WebRenderSync<L> for BuildPage {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        let v = &self.value;
        html_sync! {
            <main class="page" data-page="build-detail" data-live="detail">
                <a href={self.back.as_str()}>"Back to Builds"</a>
                <h1>{text(&v["record"]["slug"])}</h1>
                <p class="build-status m" data-status={self.status.as_str()}>
                    {self.status.as_str()}
                </p>
                <section data-escalations>
                    <h2>"Open escalations"</h2>
                    {super::home::Questions(&self.questions)}
                </section>
                {Artifacts(&v["artifacts"])}
                <section data-findings>
                    <h2>"Review findings"</h2>
                    <pre class="prose" data-store-text>{self.findings.as_str()}</pre>
                </section>
                <section data-verify>
                    <h2>"Verify results"</h2>
                    <pre class="prose" data-store-text>{self.verify.as_str()}</pre>
                    {Frames(&self.frames)}
                </section>
                <section data-observations>
                    <h2>"Observations"</h2>
                    <pre class="prose" data-store-text>{self.observations.as_str()}</pre>
                </section>
                <section data-sessions>
                    <h2>"Session feed"</h2>
                    {Sessions(&v["sessions"])}
                </section>
                <p class="slack" data-live-status role="status"></p>
            </main>
        }
        .render(cx)
    }
}
struct DetailLoader {
    reader: std::sync::Arc<proa_server::data::reader::DataReader>,
    project: String,
    slug: String,
}
impl DataLoader for DetailLoader {
    async fn load(
        &self,
        _request: &proa_core::LoadRequest,
    ) -> Result<proa_core::LoadValue, proa_core::LoadError> {
        Ok(proa_core::LoadValue::typed(
            self.reader.detail_snapshot(&self.project, &self.slug).await,
        ))
    }
}
async fn load_detail(
    reader: std::sync::Arc<proa_server::data::reader::DataReader>,
    project: String,
    slug: String,
) -> Result<Value, proa_server::data::error::DataError> {
    let resolver = proa_stream::DataResolver::request_scope(std::sync::Arc::new(DetailLoader {
        reader,
        project,
        slug,
    }));
    let cx =
        proa_core::SendWebContext::with_loader_buffer(proa_core::RenderBuffer::new(), resolver);
    let result = cx
        .load_typed::<Result<Value, proa_server::data::error::DataError>>(
            proa_core::LoadKey::named("detail", "snapshot"),
        )
        .await
        .map_err(|_| proa_server::data::error::DataError::Query)?;
    result.as_ref().clone()
}
pub async fn handler(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(selection): Query<Selection>,
    axum::Extension(viewer): axum::Extension<crate::auth::Viewer>,
) -> Response {
    let (Some(reader), Some(project)) = (state.data, selection.project) else {
        return (StatusCode::NOT_FOUND, "Project unavailable").into_response();
    };
    let builds_href = link(&project, None);
    match load_detail(reader, project.clone(), slug).await {
        Ok(value) => RouteResponse::ssr(RootDocument {
            title: "Build · Proa server",
            builds_href,
            project: Some(project),
            projects: Vec::new(),
            viewer: Some(viewer),
            content: BuildPage::new(value),
        })
        .into_response(),
        Err(error) => (StatusCode::NOT_FOUND, error.to_string()).into_response(),
    }
}
