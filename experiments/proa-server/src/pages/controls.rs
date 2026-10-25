//! Server-rendered controls. The same forms are submitted with or without JavaScript.
use crate::auth::Viewer;
use proa_core::{DataLoader, WebContext, WebRenderSync, WriteError};
use proa_macros::html_sync;

#[derive(Clone, Default)]
pub struct ControlState {
    pub viewer: Option<Viewer>,
    pub error: String,
    pub notice: String,
    pub draft: String,
    pub revised_body: String,
    pub ceiling: String,
    pub confirmation: String,
}
impl ControlState {
    pub fn signed_in(viewer: Viewer) -> Self {
        Self {
            viewer: Some(viewer),
            ..Self::default()
        }
    }
}
pub struct Fields<'a> {
    pub csrf: &'a str,
    pub project: &'a str,
    pub slug: &'a str,
}
impl<L: DataLoader> WebRenderSync<L> for Fields<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        html_sync! {
            <input data-control-field="csrf" type="hidden" name="csrf" value={self.csrf} />
            <input data-control-field="project" type="hidden" name="project" value={self.project} />
            <input data-control-field="slug" type="hidden" name="slug" value={self.slug} />
        }
        .render(cx)
    }
}
pub struct Feedback<'a>(pub &'a ControlState);
impl<L: DataLoader> WebRenderSync<L> for Feedback<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        if !self.0.error.is_empty() {
            html_sync! {
                <p class="control-error red" role="alert" data-control-error>
                    {self.0.error.as_str()}
                </p>
            }
            .render(cx)?;
        }
        if !self.0.notice.is_empty() {
            html_sync! {
                <p role="status" data-control-notice>{self.0.notice.as_str()}</p>
            }
            .render(cx)?;
        }
        Ok(())
    }
}
pub struct BuildControls<'a> {
    pub state: &'a ControlState,
    pub project: &'a str,
    pub slug: &'a str,
    pub status: &'a str,
    pub node: bool,
    pub answer: bool,
}
impl<L: DataLoader> WebRenderSync<L> for BuildControls<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        let Some(viewer) = &self.state.viewer else {
            return Ok(());
        };
        let fields = || Fields {
            csrf: &viewer.csrf,
            project: self.project,
            slug: self.slug,
        };
        let primary = match self.status {
            "running" => Some(("pause", "Pause")),
            "pausing" => Some(("cancel-pause", "Cancel pause")),
            "paused" | "blocked" => Some(("resume", "Resume")),
            _ => None,
        };
        let abort = [
            "queued",
            "running",
            "collecting",
            "pausing",
            "paused",
            "resuming",
            "blocked",
        ]
        .contains(&self.status);
        let discard = !self.node && self.status == "queued";
        html_sync! {
            <section data-build-controls>
                <h2>"Actions"</h2>
                {Feedback(self.state)}
                {if self.state.confirmation.is_empty() { Some(html_sync! {
                    <form method="post" action="/controls" data-control-form="lifecycle" class="action-words">
                        {fields()}
                        {primary.map(ActionWord)}
                        {if abort {Some(html_sync!{<button class="ctl danger" type="submit" name="action" value="confirm-abort">"Abort"</button>})}else{None}}
                        {if discard {Some(html_sync!{<button class="ctl danger" type="submit" name="action" value="confirm-discard">"Discard"</button>})}else{None}}
                    </form>
                }) } else { Some(html_sync! {
                    <form method="post" action="/controls" data-control-form="confirmation" class="confirmation">
                        {fields()}
                        <input type="hidden" name="confirmed" value="yes"/>
                        <p class="red">"! Confirm "{self.state.confirmation.as_str()}" for "<span class="m">{self.slug}</span>"?"</p>
                        <div class="action-words">
                            <button class="btn danger" type="submit" name="action" value={self.state.confirmation.as_str()}>"Confirm "{self.state.confirmation.as_str()}</button>
                            <button class="ctl" type="submit" name="action" value="cancel">"Cancel"</button>
                        </div>
                    </form>
                })}}
                {if (self.answer || !self.state.draft.is_empty() || !self.state.revised_body.is_empty()) && self.state.confirmation.is_empty() {Some(html_sync! {
                    <form method="post" action="/controls" data-control-form="answer" class="answer-form">
                        {fields()}
                        <label for="answer-text">"Guidance"</label>
                        <textarea class="field" id="answer-text" name="text" rows="5">{proa_core::raw_text_ok(self.state.draft.as_str())}</textarea>
                        <div class="action-words">
                            <button class="btn" type="submit" name="action" value="guidance">"Send guidance"</button>
                            <button class="ctl" type="submit" name="action" value="retry">"Retry"</button>
                            <button class="ctl" type="submit" name="action" value="dismiss">"Dismiss finding"</button>
                        </div>
                        <fieldset data-answer-options>
                            <legend>"More answer options"</legend>
                            <div class="answer-options">
                                <label for="answer-ceiling">"Review round ceiling"</label>
                                <input class="field" id="answer-ceiling" name="ceiling" inputmode="numeric" value={self.state.ceiling.as_str()}/>
                                <button class="ctl" type="submit" name="action" value="review-round-ceiling">"Set review ceiling"</button>
                                <label for="answer-body">"Revised spec body"</label>
                                <textarea class="field" id="answer-body" name="body" rows="8">{proa_core::raw_text_ok(self.state.revised_body.as_str())}</textarea>
                                <div class="action-words">
                                    <button class="ctl" type="submit" name="action" value="revise-body">"Supply revised spec"</button>
                                    <button class="ctl" type="submit" name="action" value="revise-ticket">"Use amended ticket body"</button>
                                </div>
                            </div>
                        </fieldset>
                    </form>
                })}else{None}}
                <p class="slack control-signoff">"Signed in as "{viewer.email.as_str()}</p>
            </section>
        }.render(cx)
    }
}
pub struct RepositoryControls<'a> {
    pub state: &'a ControlState,
    pub project: &'a str,
    pub intake: bool,
    pub harvest: bool,
    pub harvest_state: &'a serde_json::Value,
    pub dismissed_through: i64,
    pub pause: bool,
    pub resume: bool,
}
impl<L: DataLoader> WebRenderSync<L> for RepositoryControls<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        let Some(viewer) = &self.state.viewer else {
            return Ok(());
        };
        let runs = self.harvest_state["runs"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let selected = runs.iter().find(|run| {
            (run["status"] == "failed"
                && run["recoveryExhaustion"]["attentionAcknowledgedSeq"].is_null())
                || (run["status"] == "escalated"
                    && run["terminalSeq"]
                        .as_i64()
                        .is_none_or(|seq| self.dismissed_through <= seq))
        });
        let run_action = selected.filter(|_| {
            self.harvest
                && !self.harvest_state["pendingCommands"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|p| p["command"] == "resume"))
        });
        html_sync! {
            <div data-repository-controls>
                {Feedback(self.state)}
                <form
                    method="post"
                    action="/controls"
                    data-control-form="repository"
                    class="control-line action-words"
                >
                    {Fields{csrf:&viewer.csrf,project:self.project,slug:""}}
                    <button type="submit" class="ctl" name="action" value="intake">
                        "Intake "
                        {if self.intake {"ON"} else {"OFF"}}
                    </button>
                    <button type="submit" class="ctl" name="action" value="harvest">
                        "Harvest "
                        {if self.harvest {"ON"} else {"OFF"}}
                    </button>
                    {if self.pause {Some(html_sync! {
                        <button type="submit" class="ctl" name="action" value="pause-all">"Pause all"</button>
                    })}else{None}}
                    {if self.resume {Some(html_sync! {
                        <button type="submit" class="ctl" name="action" value="resume-all">"Resume all"</button>
                    })}else{None}}
                </form>
                {run_action.map(|run| HarvestRun { project:self.project, csrf:&viewer.csrf, run })}
            </div>
        }.render(cx)
    }
}

struct ActionWord((&'static str, &'static str));
impl<L: DataLoader> WebRenderSync<L> for ActionWord {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        html_sync! {
            <button data-action-word class="ctl" type="submit" name="action" value={self.0.0}>
                {self.0.1}
            </button>
        }
        .render(cx)
    }
}

struct HarvestRun<'a> {
    project: &'a str,
    csrf: &'a str,
    run: &'a serde_json::Value,
}
impl<L: DataLoader> WebRenderSync<L> for HarvestRun<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        let run = self.run["run"].as_str().unwrap_or_default();
        let label = if self.run["status"] == "failed" && self.run["recoveryExhaustion"].is_null() {
            "Resume harvest"
        } else {
            "Acknowledge harvest"
        };
        html_sync! {
            <form data-harvest-run method="post" action="/controls" data-control-form="harvest-run">
                {Fields{csrf:self.csrf,project:self.project,slug:""}}
                <input type="hidden" name="run" value={run} />
                <button class="ctl" type="submit" name="action" value="harvest-run">{label}</button>
            </form>
        }
        .render(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn render(state: &ControlState, status: &str, answer: bool) -> String {
        let mut cx = WebContext::new();
        BuildControls {
            state,
            project: "repo",
            slug: "build",
            status,
            node: false,
            answer,
        }
        .render(&mut cx)
        .unwrap();
        String::from_utf8(cx.into_output().into_vec()).unwrap()
    }
    fn viewer() -> ControlState {
        ControlState::signed_in(Viewer {
            email: "operator@example.com".into(),
            csrf: "csrf-token".into(),
        })
    }
    #[test]
    fn destructive_action_requires_a_second_form_and_never_offers_landing() {
        let mut state = viewer();
        let first = render(&state, "queued", false);
        assert!(
            first.contains("value=\"confirm-abort\"")
                && first.contains("value=\"confirm-discard\"")
        );
        assert!(!first.contains("value=\"abort\"") && !first.contains("name=\"confirmed\""));
        assert!(!first.contains("value=\"land\"") && !first.contains("value=\"hold\""));
        state.confirmation = "abort".into();
        let confirm = render(&state, "running", false);
        assert!(confirm.contains("value=\"abort\"") && confirm.contains("name=\"confirmed\""));
        assert!(confirm.contains("value=\"cancel\""));
    }
    #[test]
    fn refresh_markup_carries_session_csrf_and_escapes_refusal_and_draft() {
        let mut state = viewer();
        state.error = "already answered <script>".into();
        state.draft = "</textarea><script>".into();
        state.revised_body = "</textarea><script>revision</script>".into();
        let html = render(&state, "blocked", true);
        assert!(html.contains("csrf-token") && html.contains("operator@example.com"));
        assert!(html.contains("already answered &lt;script&gt;"));
        assert!(!html.contains("</textarea><script>"));
        assert!(html.contains("data-control-error") && html.contains("name=\"text\""));
        for action in ["review-round-ceiling", "revise-body", "revise-ticket"] {
            assert!(html.contains(&format!("value=\"{action}\"")));
        }
    }
}
