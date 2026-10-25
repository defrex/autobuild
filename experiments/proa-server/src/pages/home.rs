use proa_core::{DataLoader, WebContext, WebRenderSync, WriteError};
use proa_core::{MdRenderSync, WriteBuf};
use proa_macros::html_sync;
use proa_macros::md_sync;

#[derive(Debug, Clone, Copy)]
pub struct HomePage;

impl<L: DataLoader> WebRenderSync<L> for HomePage {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        html_sync! {
            <main class="page" data-page="builds">
                <h1>"Builds"</h1>
                <div class="empty">
                    <p>"No build data connected yet."</p>
                    <p class="slack">
                        "This experiment establishes the server and app shell. Builds will appear here when the event log is connected."
                    </p>
                </div>
            </main>
        }
        .render(cx)
    }
}

impl<L: DataLoader, B: WriteBuf> MdRenderSync<L, B> for HomePage {
    fn render_md(self, cx: &mut WebContext<L, B>) -> Result<(), WriteError> {
        md_sync! { r###"
            Builds

            No build data connected yet\.

            This experiment establishes the server and app shell\. Builds will appear here when the event log is connected\.


            "###
        }
        .render_md(cx)
    }
}

use axum::{http::HeaderMap, response::IntoResponse};
use proa_framework_axum::{explicit_markdown, negotiate, MarkdownAlternate, RouteResponse};

use crate::{error::AppError, layouts::RootDocument};

pub async fn handler(
    axum::Extension(viewer): axum::Extension<crate::auth::Viewer>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let html = RouteResponse::ssr(RootDocument {
        title: "Builds · Proa server",
        content: HomePage,
        viewer: Some(viewer),
    });
    Ok(negotiate(
        &headers,
        html,
        HomePage,
        MarkdownAlternate::new("/index.md"),
    )?)
}

pub async fn markdown() -> Result<impl IntoResponse, AppError> {
    Ok(explicit_markdown(HomePage)?)
}
