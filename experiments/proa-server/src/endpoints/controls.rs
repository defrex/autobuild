//! Cookie-authenticated browser adapter for the shared native operator service.
use crate::{
    app::AppState,
    auth::Viewer,
    layouts::RootDocument,
    pages::{
        build::BuildPage,
        controls::ControlState,
        home::{link, HomePage},
    },
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Extension, Form,
};
use proa_core::{WebContext, WebRenderSync};
use proa_framework_axum::RouteResponse;
use proa_server::operator::{control::ControlService, error::OperatorError};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct ControlForm {
    csrf: String,
    project: String,
    #[serde(default)]
    slug: String,
    action: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    confirmed: String,
    #[serde(default)]
    run: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    ceiling: String,
}
fn textarea_value(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}
fn accepted(slug: &str, action: &str, reply: &Value) -> bool {
    if [
        "guidance",
        "retry",
        "dismiss",
        "review-round-ceiling",
        "revise-body",
        "revise-ticket",
    ]
    .contains(&action)
    {
        return reply["kind"] == "answered"
            && reply["slug"] == slug
            && reply["count"].is_number()
            && reply["resumed"].is_boolean()
            && ["guidance", "retry", "dismiss-finding", "revise-spec"]
                .iter()
                .any(|s| reply["resolution"] == *s);
    }
    let expected = if action == "cancel-pause" {
        "resume"
    } else {
        action
    };
    reply["kind"] == "command"
        && reply["slug"] == slug
        && reply["command"] == expected
        && reply["event"].is_object()
}
fn accepted_repository(action: &str, reply: &Value) -> bool {
    match action {
        "intake" => reply["enabled"].is_boolean() && reply["event"].is_object(),
        "pause-all" | "resume-all" => {
            reply["direction"]
                == if action == "pause-all" {
                    "pause"
                } else {
                    "resume"
                }
                && reply["slugs"]
                    .as_array()
                    .is_some_and(|a| a.iter().all(Value::is_string))
                && reply["paused"].is_boolean()
                && reply["intake"].is_boolean()
        }
        "harvest" => {
            ["pause", "resume"].iter().any(|s| reply["command"] == *s) && reply["event"].is_object()
        }
        "harvest-run" => {
            ["resume", "acknowledge"]
                .iter()
                .any(|s| reply["action"] == *s)
                && reply["event"].is_object()
        }
        _ => false,
    }
}
pub async fn submit(
    State(state): State<AppState>,
    Extension(viewer): Extension<Viewer>,
    headers: HeaderMap,
    Form(mut form): Form<ControlForm>,
) -> Response {
    if !super::auth::same_origin(&headers, &state) || form.csrf != viewer.csrf {
        return StatusCode::FORBIDDEN.into_response();
    }
    // HTML native form encoding uses CRLF while textarea.value (and the
    // enhanced FormData path) uses LF. Both transports must authorize the same
    // logical textarea bytes; the JSON operator API keeps its raw body bytes.
    form.text = textarea_value(&form.text);
    form.body = textarea_value(&form.body);
    let (Some(reader), Some(writer)) = (&state.data, &state.writer) else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Data store unavailable").into_response();
    };
    match writer.project_registered(&form.project).await {
        Ok(true) => {}
        Ok(false) => return (StatusCode::NOT_FOUND, "Project unavailable").into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    let service = ControlService {
        reader,
        writer,
        blobs: state.blobs.as_deref(),
    };
    let actor = json!({"kind":"human","user":viewer.email});
    let now = chrono::Utc::now();
    let mut ui = ControlState::signed_in(viewer.clone());
    ui.draft = form.text.clone();
    ui.revised_body = form.body.clone();
    ui.ceiling = form.ceiling.clone();
    let mut status = StatusCode::OK;
    let mut mutation = false;
    let result: Result<Option<Value>, OperatorError> = match form.action.as_str() {
        "confirm-abort" | "confirm-discard" => {
            ui.confirmation = form.action.trim_start_matches("confirm-").into();
            Ok(None)
        }
        "cancel" => {
            ui.draft.clear();
            Ok(None)
        }
        "abort" | "discard" if form.confirmed != "yes" => {
            Err(OperatorError::validation("explicit confirmation required"))
        }
        "pause" | "cancel-pause" | "resume" | "abort" | "discard" => {
            mutation = true;
            service
                .control(&form.project, &form.slug, &actor, &form.action, now)
                .await
                .map(Some)
        }
        "guidance"
        | "retry"
        | "dismiss"
        | "review-round-ceiling"
        | "revise-body"
        | "revise-ticket" => {
            mutation = true;
            let mut request = json!({"resolution":form.action});
            if form.action != "retry" {
                request["text"] = json!(form.text);
            }
            if form.action == "review-round-ceiling" {
                request["ceiling"] = form
                    .ceiling
                    .trim()
                    .parse::<u64>()
                    .map(Value::from)
                    .unwrap_or(Value::Null);
            }
            if form.action == "revise-body" || form.action == "revise-ticket" {
                request = json!({"resolution":"revise-spec", "origin": if form.action == "revise-ticket" {"ticket"} else {"body"}, "body":form.body});
            }
            match proa_server::operator::request_schema::parse(
                "answerRequestSchema",
                &serde_json::to_vec(&request).unwrap_or_default(),
            ) {
                Ok(request) => service
                    .answer(&form.project, &form.slug, &actor, &request, now)
                    .await
                    .map(Some),
                Err(error) => Err(error),
            }
        }
        "intake" => {
            mutation = true;
            service
                .setting(&form.project, &actor, None, now)
                .await
                .map(Some)
        }
        "pause-all" | "resume-all" => {
            mutation = true;
            service
                .bulk(
                    &form.project,
                    &actor,
                    if form.action == "pause-all" {
                        "pause"
                    } else {
                        "resume"
                    },
                    now,
                )
                .await
                .map(Some)
        }
        "harvest-run" => {
            mutation = true;
            service
                .harvest(&form.project, &actor, Some(&form.run), now)
                .await
                .map(Some)
        }
        "harvest" => {
            mutation = true;
            service
                .harvest(&form.project, &actor, None, now)
                .await
                .map(Some)
        }
        _ => Err(OperatorError::validation("unknown browser control")),
    };
    match result {
        Err(error) => {
            status =
                StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            ui.error = error.error;
            mutation = false;
        }
        Ok(Some(reply))
            if reply["kind"] == "answer-required"
                && reply["slug"] == form.slug
                && reply["escalationIds"]
                    .as_array()
                    .is_some_and(|a| a.iter().all(Value::is_string)) =>
        {
            ui.notice =
                "This build needs an answer. Supply guidance, retry, or dismiss the finding."
                    .into();
            mutation = false;
        }
        Ok(Some(reply)) if form.slug.is_empty() && !accepted_repository(&form.action, &reply) => {
            status = StatusCode::BAD_GATEWAY;
            ui.error = format!("Unexpected control reply: {reply}");
            mutation = false;
        }
        Ok(Some(reply)) if !form.slug.is_empty() && !accepted(&form.slug, &form.action, &reply) => {
            status = StatusCode::BAD_GATEWAY;
            ui.error = format!("Unexpected control reply: {reply}");
            mutation = false;
        }
        Ok(_) => {}
    }
    let fragment = headers.get("x-proa-fragment").is_some_and(|v| v == "1");
    if mutation && !fragment {
        return Redirect::to(&link(
            &form.project,
            if form.slug.is_empty() {
                None
            } else {
                Some(&form.slug)
            },
        ))
        .into_response();
    }
    if mutation {
        ui.draft.clear();
        ui.revised_body.clear();
        ui.notice = "Control recorded.".into();
    }
    if form.slug.is_empty() {
        let snapshot = crate::pages::home::load(state.clone(), Some(form.project.clone())).await;
        let projects = snapshot.projects.clone();
        let page = HomePage::new(snapshot).with_controls(ui);
        if fragment {
            return render_fragment(page, status);
        }
        let mut response = RouteResponse::ssr(RootDocument {
            title: "Builds · Proa server",
            builds_href: link(&form.project, None),
            project: Some(form.project),
            projects,
            viewer: Some(viewer),
            content: page,
        })
        .into_response();
        *response.status_mut() = status;
        response
    } else {
        let value =
            match crate::pages::build::load_detail(reader.clone(), form.project.clone(), form.slug)
                .await
            {
                Ok(v) => v,
                Err(error) => return (StatusCode::NOT_FOUND, error.to_string()).into_response(),
            };
        let page = BuildPage::new(value).with_controls(ui);
        if fragment {
            return render_fragment(page, status);
        }
        let mut response = RouteResponse::ssr(RootDocument {
            title: "Build · Proa server",
            builds_href: link(&form.project, None),
            project: Some(form.project),
            projects: Vec::new(),
            viewer: Some(viewer),
            content: page,
        })
        .into_response();
        *response.status_mut() = status;
        response
    }
}
fn render_fragment(page: impl WebRenderSync<proa_core::NoLoader>, status: StatusCode) -> Response {
    let mut cx = WebContext::new();
    if page.render(&mut cx).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (
        status,
        [("content-type", "text/html; charset=utf-8")],
        cx.into_output().into_vec(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn textarea_line_endings_match_dom_values_without_trimming_body() {
        assert_eq!(
            textarea_value("  body\r\nline\rfinal\n  "),
            "  body\nline\nfinal\n  "
        );
        assert_eq!(
            textarea_value("\u{feff} body </textarea>"),
            "\u{feff} body </textarea>"
        );
    }
    #[test]
    fn receipt_is_specific_and_answer_required_is_not_recorded_success() {
        let receipt = json!({"kind":"command","slug":"build","command":"resume","event":{}});
        assert!(accepted("build", "cancel-pause", &receipt));
        assert!(!accepted("build", "pause", &receipt));
        assert!(!accepted("other", "resume", &receipt));
        assert!(!accepted(
            "build",
            "resume",
            &json!({"kind":"answer-required","slug":"build","escalationIds":[]})
        ));
    }
}
