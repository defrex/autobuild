use proa_core::{DataLoader, WebContext, WebRenderSync, WriteError};
use proa_macros::html_sync;

pub struct Shell<C> {
    pub project: Option<String>,
    pub projects: Vec<String>,
    pub builds_href: String,
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
                    {if self.projects.is_empty(){Some(html_sync!{<span class="project">{self.project.as_deref().unwrap_or_default().strip_prefix("https://github.com/").unwrap_or(self.project.as_deref().unwrap_or_default())}</span>})}else{None}}
                    {if self.projects.is_empty(){None}else{Some(html_sync!{
                        <form class="project-switch" method="get" action="/" data-project-switch>
                            <label class="sr-only" for="project">"Project"</label>
                            <select id="project" name="project">{ProjectOptions{projects:&self.projects,selected:self.project.as_deref()}}</select>
                            <button class="ctl" type="submit">"Switch project"</button>
                        </form>
                    })}}
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
                            <a href={self.builds_href.as_str()} aria-current="page">"Builds"</a>
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

struct ProjectOptions<'a> {
    projects: &'a [String],
    selected: Option<&'a str>,
}
impl<L: DataLoader> WebRenderSync<L> for ProjectOptions<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        for project in self.projects {
            html_sync! {
                <option
                    data-project-option
                    value={project.as_str()}
                    selected={self.selected==Some(project.as_str())}
                >
                    {project.strip_prefix("https://github.com/").unwrap_or(project)}
                </option>
            }
            .render(cx)?;
        }
        Ok(())
    }
}
