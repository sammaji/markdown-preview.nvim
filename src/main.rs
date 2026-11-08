mod cli;
mod editor;
mod logger;
mod opener;
mod server;

use std::io::IsTerminal;

fn main() {
    let command = match cli::parse(std::env::args().skip(1)) {
        Ok(command) => command,
        Err(err) => {
            eprintln!(
                "markdown-preview: {err}\nTry 'markdown-preview --help' for more information."
            );
            std::process::exit(2);
        }
    };
    match command {
        cli::Command::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            return;
        }
        cli::Command::Help => {
            print!("{}", cli::usage());
            return;
        }
        // run from a shell rather than by the editor
        cli::Command::Editor if std::io::stdin().is_terminal() => {
            print!("{}", cli::usage());
            return;
        }
        _ => {}
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
        match command {
            cli::Command::Preview(options) => cli::run(options).await,
            _ => {
                let (editor, incoming) = editor::Editor::attach();
                server::run(editor, incoming).await;
            }
        }
    });
}
