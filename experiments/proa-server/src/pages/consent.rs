//! Consent labels are resolved from the pending server grant, never from page query labels.
use crate::{auth::Viewer, layouts::RootDocument};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Extension, Form,
};
use proa_core::{DataLoader, WebContext, WebRenderSync, WriteError};
use proa_framework_axum::RouteResponse;
use proa_macros::html_sync;
use proa_server::{
    app::AppState,
    oauth::{
        self,
        types::{Client, Grant},
    },
};
use serde::Deserialize;

#[derive(Default, Deserialize)]
pub struct ConsentQuery {
    pub consent_code: Option<String>,
}
pub struct Consent {
    pub request: Option<(Grant, Client)>,
    pub code: String,
    pub viewer: Viewer,
    pub unavailable: bool,
}
impl<L: DataLoader> WebRenderSync<L> for Consent {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        html_sync! {
            <main class="narrow" data-page="consent">
                <h1>"Authorize an agent"</h1>
                {if let Some((grant,client))=self.request { html_sync! {
                    <p class="lede"><strong class={if client.name.is_none() {"m connect-repo"} else {"connect-repo"}} data-consent-client>{client.name.as_deref().unwrap_or(&client.id)}</strong>" is asking to operate Autobuild on your behalf."</p>
                    <p>"Client names are supplied by the client. Check the client ID before authorizing."</p>
                    <dl>
                        <dt class="slack">"Client ID"</dt>
                        <dd class="connect-repo m" data-consent-id>{client.id}</dd>
                        <dt class="slack">"Signed in as"</dt>
                        <dd class="connect-repo m" data-consent-identity>{self.viewer.email}</dd>
                        <dt class="slack">"Requested scopes"</dt>
                        <dd class="connect-repo m" data-consent-scopes>{grant.scope}</dd>
                    </dl>
                    <p>"This client can read builds and tickets and issue operator controls under your identity."</p>
                    <form method="post" action="/oauth/consent" class="addrow" data-consent-form>
                        <input type="hidden" name="csrf" value={self.viewer.csrf.as_str()}/>
                        <input type="hidden" name="consent_code" value={self.code.as_str()}/>
                        <button type="submit" name="decision" value="accept" class="btn primary">"Authorize"</button>
                        <button type="submit" name="decision" value="deny" class="btn">"Deny"</button>
                    </form>
                }} else { html_sync! {
                    <p class="refused" role="alert" data-consent-error>{if self.unavailable {"Authorization is unavailable. Try again shortly."} else {"This authorization request is missing, expired, already used, or belongs to another operator. Start connecting again from your agent."}}</p>
                    <a class="btn" href="/">"Return to builds"</a>
                }}}
            </main>
        }.render(cx)
    }
}
pub async fn handler(
    State(state): State<AppState>,
    Extension(viewer): Extension<Viewer>,
    Query(query): Query<ConsentQuery>,
) -> Response {
    let code = query.consent_code.unwrap_or_default();
    let request = oauth::http::pending(&state, &code, &viewer).await;
    let unavailable = matches!(&request,Err(e) if *e=="temporarily_unavailable");
    let mut response = RouteResponse::ssr(RootDocument {
        project: None,
        projects: Vec::new(),
        builds_href: "/".into(),
        title: "Authorize an agent · Proa server",
        viewer: Some(viewer.clone()),
        content: Consent {
            request: request.ok(),
            code,
            viewer,
            unavailable,
        },
    })
    .into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("referrer-policy", "no-referrer".parse().unwrap());
    response
}
#[derive(Deserialize)]
pub struct Decision {
    csrf: String,
    consent_code: String,
    decision: String,
}
pub async fn submit(
    State(state): State<AppState>,
    Extension(viewer): Extension<Viewer>,
    headers: HeaderMap,
    Form(form): Form<Decision>,
) -> Response {
    use subtle::ConstantTimeEq;
    if !oauth::http::same_origin(&state, &headers, true)
        || !bool::from(form.csrf.as_bytes().ct_eq(viewer.csrf.as_bytes()))
        || !["accept", "deny"].contains(&form.decision.as_str())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    match oauth::http::decide(
        &state,
        &viewer,
        &form.consent_code,
        form.decision == "accept",
    )
    .await
    {
        Ok(uri) => Redirect::to(&uri).into_response(),
        Err(e) => oauth::http::error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn labels_and_raw_ids_are_escaped_in_a_native_csrf_form() {
        let client = Client {
            id: "long<identifier>".repeat(20),
            name: Some("<script>alert(1)</script>".into()),
            redirects: vec![],
            method: "none".into(),
            secret: None,
        };
        let grant = Grant {
            client: client.id.clone(),
            email: "ada@example.com".into(),
            redirect: "https://client.test/callback".into(),
            challenge: "challenge".into(),
            scope: "openid <scope>".into(),
            resource: "https://operator.test/mcp".into(),
            state: None,
            consent: true,
            expires: 100,
        };
        let html = proa_core::render_to_string(Consent {
            request: Some((grant, client)),
            code: "opaque".into(),
            viewer: Viewer {
                email: "ada@example.com".into(),
                csrf: "csrf".into(),
            },
            unavailable: false,
        });
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("name=\"csrf\""));
        assert!(html.contains("action=\"/oauth/consent\""));
        assert!(html.contains("data-consent-id"));
    }
}
