use crate::layouts::RootDocument;
use axum::response::{IntoResponse, Response};
use proa_core::{DataLoader, WebContext, WebRenderSync, WriteError};
use proa_framework_axum::RouteResponse;
use proa_macros::html_sync;
pub struct SignIn {
    pub email: Option<String>,
    pub refused: bool,
    pub enabled: bool,
    pub href: String,
}
impl<L: DataLoader> WebRenderSync<L> for SignIn {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        html_sync! {
            <main class="narrow" data-page="sign-in">
                <h1>"Sign in"</h1>
                <p class="lede">
                    "Autobuild uses your GitHub account. Your organization's owner adds you by the email on that account."
                </p>
                {if self.enabled { html_sync! {
                    <a class="btn primary" href={self.href.as_str()}>"Continue with GitHub"</a>
                } } else { html_sync! {
                    <p class="slack" data-auth-unavailable>"GitHub sign-in is not configured."</p>
                } }}
                {if self.refused { Some(html_sync! {
                    <div class="refused" role="alert" data-signin-refused>
                        <div class="line">"You're not in an organization yet."</div>
                        {if let Some(email) = self.email { html_sync! {
                            <p>"You signed in as "<span class="m">{email}</span>", which no organization has added. Ask your organization's owner to add this email, or sign in with the GitHub account they added."</p>
                        } } else { html_sync! {
                            <p>"We couldn't verify an allowed email on your GitHub account. Try signing in again or ask your organization's owner to add your verified email."</p>
                        } }}
                    </div>
                }) } else { None }}
            </main>
        }.render(cx)
    }
}
// HTML-only auth boundary: no authenticated semantic resource or Markdown alternate.
pub fn response(email: Option<String>, refused: bool, enabled: bool, return_to: &str) -> Response {
    let query: String = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("returnTo", return_to)
        .finish();
    RouteResponse::ssr(RootDocument {
        title: "Sign in · Proa server",
        viewer: None,
        content: SignIn {
            email,
            refused,
            enabled,
            href: format!("/auth/github?{query}"),
        },
    })
    .into_response()
}
