use super::{
    authorize_operation,
    grants::{self, Grant},
    normalize_repository,
};
use crate::protocol::{delegation::Principal, error::ProtocolError, router::MachineState, wire};
use axum::http::HeaderMap;
pub enum Authority {
    Ordinary(Principal),
    Grant(Grant),
}
impl Authority {
    pub async fn authenticate(
        state: &MachineState,
        headers: &HeaderMap,
        supplied: Option<Principal>,
    ) -> Result<Self, ProtocolError> {
        if let Some(p) = supplied {
            return Ok(Self::Ordinary(p));
        }
        let authorization = wire::header_text(headers, "authorization");
        if let Ok(token) = crate::protocol::auth::bearer_token(authorization.as_deref()) {
            if token.starts_with("abt_") {
                return Ok(Self::Grant(grants::authenticate(state, token).await?));
            }
        }
        crate::protocol::router::authenticate(state, authorization.as_deref())
            .await?
            .map(Self::Ordinary)
            .ok_or_else(|| ProtocolError::new(401, "auth", "missing bearer credential"))
    }
    pub fn repo(&self) -> Option<String> {
        match self {
            Self::Ordinary(p) => p.repo().and_then(|r| r.to_scalar().ok()),
            Self::Grant(g) => Some(g.repo.clone()),
        }
    }
    pub fn require_project(&self, repo: &str) -> Result<(), ProtocolError> {
        if self.repo().is_some_and(|r| r != repo) {
            Err(ProtocolError::new(403, "auth", "wrong project"))
        } else {
            Ok(())
        }
    }
    pub fn authorize(&self, operation: &str) -> Result<(), ProtocolError> {
        match self {
            Self::Ordinary(p) => authorize_operation(p, operation),
            Self::Grant(g) => {
                if super::READ_OPERATIONS.contains(&operation)
                    || (g.kind == "runner" && operation == "create")
                {
                    Ok(())
                } else {
                    Err(ProtocolError::new(
                        403,
                        "auth",
                        "ticket grant cannot perform this operation",
                    ))
                }
            }
        }
    }
    pub fn owner(&self) -> bool {
        matches!(
            self,
            Self::Ordinary(Principal::Project(_) | Principal::Admin { .. })
        )
    }
    pub fn delegated(&self) -> bool {
        matches!(
            self,
            Self::Grant(_) | Self::Ordinary(Principal::Delegated(_))
        )
    }
    pub fn selected_repo(&self, selected: Option<&str>) -> Result<String, ProtocolError> {
        if let Some(r) = selected {
            return normalize_repository(r).ok_or_else(|| {
                ProtocolError::validation("context.repo must name a normalized repository origin")
            });
        }
        self.repo().ok_or_else(|| {
            ProtocolError::new(
                403,
                "auth",
                "owner ticket requests require context.repo naming a registered project",
            )
        })
    }
    pub fn user(&self) -> String {
        match self {
            Self::Ordinary(Principal::Project(p)) => p.user.clone(),
            Self::Ordinary(Principal::Admin { user }) => user.to_scalar().unwrap_or_default(),
            _ => "ticket-grant".into(),
        }
    }
}
