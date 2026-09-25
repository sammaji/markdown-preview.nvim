use super::*;

#[test]
#[cfg(unix)]
fn default_log_file_is_per_user() {
    let path = default_path();
    assert_eq!(path.parent(), Some(std::env::temp_dir().as_path()));
    // SAFETY: see default_path
    let uid = unsafe { libc::getuid() };
    assert_eq!(
        path.file_name().unwrap().to_string_lossy(),
        format!("mkdp-nvim-{uid}.log")
    );
}

#[test]
fn timestamp_is_utc_date_and_time() {
    let ts = timestamp();
    assert_eq!(ts.len(), "2026-09-26 12:00:00".len(), "{ts}");
    assert!(ts.starts_with("20"), "{ts}");
}

#[test]
fn suffix_goes_before_the_extension() {
    assert_eq!(
        with_suffix(Path::new("/tmp/mkdp-nvim-501.log"), "1"),
        PathBuf::from("/tmp/mkdp-nvim-501.1.log")
    );
    assert_eq!(
        with_suffix(Path::new("/tmp/mkdp"), "1"),
        PathBuf::from("/tmp/mkdp.1")
    );
}

#[test]
fn debug_log_is_per_session() {
    let path = debug_path();
    let default = default_path();
    assert_eq!(path.parent(), default.parent());
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    let stem = default.file_stem().unwrap().to_string_lossy().into_owned();
    // <stem>.debug-YYYYMMDD-HHMMSS-<pid>.log
    let pid = std::process::id();
    let time = name
        .strip_prefix(&format!("{stem}.debug-"))
        .and_then(|rest| rest.strip_suffix(&format!("-{pid}.log")))
        .unwrap_or_else(|| panic!("{name}"));
    assert_eq!(time.len(), "20260926-120000".len(), "{name}");
    assert!(
        time.chars().all(|c| c.is_ascii_digit() || c == '-'),
        "{name}"
    );
}

/// A fresh directory with `mkdp.log` and `mkdp.1.log` paths in it.
fn log_pair(name: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("mkdp-logger-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    (dir.join("mkdp.log"), dir.join("mkdp.1.log"))
}

/// Writes `size` bytes to `path`, modified `age` seconds ago.
fn write_log(path: &Path, size: u64, age: u64) {
    let file = File::create(path).unwrap();
    file.set_len(size).unwrap();
    let time = SystemTime::now() - std::time::Duration::from_secs(age);
    file.set_modified(time).unwrap();
}

#[test]
fn log_starts_in_the_first_file() {
    let (first, _) = log_pair("empty");
    assert_eq!(active_file(&first), first);
}

#[test]
fn log_stays_in_a_file_under_the_limit() {
    let (first, second) = log_pair("under");
    write_log(&first, MAX_LOG_SIZE, 0);
    assert_eq!(active_file(&first), first);

    write_log(&first, MAX_LOG_SIZE + 1, 60);
    write_log(&second, 10, 0);
    assert_eq!(active_file(&first), second);
    assert_eq!(fs::metadata(&second).unwrap().len(), 10);
}

#[test]
fn full_log_moves_to_the_other_file_and_empties_it() {
    let (first, second) = log_pair("full");
    write_log(&second, 10, 60);
    write_log(&first, MAX_LOG_SIZE + 1, 0);
    assert_eq!(active_file(&first), second);
    assert_eq!(fs::metadata(&second).unwrap().len(), 0);
    assert_eq!(fs::metadata(&first).unwrap().len(), MAX_LOG_SIZE + 1);

    // and back again once the second one fills up
    write_log(&first, MAX_LOG_SIZE + 1, 60);
    write_log(&second, MAX_LOG_SIZE + 1, 0);
    assert_eq!(active_file(&first), first);
    assert_eq!(fs::metadata(&first).unwrap().len(), 0);
}
