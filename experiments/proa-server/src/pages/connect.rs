//! Browser approval reads durable requests once, then renders synchronously.
use crate::{auth::Viewer, layouts::RootDocument};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension,
};
use proa_core::{DataLoader, WebContext, WebRenderSync, WriteError};
use proa_framework_axum::RouteResponse;
use proa_macros::html_sync;
use proa_server::{
    app::AppState,
    connection::{ConnectionRecord, ConnectionService, Status},
};
use serde::Deserialize;

#[derive(Default, Deserialize)]
pub struct ConnectQuery {
    pub code: Option<String>,
}
pub struct ConnectPage {
    pub code: String,
    pub record: Option<ConnectionRecord>,
    pub error: Option<String>,
    pub csrf: String,
}
impl<L: DataLoader> WebRenderSync<L> for ConnectPage {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        html_sync! {
            <main class="narrow" data-page="connect">
                <h1>"Connect a project"</h1>
                <p class="lede">
                    <span class="m">"ab connect"</span>
                    " is asking to connect this project. Check that the code matches your terminal."
                </p>
                {if let Some(record) = self.record { html_sync! {
                    <div class="code" data-connect-code>{display_code(&record.code)}</div>
                    <p class="m connect-repo" data-connect-repo>{record.repo.strip_prefix("https://").unwrap_or(&record.repo)}</p>
                    {match record.status {
                        Status::Pending => html_sync! {
                            <form method="post" action="/connect/decide" class="addrow" data-connect-pending>
                                <input type="hidden" name="csrf" value={self.csrf.as_str()} />
                                <input type="hidden" name="code" value={record.code.as_str()} />
                                <button type="submit" name="decision" value="approve" class="btn primary">"Approve"</button>
                                <button type="submit" name="decision" value="deny" class="btn">"Deny"</button>
                            </form>
                        },
                        Status::Approved => html_sync! {<p role="status" data-connect-approved>"Approved. Return to your terminal to finish connecting."</p>},
                        Status::Denied => html_sync! {<p role="status" data-connect-denied>"Connection denied. No project credential was installed."</p>},
                        Status::Expired => html_sync! {<p role="status" data-connect-expired>"This connection code has expired. Run ab connect again."</p>},
                    }}
                }} else { html_sync! {
                    {if let Some(error) = self.error {Some(html_sync!{<p class="refused" role="alert" data-connect-error>{error}</p>})}else{None}}
                    <form method="get" action="/connect" data-connect-entry>
                        <label for="connection-code">"Connection code"</label>
                        <input id="connection-code" name="code" class="field connect-input m" value={self.code.as_str()} required maxlength="12" autocomplete="off" spellcheck="false" />
                        <div class="addrow"><button type="submit" class="btn primary">"Review connection"</button></div>
                    </form>
                }}}
            </main>
        }.render(cx)
    }
}
pub fn canonical_code(raw: &str) -> String {
    raw.trim().replace('-', "").to_ascii_uppercase()
}
fn display_code(code: &str) -> String {
    if code.len() == 10 && code.is_ascii() {
        format!("{}-{}-{}", &code[..4], &code[4..8], &code[8..])
    } else {
        code.into()
    }
}
pub fn response(
    viewer: Viewer,
    code: String,
    record: Option<ConnectionRecord>,
    error: Option<String>,
    status: StatusCode,
) -> Response {
    let csrf = viewer.csrf.clone();
    let mut response = RouteResponse::ssr(RootDocument {
        project: None,
        projects: Vec::new(),
        builds_href: "/".into(),
        title: "Connect a project · Proa server",
        viewer: Some(viewer),
        content: ConnectPage {
            code,
            record,
            error,
            csrf,
        },
    })
    .into_response();
    *response.status_mut() = status;
    response
}
pub async fn handler(
    State(state): State<AppState>,
    Extension(viewer): Extension<Viewer>,
    Query(query): Query<ConnectQuery>,
) -> Response {
    let code = canonical_code(query.code.as_deref().unwrap_or_default());
    if code.is_empty() {
        return response(viewer, code, None, None, StatusCode::OK);
    }
    let Some(writer) = &state.writer else {
        return response(
            viewer,
            code,
            None,
            Some("Connection service is unavailable. Try again.".into()),
            StatusCode::SERVICE_UNAVAILABLE,
        );
    };
    let now = state
        .machine
        .as_ref()
        .map(|m| m.store.now())
        .unwrap_or_else(chrono::Utc::now);
    match (ConnectionService { writer })
        .lookup(&code, &viewer.email, now)
        .await
    {
        Ok(Some(record)) => response(viewer, code, Some(record), None, StatusCode::OK),
        Ok(None) => response(
            viewer,
            code,
            None,
            Some("Unknown connection code. Check the code in your terminal.".into()),
            StatusCode::NOT_FOUND,
        ),
        Err(error) => response(
            viewer,
            code,
            None,
            Some(error.message.into()),
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manual_entry_accepts_display_grouping() {
        assert_eq!(canonical_code(" 7f3a-c91e-2b "), "7F3AC91E2B");
    }
    #[test]
    fn pending_form_submits_canonical_code_and_explicit_decision_without_script() {
        let page = ConnectPage {
            code: String::new(),
            csrf: "csrf-token".into(),
            error: None,
            record: Some(ConnectionRecord {
                id: "request".into(),
                repo: "https://github.com/owner/<script>".into(),
                credential_id: "private-identity".into(),
                code: "7F3AC91E2B".into(),
                status: Status::Pending,
                expires_at: "2026-10-25T00:00:00.000Z".into(),
            }),
        };
        let html = proa_core::render_to_string(page);
        assert!(html.contains("7F3A-C91E-2B"));
        assert!(html.contains("value=\"7F3AC91E2B\""));
        assert!(html.contains("name=\"decision\" value=\"approve\""));
        assert!(html.contains("name=\"decision\" value=\"deny\""));
        assert!(!html.contains("private-identity"));
        assert!(!html.contains("<script>"));
    }
}
