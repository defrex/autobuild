use proa_core::{DataLoader, WebContext, WebRenderSync, WriteError};
use proa_macros::html_sync;

pub struct Shell<C> {
    pub content: C,
    pub viewer: Option<crate::auth::Viewer>,
}

impl<L: DataLoader, C: WebRenderSync<L>> WebRenderSync<L> for Shell<C> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        html_sync! {
            <div class="frame" data-shell="ansi">
                <header class="mast">
                    <span class="word">"Autobuild"</span>
                    {if self.viewer.is_some() { Some(html_sync! {
                    <span class="project">"proa/server"</span>
                    <span class="spacer"></span>
                    <div class="menu">
                        <button
                            type="button"
                            class="ctl"
                            id="account-trigger"
                            aria-expanded="false"
                            aria-controls="account-panel"
                        >
                            {self.viewer.as_ref().unwrap().email.as_str()}
                        </button>
                        <nav class="menu-panel" id="account-panel" aria-label="Account" hidden>
                            <div class="label">{self.viewer.as_ref().unwrap().email.as_str()}</div>
                            <a href="/" aria-current="page">"Builds"</a>
                            <div class="sep"></div>
                            <div class="label" id="theme-label">"Theme"</div>
                            <div class="seg" role="group" aria-labelledby="theme-label">
                                <button
                                    type="button"
                                    class="ctl slack"
                                    data-choice="system"
                                    aria-pressed="true"
                                >
                                    "System"
                                </button>
                                <button
                                    type="button"
                                    class="ctl slack"
                                    data-choice="light"
                                    aria-pressed="false"
                                >
                                    "Light"
                                </button>
                                <button
                                    type="button"
                                    class="ctl slack"
                                    data-choice="dark"
                                    aria-pressed="false"
                                >
                                    "Dark"
                                </button>
                            </div>
                            <div class="sep"></div>
                            <form class="row" method="post" action="/auth/sign-out" data-sign-out>
                                <input type="hidden" name="csrf" value={self.viewer.as_ref().unwrap().csrf.as_str()} />
                                <button class="ctl" type="submit">"Sign out"</button>
                            </form>
                        </nav>
                    </div>
                    }) } else { None }}
                </header>
                {self.content}
            </div>
        }
        .render(cx)
    }
}
