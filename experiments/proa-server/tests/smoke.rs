#[test]
fn generated_project_has_no_client_root() {
    let home = include_str!("../src/pages/home.rs");
    assert!(!home.contains("#[rsjs(component, client)]"));
    assert!(!home.contains("with_islands"));
}
