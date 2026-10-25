//! Display-safe Unicode geometry shared by the two renderers.
use icu_collator::{Collator, CollatorBorrowed};
use std::{cmp::Ordering, sync::OnceLock};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;
pub fn display_text(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)) {
                format!("\\u{{{:x}}}", c as u32)
            } else {
                c.to_string()
            }
        })
        .collect()
}
pub fn cell_width(value: &str) -> usize {
    value.graphemes(true).map(UnicodeWidthStr::width).sum()
}
pub fn split_cells(value: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![];
    }
    let mut rows = Vec::new();
    let mut row = String::new();
    let mut used = 0;
    for cluster in value.graphemes(true) {
        let cells = UnicodeWidthStr::width(cluster);
        if cells > width {
            continue;
        }
        if cells > 0 && used + cells > width {
            rows.push(std::mem::take(&mut row));
            used = 0;
        }
        row.push_str(cluster);
        used += cells;
    }
    if !row.is_empty() || rows.is_empty() {
        rows.push(row);
    }
    rows
}
pub fn compare(a: &str, b: &str) -> Ordering {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            Collator::try_new(Default::default(), Default::default())
                .expect("compiled Unicode collation data")
        })
        .compare(a, b)
}
