use super::*;

fn args(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| a.to_string()).collect()
}

fn preview(list: &[&str]) -> Options {
    match parse(args(list)) {
        Ok(Command::Preview(options)) => options,
        other => panic!("expected a preview, got {other:?}"),
    }
}

fn this_file() -> PathBuf {
    Path::new(file!()).canonicalize().unwrap()
}

#[test]
fn no_arguments_talk_to_the_editor() {
    assert_eq!(parse(args(&[])), Ok(Command::Editor));
    // older plugin scripts start the server with `--path <app/server.js>`
    assert_eq!(
        parse(args(&["--path", "app/server.js"])),
        Ok(Command::Editor)
    );
}

#[test]
fn help_and_version() {
    assert_eq!(parse(args(&["--help"])), Ok(Command::Help));
    assert_eq!(parse(args(&["-h"])), Ok(Command::Help));
    assert_eq!(parse(args(&["--version"])), Ok(Command::Version));
    assert_eq!(parse(args(&["-V"])), Ok(Command::Version));
}

#[test]
fn files_are_canonical() {
    let options = preview(&[file!()]);
    assert_eq!(options.files, vec![this_file()]);
    assert_eq!(options.vars, default_vars());
}

#[test]
fn missing_files_and_directories_are_errors() {
    assert!(parse(args(&["no-such-file.md"])).is_err());
    assert!(parse(args(&["src"])).unwrap_err().contains("not a file"));
    assert!(parse(args(&["--theme", "dark"]))
        .unwrap_err()
        .contains("no file"));
}

#[test]
fn options_set_their_variables() {
    let options = preview(&[
        "--port",
        "9000",
        "--open-to-the-world",
        "--open-ip=10.0.0.2",
        "--browser",
        "firefox",
        "--theme",
        "dark",
        "--page-title",
        "${name} preview",
        "--markdown-css",
        file!(),
        file!(),
    ]);
    let var = |name: &str| options.vars[name].clone();
    assert_eq!(var("port"), json!(9000));
    assert_eq!(var("open_to_the_world"), json!(1));
    assert_eq!(var("open_ip"), json!("10.0.0.2"));
    assert_eq!(var("browser"), json!("firefox"));
    assert_eq!(var("theme"), json!("dark"));
    assert_eq!(var("page_title"), json!("${name} preview"));
    assert_eq!(var("markdown_css"), json!(this_file().to_string_lossy()));
}

#[test]
fn invalid_values_are_errors() {
    assert!(parse(args(&["--port", "0", file!()])).is_err());
    assert!(parse(args(&["--port", "http", file!()])).is_err());
    assert!(parse(args(&["--theme", "blue", file!()])).is_err());
    assert!(parse(args(&["--port"]))
        .unwrap_err()
        .contains("needs a value"));
    assert!(parse(args(&["--preview-options", "[]", file!()])).is_err());
    assert!(parse(args(&["--frobnicate", file!()])).is_err());
}

#[test]
fn preview_options_are_merged_into_the_defaults() {
    let options = preview(&[
        "--preview-options",
        r#"{"disable_sync_scroll": 1, "toc": {"listType": "ol"}}"#,
        file!(),
    ]);
    let preview_options = &options.vars["preview_options"];
    assert_eq!(preview_options["disable_sync_scroll"], json!(1));
    assert_eq!(preview_options["toc"], json!({"listType": "ol"}));
    assert_eq!(preview_options["sync_scroll_type"], json!("middle"));
}

#[test]
fn files_after_double_dash_may_look_like_options() {
    let dir = std::env::temp_dir().join(format!("mkdp-cli-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("--theme.md");
    std::fs::write(&file, "# x").unwrap();
    let options = preview(&["--", file.to_str().unwrap()]);
    assert_eq!(options.files, vec![file.canonicalize().unwrap()]);
    std::fs::remove_dir_all(dir).unwrap();
}

fn state(files: Vec<PathBuf>) -> (State, mpsc::UnboundedReceiver<Incoming>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let state = State {
        vars: Mutex::new(default_vars()),
        files,
        cwd: "/work".into(),
        incoming: tx,
    };
    (state, rx)
}

fn call(state: &State, func: &str, args: Value) -> Result<Value, String> {
    state.handle("nvim_call_function", vec![func.into(), args])
}

#[test]
fn variables_are_read_and_written_with_their_prefix() {
    let (state, _rx) = state(vec![]);
    let get = |name: &str| state.handle("nvim_get_var", vec![name.into()]).unwrap();
    assert_eq!(get("mkdp_page_title"), json!("「${name}」"));
    assert_eq!(get("mkdp_undefined"), Value::Null);
    state
        .handle("nvim_set_var", vec!["mkdp_clients_active".into(), 1.into()])
        .unwrap();
    assert_eq!(get("mkdp_clients_active"), json!(1));
}

#[test]
fn files_are_buffers_from_one() {
    let (state, _rx) = state(vec![this_file()]);
    let path = this_file().to_string_lossy().into_owned();
    assert_eq!(call(&state, "getcwd", json!([])), Ok(json!("/work")));
    assert_eq!(
        call(&state, "mkdp#util#buffers", json!([])),
        Ok(json!([[1, path]]))
    );
    assert_eq!(call(&state, "bufexists", json!([1])), Ok(json!(1)));
    assert_eq!(call(&state, "bufexists", json!([0])), Ok(json!(0)));
    assert_eq!(call(&state, "bufexists", json!([2])), Ok(json!(0)));
    let dir = this_file().parent().unwrap().to_string_lossy().into_owned();
    assert_eq!(call(&state, "expand", json!(["#1:p:h"])), Ok(json!(dir)));
    assert_eq!(call(&state, "expand", json!(["#2:p:h"])), Ok(json!("")));
}

#[test]
fn preview_data_reads_the_file() {
    let (state, _rx) = state(vec![this_file()]);
    let data = call(&state, "mkdp#util#preview_data", json!([1])).unwrap();
    let text = std::fs::read_to_string(this_file()).unwrap();
    assert_eq!(data["content"], json!(text.lines().collect::<Vec<_>>()));
    assert_eq!(data["name"], json!(this_file().to_string_lossy()));
    assert_eq!(data["isActive"], json!(0));
    assert_eq!(data["pageTitle"], json!("「${name}」"));
    assert_eq!(data["options"]["sync_scroll_type"], json!("middle"));
    assert_eq!(
        call(&state, "mkdp#util#preview_data", json!([2])),
        Ok(Value::Null)
    );

    let other = call(&state, "mkdp#util#file_preview_data", json!([file!()])).unwrap();
    assert_eq!(other["content"], data["content"]);
    let missing = call(&state, "mkdp#util#file_preview_data", json!(["nope.md"]));
    assert_eq!(missing, Ok(Value::Null));
}

#[test]
fn open_browser_opens_every_file() {
    let (state, mut rx) = state(vec![this_file(), this_file()]);
    call(&state, "mkdp#util#open_browser", json!([])).unwrap();
    for bufnr in [1, 2] {
        match rx.try_recv() {
            Ok(Incoming::Notification { method, args }) => {
                assert_eq!(method, "open_browser");
                assert_eq!(args, json!([{ "bufnr": bufnr }]));
            }
            _ => panic!("expected an open_browser notification"),
        }
    }
    assert!(rx.try_recv().is_err());
}

#[test]
fn editor_only_requests_are_errors() {
    let (state, _rx) = state(vec![]);
    assert!(state.handle("nvim_get_api_info", vec![]).is_err());
    assert!(call(&state, "line", json!(["."])).is_err());
    assert_eq!(
        call(&state, NO_BROWSER, json!(["http://x"])),
        Ok(Value::Null)
    );
}
