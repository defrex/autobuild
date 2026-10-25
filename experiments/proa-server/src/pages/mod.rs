pub mod build;
pub mod controls;
pub mod home;
pub mod sign_in;
pub fn duration(ms: i64) -> String {
    let seconds = ms.max(0) / 1000;
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        format!("{}m{:02}s", seconds / 60, seconds % 60)
    } else {
        format!(
            "{}h{:02}m{:02}s",
            seconds / 3600,
            (seconds / 60) % 60,
            seconds % 60
        )
    }
}

pub mod connect;
