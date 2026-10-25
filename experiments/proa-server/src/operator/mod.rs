//! Native operator service. Authentication is independent of browser admission.
pub mod answer;
pub mod auth;
pub mod control;
pub mod error;
pub mod http;
pub mod protocol;
pub mod requests;
pub mod sessions;
pub mod tickets;

pub mod query;
pub mod ticket_http;

pub mod request_schema;
pub mod ticket_target;

pub mod delegation;
