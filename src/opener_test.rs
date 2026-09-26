use serde_json::json;

use super::*;

const URL: &str = "http://localhost:8080/page/1?a=1&b=2";

fn programs(browser: &Browser, os: Os) -> Vec<String> {
    commands(URL, browser, os)
        .into_iter()
        .map(|(p, _)| p)
        .collect()
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

#[test]
fn browser_from_var() {
    assert_eq!(Browser::from_var(&json!(null)), Browser::Default);
    assert_eq!(Browser::from_var(&json!("")), Browser::Default);
    assert_eq!(Browser::from_var(&json!([])), Browser::Default);
    assert_eq!(Browser::from_var(&json!(0)), Browser::Default);
    // a string is one name, so "Google Chrome" keeps working on macOS
    assert_eq!(
        Browser::from_var(&json!("Google Chrome")),
        Browser::Name("Google Chrome".into())
    );
    assert_eq!(
        Browser::from_var(&json!(["firefox", "-P", "work"])),
        Browser::Command(strings(&["firefox", "-P", "work"]))
    );
}

#[test]
fn a_command_gets_its_arguments_and_the_url_on_every_os() {
    let browser = Browser::Command(strings(&["firefox", "-P", "work"]));
    for os in [Os::Windows, Os::Mac, Os::Wsl, Os::Unix] {
        assert_eq!(
            commands(URL, &browser, os),
            vec![("firefox".into(), strings(&["-P", "work", URL]))],
            "{os:?}"
        );
    }
}

#[test]
fn default_browser() {
    assert_eq!(
        commands(URL, &Browser::Default, Os::Unix),
        vec![("xdg-open".into(), strings(&[URL]))]
    );
    assert_eq!(
        commands(URL, &Browser::Default, Os::Mac),
        vec![("open".into(), strings(&[URL]))]
    );
    assert_eq!(
        commands(URL, &Browser::Default, Os::Windows),
        vec![(
            "cmd.exe".into(),
            strings(&[
                "/c",
                "start",
                "\"\"",
                "http://localhost:8080/page/1?a=1^&b=2"
            ])
        )]
    );
}

#[test]
fn named_browser() {
    let chrome = Browser::Name("Google Chrome".into());
    assert_eq!(
        commands(URL, &chrome, Os::Mac),
        vec![("open".into(), strings(&["-a", "Google Chrome", URL]))]
    );
    assert_eq!(
        commands(URL, &chrome, Os::Unix),
        vec![("Google Chrome".into(), strings(&[URL]))]
    );
    assert_eq!(commands(URL, &chrome, Os::Windows)[0].1[3], "Google Chrome");
}

#[test]
fn wsl_falls_back_through_the_openers() {
    assert_eq!(
        programs(&Browser::Default, Os::Wsl),
        strings(&["wslview", "cmd.exe", WSL_CMD, "xdg-open"])
    );
    // a Linux browser runs directly, a Windows one through cmd.exe
    let firefox = Browser::Name("firefox".into());
    assert_eq!(
        programs(&firefox, Os::Wsl),
        strings(&["firefox", "cmd.exe", WSL_CMD])
    );
    assert_eq!(commands(URL, &firefox, Os::Wsl)[1].1[3], "firefox");
}

#[test]
fn open_reports_every_command_it_tried() {
    let _ports = crate::server::tests::lock_ports();
    let missing = Browser::Command(strings(&["mkdp-no-such-browser"]));
    let err = open(URL, &missing).unwrap_err();
    assert!(err.contains("mkdp-no-such-browser"), "{err}");
    assert!(err.contains(URL), "{err}");
}
