mod editor;
mod logger;
mod opener;
mod server;

fn main() {
    // older plugin scripts pass `--path <app/server.js>`, which is ignored
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }

    logger::init();
    std::panic::set_hook(Box::new(|panic| {
        error!("panic", "{panic}");
    }));

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to start tokio runtime");
    runtime.block_on(async {
        let (editor, incoming) = editor::Editor::attach();
        server::run(editor, incoming).await;
    });
}
