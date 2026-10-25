// proa:document-root
use crate::components::shell::Shell;
use proa_core::{raw_text_ok, DataLoader, WebContext, WebRenderSync, WriteError};
use proa_macros::html_sync;

pub struct RootDocument<C> {
    pub title: &'static str,
    pub viewer: Option<crate::auth::Viewer>,
    pub content: C,
}

impl<L: DataLoader, C: WebRenderSync<L>> WebRenderSync<L> for RootDocument<C> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        html_sync! {
            <!DOCTYPE html>
            <html lang="en">
                <head>
                    <meta charset="utf-8" />
                    <meta name="viewport" content="width=device-width, initial-scale=1" />
                    <meta name="color-scheme" content="light dark" />
                    <title>{raw_text_ok(self.title)}</title>
                    <script src="/static/theme-init.js"></script>
                    <link rel="stylesheet" href="/static/styles.css" />
                    <script src="/static/shell.js" defer></script>
                </head>
                <body>{Shell { content: self.content, viewer: self.viewer }}</body>
            </html>
        }
        .render(cx)
    }
}
