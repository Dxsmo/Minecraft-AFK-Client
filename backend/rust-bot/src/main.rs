use azalea::prelude::*;

#[tokio::main]
async fn main() -> AppExit {
    let account = match Account::microsoft("Desmodus187@gmail.com").await {
        Ok(a) => a,
        Err(e) => {
            eprintln!(">>> AUTH FAILED: {e}");
            std::process::exit(1);
        }
    };
    println!(">>> Auth complete, connecting to HugoSMP.net...");

    ClientBuilder::new()
        .set_handler(handle)
        .start(account, "HugoSMP.net")
        .await
}

#[derive(Default, Clone, Component)]
pub struct State {}

async fn handle(_bot: Client, event: Event, _state: State) -> eyre::Result<()> {
    match &event {
        Event::Chat(m) => println!(">>> CHAT: {}", m.message().to_ansi()),
        other => {
            let s = format!("{other:?}");
            if !s.starts_with("Tick") && !s.starts_with("Packet") {
                println!(">>> EVENT: {s}");
            }
        }
    }
    Ok(())
}
